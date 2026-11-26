import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HatKey } from '../lib/hatFunctions';
import type { PreviewHatKey } from '../data/preview';

// Offline execution of the real switcher. Native animation/rendering boundaries
// are replaced; this does not establish an iOS accessibility-tree observation.
const host = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, mode: 'sample' as 'sample' | 'preview' | 'live', compact: false,
  activeHat: 'steward' as HatKey, os: 'ios' as 'ios' | 'android', fontScale: 1,
  switchSampleHat: vi.fn<(key: HatKey) => Promise<void>>(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof React>(),
  useState: <T,>(initial: T) => {
    const index = host.cursor++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index] as T, (next: T | ((value: T) => T)) => {
      host.slots[index] = typeof next === 'function' ? (next as (value: T) => T)(host.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = host.cursor++;
    if (!(index in host.slots)) host.slots[index] = { current: initial };
    return host.slots[index] as { current: T };
  },
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
}));
vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    setValue(value: number) { this.value = value; }
    interpolate() { return 0; }
    stopAnimation() {}
  }
  return {
    Animated: { Value, View: 'Animated.View', subtract: () => 0, multiply: () => 0 },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Easing: {}, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Platform: { get OS() { return host.os; } },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: host.fontScale }),
  };
});
vi.mock('expo-router', () => ({ usePathname: () => host.compact ? '/account' : '/home' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../lib/chrome', () => ({
  FLOATING_CONTROL_HIT_WIDTH: 48, FLOATING_CONTROL_LIFT: 8, FLOATING_CONTROL_SIZE: 48, HAT_MENU_ROW_HEIGHT: 64,
  HAT_MENU_WIDTH: 320, PILL_SHEEN_CYCLE_MS: 4000, homeDrawerReveal: 0, homeScrollOffset: { interpolate: () => 1 },
  floatingControlHitHeight: () => 48, floatingControlTop: () => 59,
  hatMenuBottomInset: () => 34, hatMenuMaxHeight: () => 600, hatMenuTop: () => 115,
  hatPillPlacementForPath: () => host.compact ? 'pinned-trailing' : 'centred',
  useDockSuppressed: () => false, useHomeAwayFromTop: () => false,
}));
vi.mock('../lib/hatSwitcher', () => ({ useHatSwitcherRequests: () => 0 }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/reduceTransparency', () => ({ useReduceTransparency: () => true }));
vi.mock('../services/haptics', () => ({ haptics: { select: () => undefined } }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    mode: host.mode, previewHat: host.mode === 'preview' ? 'steward' : null,
    sampleHat: host.mode === 'sample' ? host.activeHat : null,
    switchPreviewHat: () => undefined, switchSampleHat: host.switchSampleHat,
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('./ShineBorder', () => ({ ShineBorder: 'ShineBorder' }));
vi.mock('./TopChrome', () => ({ FrostedCapsule: 'FrostedCapsule' }));
vi.mock('./ui', () => ({ Body: 'Body' }));
vi.mock('./Text', () => ({ Text: 'Text', TextInput: 'TextInput' })); // the app's Text, as the react-native stand-in draws it (#8928)

const { HatSwitcher } = await import('./HatSwitcher');
const { SAMPLE_HATS } = await import('../services/sampleSession');
type Element = React.ReactElement<{
  ref?: { current: unknown }; contentContainerStyle?: { paddingBottom: number };
  onLayout?: (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onScroll?: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
  children?: React.ReactNode; accessible?: boolean; accessibilityRole?: string;
  accessibilityLabel?: string; accessibilityHint?: string;
  accessibilityState?: { expanded?: boolean; selected?: boolean; disabled?: boolean };
  disabled?: boolean; accessibilityViewIsModal?: boolean; onPress?: () => void; onAccessibilityTap?: () => void;
  adjustsFontSizeToFit?: boolean; maxFontSizeMultiplier?: number; minimumFontScale?: number; numberOfLines?: number;
}>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  host.cursor = 0;
  return elements(HatSwitcher({}));
}
function labelled(tree: Element[], label: string) {
  const element = tree.find(node => node.props.accessibilityLabel === label);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
beforeEach(() => {
  host.slots = []; host.cursor = 0; host.mode = 'sample'; host.compact = false;
  host.activeHat = 'steward'; host.os = 'ios'; host.fontScale = 1;
  host.switchSampleHat.mockReset().mockImplementation(async (key) => { host.activeHat = key; });
  vi.stubGlobal('React', React);
});

describe('role menu opening with measured rows', () => {
  // Text-size effects enter through native row measurements, not estimated
  // font metrics. The opening algorithm must handle either measured layout.
  const cases = [
    // Seven roles in this edition's demo roster (Organizer second).
    { size: 'default', heights: [64, 70, 82, 64, 100, 70, 64], viewport: 350 },
    { size: 'largest', heights: [88, 120, 132, 96, 164, 128, 104], viewport: 274 },
  ];
  for (const scenario of cases) {
    it.each(SAMPLE_HATS)(`opens $label on a row boundary at ${scenario.size} text`, (hat) => {
      host.activeHat = hat.key;
      labelled(render(), `Demo, switch role, ${hat.label}`).props.onPress!();
      let opened = render();
      const list = opened.find(node => node.type === 'ScrollView')!;
      const scrollTo = vi.fn<(options: { y: number; animated: boolean }) => void>();
      list.props.ref!.current = { scrollTo, flashScrollIndicators: vi.fn() };
      const content = scenario.heights.reduce((sum, height) => sum + height, 0);
      list.props.onLayout!({ nativeEvent: { layout: { y: 0, height: scenario.viewport } } });
      list.props.onContentSizeChange!(320, content);
      let top = 0;
      const tops = scenario.heights.map((height) => {
        const y = top;
        top += height;
        return y;
      });
      // Native measurements can arrive with the selected last role first.
      const order = scenario.size === 'largest' ? [6, 3, 0, 5, 1, 4, 2] : [0, 1, 2, 3, 4, 5, 6];
      for (const index of order) {
        labelled(opened, SAMPLE_HATS[index]!.label).props.onLayout!({ nativeEvent: { layout: { y: tops[index]!, height: scenario.heights[index]! } } });
      }
      opened = render();
      const padding = opened.find(node => node.type === 'ScrollView')!.props.contentContainerStyle?.paddingBottom ?? 0;
      if (padding > 0) expect(scrollTo, 'wait for native trailing-space layout').not.toHaveBeenCalled();
      list.props.onContentSizeChange!(320, content + padding);
      const offset = scrollTo.mock.lastCall?.[0].y ?? 0;
      expect(tops, 'opening must not cut the first visible role').toContain(offset);
      const index = SAMPLE_HATS.findIndex(item => item.key === hat.key);
      expect(offset).toBeLessThanOrEqual(tops[index]!);
      expect(tops[index]! + scenario.heights[index]!).toBeLessThanOrEqual(offset + scenario.viewport);
      expect(offset).toBeLessThanOrEqual(content + padding - scenario.viewport);
      if (hat.key === 'vp') expect(offset).toBe(scenario.size === 'largest' ? 600 : 216);
      // Scrolling still updates both hidden-role cues independently.
      list.props.onScroll!({ nativeEvent: { contentOffset: { y: 0 } } });
      expect(render().some(node => node.props.children === 'More above')).toBe(false);
      expect(render().some(node => typeof node.type === 'function' && node.type.name === 'FoldHint')).toBe(true);
      list.props.onScroll!({ nativeEvent: { contentOffset: { y: content + padding - scenario.viewport } } });
      expect(render().some(node => node.props.children === 'More above')).toBe(true);
      expect(render().some(node => typeof node.type === 'function' && node.type.name === 'FoldHint')).toBe(false);
    });
  }
});
afterEach(() => vi.unstubAllGlobals());

// UB-UG-NATIVE-DEMO-ENTRY-RESTORED-20261107: a live SAMPLE persona
// session carries the hat switcher again, over every role the server mints.
// Removing the native accessibility activation or exposing the decoration
// instead of the button breaks these cases, even while touch still works.
describe('SAMPLE demo hat switch accessibility', () => {
  it('opens the role choices through accessibility and touch in either placement', () => {
    host.mode = 'sample';
    const label = 'Demo, switch role, Committee';
    const activations: readonly ('onAccessibilityTap' | 'onPress')[] = ['onAccessibilityTap', 'onPress'];
    for (const compact of [false, true]) {
      host.compact = compact;
      for (const via of activations) {
        const closed = render();
        expect(closed.some(node => node.props.accessibilityLabel === 'Switch role')).toBe(false);
        const trigger = labelled(closed, label);
        expect(trigger.props).toMatchObject({ accessible: true, accessibilityRole: 'button', accessibilityState: { expanded: false } });
        expect(trigger.props[via]).toEqual(expect.any(Function));
        trigger.props[via]!();
        const opened = render();
        expect(labelled(opened, label).props.accessibilityState?.expanded).toBe(true);
        expect(opened.some(node => node.props.accessibilityViewIsModal)).toBe(true);
        // Buttons use an actionable native iOS trait; radio mapped to a cell.
        expect(labelled(opened, 'Switch role').props.accessibilityRole).toBeUndefined();
        const choices = SAMPLE_HATS.map(hat => labelled(opened, hat.label));
        expect(choices.map(node => node.props.accessibilityLabel)).toEqual([
          'Worker', 'Organizer', 'Committee', 'Campaign lead', 'Advisor', 'Admin', 'Campaign chair',
        ]);
        expect(choices.filter(node => node.props.accessibilityState?.selected).map(node => node.props.accessibilityLabel)).toEqual(['Committee']);
        labelled(opened, 'Close role menu').props.onPress!();
        expect(render().some(node => node.props.accessibilityLabel === 'Switch role')).toBe(false);
      }
    }
  });

  it.each(SAMPLE_HATS)('renders actionable, named options with $label selected', (active) => {
    host.activeHat = active.key;
    labelled(render(), `Demo, switch role, ${active.label}`).props.onPress!();
    const opened = render();
    for (const hat of SAMPLE_HATS) {
      expect(labelled(opened, hat.label).props).toMatchObject({
        accessible: true,
        accessibilityRole: 'button',
        accessibilityLabel: hat.label,
        accessibilityHint: `Switches the demo to ${hat.label}. ${hat.description}`,
        accessibilityState: { selected: hat.key === active.key, disabled: false },
        disabled: false,
        onPress: expect.any(Function),
      });
    }
  });

  it('disables choices while switching and moves the selected state after success', async () => {
    let finish!: () => void;
    host.switchSampleHat.mockImplementationOnce((key) => new Promise<void>((resolve) => {
      finish = () => { host.activeHat = key; resolve(); };
    }));
    labelled(render(), 'Demo, switch role, Committee').props.onPress!();
    labelled(render(), 'Worker').props.onPress!();
    expect(host.switchSampleHat).toHaveBeenCalledExactlyOnceWith('member');
    for (const hat of SAMPLE_HATS) {
      expect(labelled(render(), hat.label).props).toMatchObject({
        accessibilityRole: 'button', disabled: true,
        accessibilityState: { selected: hat.key === 'steward', disabled: true },
      });
    }
    finish();
    await Promise.resolve();
    labelled(render(), 'Demo, switch role, Worker').props.onPress!();
    const reopened = render();
    expect(SAMPLE_HATS.filter(hat => labelled(reopened, hat.label).props.accessibilityState?.selected).map(hat => hat.label)).toEqual(['Worker']);
    expect(labelled(reopened, 'Worker').props.accessibilityState?.disabled).toBe(false);
  });

  // The offline PREVIEW roster keeps its switcher, over every organizing hat.
  it('opens the PREVIEW choices through accessibility and touch in either placement', () => {
    host.mode = 'preview';
    const label = 'PREVIEW demo, switch role, Committee';
    for (const compact of [false, true]) {
      host.compact = compact;
      for (const via of ['onAccessibilityTap', 'onPress'] as const) {
        const closed = render();
        expect(closed.some(node => node.props.accessibilityLabel === 'Switch role')).toBe(false);
        const trigger = labelled(closed, label);
        expect(trigger.props).toMatchObject({ accessible: true, accessibilityRole: 'button', accessibilityState: { expanded: false } });
        expect(trigger.props[via]).toEqual(expect.any(Function));
        trigger.props[via]!();
        const opened = render();
        expect(labelled(opened, label).props.accessibilityState?.expanded).toBe(true);
        expect(opened.some(node => node.props.accessibilityViewIsModal)).toBe(true);
        const choices = ['Worker', 'Organizer', 'Committee', 'Campaign lead', 'Advisor', 'Admin', 'Campaign chair'].map(name => labelled(opened, name));
        expect(choices.filter(node => node.props.accessibilityState?.selected).map(node => node.props.accessibilityLabel)).toEqual(['Committee']);
        labelled(opened, 'Close role menu').props.onPress!();
        expect(render().some(node => node.props.accessibilityLabel === 'Switch role')).toBe(false);
      }
    }
    host.mode = 'sample';
  });

  it('renders no switcher or demo choices for a live account', () => {
    host.mode = 'live';
    expect(render()).toEqual([]);
  });
});

// A11Y-UG-NATIVE-ANDROID-HAT-PILL-LABEL-SHRINKS-AT-LARGE-TEXT-20261108:
// Android's shrink-to-fit collapsed the Home pill's "DEMO · <role>" label to a
// few pixels at font scale 2.0, so on Android the label only stops at its cap.
describe('labelled hat pill text at large text sizes', () => {
  const pillLabel = (tree: Element[]) => {
    const label = tree.find(node => node.type === 'Text' && node.props.minimumFontScale === 0.7);
    if (!label) throw new Error('Missing labelled pill text');
    return label;
  };

  it('never shrinks the label on Android and keeps one capped line', () => {
    host.os = 'android';
    expect(pillLabel(render()).props).toMatchObject({ adjustsFontSizeToFit: false, maxFontSizeMultiplier: 1.4, numberOfLines: 1 });
  });

  it('keeps shrink-to-fit on iOS', () => {
    host.os = 'ios';
    expect(pillLabel(render()).props).toMatchObject({ adjustsFontSizeToFit: true, maxFontSizeMultiplier: 1.4, numberOfLines: 1 });
  });
});

// On iPhone the DEMO label went blank after the system
// text size changed with the app open, until a restart (iOS kept the
// shrink-to-fit size it computed for the old text size). The label is keyed
// by the font scale, so a mounted switcher draws a new label at the new size.
describe('the DEMO label across a text size change', () => {
  // The pill text is a fragment ("DEMO · {label}"), so read its words through it.
  const words = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value)
    : Array.isArray(value) ? value.map(words).join('')
      : React.isValidElement(value) ? words((value.props as { children?: unknown }).children) : '';
  const label = (tree: Element[]) => {
    const found = tree.find(node => node.props.adjustsFontSizeToFit !== undefined && words(node.props.children).startsWith('DEMO'));
    if (!found) throw new Error('Missing DEMO label');
    return found;
  };
  it.each([false, true])('draws a fresh label at the new size (compact pill: %s)', (compact) => {
    host.mode = 'sample';
    host.compact = compact;
    const before = label(render());
    expect(render().map(node => node.key)).toContain(before.key);
    host.fontScale = 1.35;
    const after = label(render());
    expect(after.key).not.toBe(before.key);
    expect(words(after.props.children)).toMatch(/^DEMO/);
    host.fontScale = 1;
    expect(label(render()).key).toBe(before.key);
  });
});

