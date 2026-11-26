import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHINE_BORDER_COLORS, SHINE_BORDER_DURATION_MS, SHINE_BORDER_WIDTH, SHINE_GRADIENT_PERIODS, shineGradientStops } from '../theme/shineBorder';
import { resolveTheme, themeKeys, type ThemeKey } from '../theme/tokens';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

// WCAG 2.1 relative luminance and contrast ratio, the pinned zero-dependency
// implementation the repository's contrast guard prescribes.
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('shine border palette', () => {
  // Union Ground in light and in the dark form the device setting selects.
  const schemes = themeKeys.flatMap((key): [ThemeKey, boolean][] => [[key, false], [key, true]]);
  it('is the reference purple, pink and peach, in one tokenized file', () => {
    expect([...SHINE_BORDER_COLORS]).toEqual(['#A07CFE', '#FE8FB5', '#FFBE7B']);
    expect(SHINE_BORDER_WIDTH).toBe(1.5);
    expect(SHINE_BORDER_DURATION_MS).toBeGreaterThanOrEqual(3000);
    expect(SHINE_BORDER_DURATION_MS).toBeLessThanOrEqual(4000);
    // The component consumes the tokens; it does not restate the palette.
    const shine = read('./ShineBorder.tsx');
    for (const color of SHINE_BORDER_COLORS) expect(shine).not.toContain(color);
    expect(shine).toContain("from '../theme/shineBorder'");
    // The only literals left are the luminance mask's white and black, which
    // are not painted colours.
    expect(shine.match(/#[0-9a-fA-F]{3,8}\b/g)?.sort()).toEqual(['#000', '#fff']);
  });

  it('repeats once per control width so sliding by one width has no seam', () => {
    for (const palette of [SHINE_BORDER_COLORS, ['#111111', '#222222'], ['#333333', '#444444', '#555555', '#666666']]) {
      const stops = shineGradientStops(palette);
      const period = palette.length;
      expect(stops).toHaveLength(period * SHINE_GRADIENT_PERIODS + 1);
      // Stop i sits at i / (stops - 1) of the 3-width rect, so one width is
      // exactly `period` stops: the frame after one width equals the first.
      for (let index = 0; index + period < stops.length; index += 1) {
        expect(stops[index + period]).toBe(stops[index]);
      }
      expect(stops[0]).toBe(stops.at(-1));
    }
  });

  it('falls back to the default palette rather than an invisible ring', () => {
    expect(shineGradientStops([])).toEqual(shineGradientStops(SHINE_BORDER_COLORS));
    expect(new Set(shineGradientStops(['#123456'])).size).toBe(1);
  });

  it('is never the only boundary: the ring is decorative and a token keyline carries contrast', () => {
    // Peach on the light canvases falls well below the 3:1 non-text minimum, so
    // the pill must not rely on the ring alone.
    const failing = themeKeys.flatMap((key) => {
      const theme = resolveTheme(key);
      return SHINE_BORDER_COLORS.filter((color) => contrast(color, theme.background) < 3).map((color) => `${key}/${color}`);
    });
    expect(failing.length).toBeGreaterThan(0);
    for (const [key, dark] of schemes) {
      const theme = resolveTheme(key, dark);
      // The keyline (theme.border) is the boundary, and the ink is readable on
      // the canvas the transparent pill sits on and on its opaque fallback.
      expect(contrast(theme.border, theme.background), `${key} border/background`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.foreground, theme.background), `${key} ink/background`).toBeGreaterThanOrEqual(7);
      expect(contrast(theme.cardForeground, theme.card), `${key} ink/card (Reduce Transparency)`).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps the dropdown text readable on every surface a row can take', () => {
    for (const [key, dark] of schemes) {
      const theme = resolveTheme(key, dark);
      for (const surface of [theme.popover, theme.secondary, theme.muted]) {
        expect(contrast(theme.foreground, surface), `${key} title on ${surface}`).toBeGreaterThanOrEqual(7);
        expect(contrast(theme.mutedForeground, surface), `${key} description on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme.primary, theme.secondary), `${key} selected radio`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.mutedForeground, theme.popover), `${key} unselected radio`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('ShineBorder component contract', () => {
  const shine = read('./ShineBorder.tsx');

  it('holds still, on frame zero, under Reduce Motion and while paused', () => {
    expect(shine).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(shine).toContain('const reduceMotion = useReduceMotion()');
    expect(shine).toMatch(/if \(reduceMotion\) \{[\s\S]*?travel\.stopAnimation\(\);\s*travel\.setValue\(0\);\s*return;/);
    expect(shine).toMatch(/if \(paused\) \{\s*travel\.stopAnimation\(\);\s*return;/);
    // Motion only starts after both checks, and its loop is torn down.
    expect(shine.indexOf('Animated.loop(')).toBeGreaterThan(shine.indexOf('if (paused)'));
    expect(shine).toContain('return () => { loop.stop(); };');
    expect(shine).toContain('}, [drift, duration, paused, reduceMotion, travel]);');
  });

  it('is decorative: no touches, out of the accessibility tree, transparent inside', () => {
    expect(shine).toContain('pointerEvents="none"');
    expect(shine).toContain('accessibilityElementsHidden');
    expect(shine).toContain('importantForAccessibility="no-hide-descendants"');
    expect(shine).not.toMatch(/accessibilityLabel|accessibilityRole|backgroundColor/);
  });

  it('extends the same travelling gradient to the fill, and eases the drift', () => {
    // The hat pill's slow sheen rides the ring's own mechanism rather than
    // adding a second one
    // (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010).
    expect(shine).toContain('fillOpacity = 0,');
    expect(shine).toContain('drift = false,');
    expect(shine).toContain('{fillOpacity > 0 ? (');
    expect(shine).toContain('opacity={fillOpacity}');
    // One sequence, eased in and out and reversed each cycle; the plain ring
    // keeps its linear loop.
    expect(shine).toMatch(/const loop = drift\s*\?\s*Animated\.loop\(Animated\.sequence\(\[/);
    expect(shine).toContain('easing: Easing.inOut(Easing.quad)');
    expect(shine).toContain('easing: Easing.linear');
  });
});

describe('Reduce Transparency store', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('react');
    vi.doUnmock('react-native');
  });

  async function load(reduceTransparency: boolean | 'reject') {
    const remove = vi.fn();
    // Stands in for the platform: `emit` delivers a live setting change.
    const changes: { emit: (value: boolean) => void } = { emit: () => undefined };
    const addEventListener = vi.fn((_event: string, handler: (value: boolean) => void) => {
      changes.emit = handler;
      return { remove };
    });
    const isReduceTransparencyEnabled = vi.fn(() =>
      reduceTransparency === 'reject' ? Promise.reject(new Error('unsupported')) : Promise.resolve(reduceTransparency),
    );
    const captured: { store: { subscribe: (listener: () => void) => () => void; read: () => boolean } | null } = { store: null };
    vi.resetModules();
    vi.doMock('react', () => ({
      useSyncExternalStore: (subscribe: (listener: () => void) => () => void, read: () => boolean) => {
        captured.store = { subscribe, read };
        return read();
      },
    }));
    vi.doMock('react-native', () => ({
      AccessibilityInfo: { addEventListener, isReduceTransparencyEnabled },
    }));
    const { useReduceTransparency } = await import('../lib/reduceTransparency');
    const initial = useReduceTransparency();
    return { initial, remove, addEventListener, changes, isReduceTransparencyEnabled, store: captured.store! };
  }

  it('starts opaque until the platform answers, like Reduce Motion', async () => {
    const { initial } = await load(false);
    expect(initial).toBe(true);
  });

  it('publishes the platform answer and live changes to subscribers', async () => {
    const { store, addEventListener, changes } = await load(false);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.read()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(addEventListener.mock.calls[0]?.[0]).toBe('reduceTransparencyChanged');
    changes.emit(true);
    expect(store.read()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('registers one native listener for many readers and removes it with the last', async () => {
    const { store, remove, addEventListener } = await load(false);
    const first = store.subscribe(vi.fn());
    const second = store.subscribe(vi.fn());
    expect(addEventListener).toHaveBeenCalledTimes(1);
    first();
    expect(remove).not.toHaveBeenCalled();
    second();
    expect(remove).toHaveBeenCalledTimes(1);

    // A later reader starts a fresh listener rather than reusing a dead one.
    const third = store.subscribe(vi.fn());
    expect(addEventListener).toHaveBeenCalledTimes(2);
    third();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('stays opaque when the platform cannot answer', async () => {
    const { store } = await load('reject');
    const unsubscribe = store.subscribe(vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    expect(store.read()).toBe(true);
    unsubscribe();
  });
});

describe('hat switcher dropdown contract', () => {
  const hats = read('./HatSwitcher.tsx');
  const layout = read('../../app/_layout.tsx');
  const account = read('../../app/(tabs)/account.tsx');
  const chrome = read('../lib/chrome.ts');

  it('is an anchored dropdown, not a bottom sheet', () => {
    expect(hats).not.toContain('<Modal');
    expect(hats).not.toContain('SafeAreaView');
    expect(hats).not.toContain('translateY: slide');
    expect(hats).toContain('const menuTop = hatMenuTop(pillTop, PILL_HEIGHT);');
    expect(hats).toContain('const menuMaxHeight = hatMenuMaxHeight(windowHeight, menuTop, hatMenuBottomInset(insets.bottom, platform, nativeTabPath(pathname)), spacing.xl);');
    expect(hats).toContain('style={[styles.menuHost, compact ? styles.menuHostTrailing : null, { top: menuTop }]}');
    expect(hats).toContain('minHeight: HAT_MENU_ROW_HEIGHT');
  });

  it('never hides the switcher on a route, only moves it clear of the pinned title', () => {
    expect(hats).toContain('const placement = hatPillPlacementForPath(pathname);');
    expect(hats).toContain("const compact = placement === 'pinned-trailing';");
    // The historical fix hid the pill on pushed routes; the contract now requires
    // an explicit switcher on every SAMPLE/PREVIEW screen.
    expect(hats).not.toContain('pillVisible');
    expect(hats).not.toContain('hatPillVisibleOnPath');
    expect(hats).not.toMatch(/\{\s*pillVisible\s*\?/);
    expect(hats).toContain('const COMPACT_PILL_WIDTH = FLOATING_CONTROL_HIT_WIDTH;');
    // The tap target is the anchor band itself, so no hitSlop can push it into
    // the status-bar frame or into the first row of content.
    expect(hats).not.toMatch(/hitSlop=/);
    expect(hats).toContain('{ top: pillTop, height: pillBandHeight }');
    expect(hats).toContain("anchorTrailing: {\n    alignItems: 'flex-end',\n    paddingRight: pinnedHeaderLayout.trailingInset,");
  });

  it('keeps the compact trigger explicit to assistive tech and wired to the same menu', () => {
    // Compact and floating share one trigger; choices and Close are buttons
    // too, and so is the store demo's Exit demo row.
    expect(hats.match(/accessibilityRole="button"/g)?.length).toBe(4);
    expect(hats).toContain('accessibilityLabel={mode === \'preview\' ? `PREVIEW demo, switch role, ${current.label}` : `Demo, switch role, ${current.label}`}');
    expect(hats).toContain('accessibilityState={{ expanded: open }}');
    // Visitors meet the web demo's word, not the build's internal SAMPLE name.
    expect(hats).toContain("const modeLabel = mode === 'preview' ? 'PREVIEW' : 'DEMO';");
    expect(hats).toContain("{mode === 'preview' ? <>PREVIEW · {current.label}</> : <>DEMO · {current.label}</>}");
    expect(hats).not.toContain('SAMPLE · ');
    expect(hats).toContain('onPress={open ? closeMenu : openMenu}');
    // One line on a pushed screen, never the two-line stack the October 9
    // capture showed 2pt from the screen edge.
    expect(hats).toContain('style={[styles.compactMode, { color: ink }]}>{modeLabel} <Ionicons name="chevron-down" size={11} color={ink} /></Text>');
    expect(hats).not.toMatch(/pillInnerCompact: \{[^}]*flexDirection: 'column'/);
  });

  it('keeps every gate: live accounts, the request store, drawers and Home travel', () => {
    expect(hats).toContain('const activeHat = mode === \'preview\' ? previewHat : sampleHat;');
    expect(hats).toContain("const hats = mode === 'preview' ? PREVIEW_HATS : SAMPLE_HATS;");
    expect(hats).toContain('if (!activeHat || hats.length === 0) return null;');
    expect(hats).toContain('const seenRequests = useRef(requests);');
    expect(hats).toContain('if (requests === seenRequests.current) return;');
    expect(hats).toContain('const drawerOpen = useDockSuppressed();');
    expect(hats).toContain("pointerEvents={drawerOpen || pillOffScreen ? 'none' : 'box-none'}");
    expect(hats).toContain('accessibilityElementsHidden={drawerOpen || open}');
    expect(hats).toContain('const homeTravel = Animated.multiply(homeScrollOffset, -1);');
    expect(hats).toContain('accessibilityElementsHidden={scrollsWithHome && homeAwayFromTop}');
    expect(layout).toContain("<HatSwitcher scrollsWithHome={pathname === '/home'} onMenuVisibilityChange={setHatMenuOpen} />");
  });

  it('closes on outside tap, the back button, the escape gesture, route change and Close', () => {
    expect(hats).toContain('onPress={closeMenu}');
    expect(hats).toContain("BackHandler.addEventListener('hardwareBackPress'");
    expect(hats).toContain('return () => { subscription.remove(); };');
    expect(hats).toContain('onAccessibilityEscape={closeMenu}');
    expect(hats).toContain('accessibilityViewIsModal');
    expect(layout).toContain("importantForAccessibility={hatMenuOpen ? 'no-hide-descendants' : 'auto'}");
    // BUG-UG-ANDROID-HAT-SWITCH-CRASHES-FABRIC-ADDVIEWAT-20261011:
    // the View the menu hides must never be flattened, or each open and close
    // moves the navigation Stack and re-attaches Android's native tab host.
    expect(layout).toMatch(/<View collapsable=\{false\} style=\{\{ flex: 1 \}\} accessibilityElementsHidden=\{hatMenuOpen\}/);
    expect(hats).toContain('onMenuVisibilityChange?.(open && Boolean(activeHat));');
    expect(hats).toContain('if (lastPathname.current === pathname) return;');
    expect(hats).toContain('accessibilityLabel="Close role menu"');
    // The scrim is not a second, unlabeled control for screen readers.
    expect(hats).toMatch(/<Pressable\s+accessible=\{false\}\s+importantForAccessibility="no"/);
  });

  it('cleans up its animations and native subscriptions', () => {
    expect(hats).toContain('return () => { pulseAnimation.stop(); };');
    expect(hats).toContain('useEffect(() => () => { menu.stopAnimation(); }, [menu]);');
    expect(hats).not.toContain('AccessibilityInfo');
  });

  it('swaps to an opaque card pill under Reduce Transparency, ring and keyline intact', () => {
    expect(hats).toContain("import { useReduceTransparency } from '../lib/reduceTransparency';");
    expect(hats).toContain('const reduceTransparency = useReduceTransparency();');
    // The opaque fill itself lives in the shared FrostedCapsule, which every
    // floating control takes, so the pill and the back circle cannot disagree.
    expect(hats).toContain("import { FrostedCapsule } from './TopChrome';");
    expect(read('./TopChrome.tsx')).toContain('backgroundColor: theme.card');
    expect(hats).toContain('const ink = reduceTransparency ? theme.cardForeground : theme.foreground;');
    expect(hats).toContain('<View pointerEvents="none" style={[styles.keyline, { borderColor: theme.border }]} />');
    // Semantic ink only: no colour literals in the switcher.
    expect(hats).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(hats).not.toMatch(/rgba?\(/);
  });

  it('holds the ring still whenever the pill is not the thing on screen', () => {
    expect(hats).toContain('paused={open || drawerOpen || pillOffScreen}');
    expect(hats).toContain('const pillOffScreen = scrollsWithHome && homeAwayFromTop;');
  });

  it('exports the Account row on the same gate as the pill', () => {
    expect(account).toContain("import { requestHatSwitcher } from '../../src/lib/hatSwitcher';");
    expect(account).toContain("const demoHat = mode === 'preview' ? previewHat : sampleHat;");
    expect(account).toContain('{demoHat ? (');
    expect(account).toContain("accessibilityLabel={t(\"Switch demo role\")}");
    expect(account).toContain('onPress={requestHatSwitcher}');
  });

  it('shares the geometry through chrome.ts for screens that reserve the SAMPLE band', () => {
    for (const name of ['hasFloatingHatChrome', 'hatPillPlacementForPath', 'floatingControlTop', 'floatingControlHitHeight', 'hatMenuTop', 'hatMenuMaxHeight']) {
      expect(chrome, name).toContain(name);
    }
  });
});

// Demo audit, Nov 7, 2026: at Accessibility XXXL the fixed 280 pt menu broke
// role names mid-word ("Membe / r"), cut descriptions to two lines and showed
// one role. From the first accessibility size the menu takes the screen's
// width, descriptions wrap, radios sit on the name line, every line stops at
// the 2x cap, and the scroll indicator flashes once the menu is open.
describe('hat menu at the accessibility text sizes', () => {
  it('widens, wraps and caps the menu from the first accessibility size', () => {
    const hats = read('./HatSwitcher.tsx');
    expect(hats).toContain('const largeMenuText = fontScale > 1.2;');
    expect(hats).toContain("menuLargeText: { width: '92%', maxWidth: 520 },");
    expect(hats).toContain('numberOfLines={fontScale > 1 ? undefined : 2}');
    // Six menu lines and the store demo's Exit demo label.
    expect(hats.match(/maxFontSizeMultiplier=\{HAT_MENU_TEXT_CAP\}/g)).toHaveLength(7);
    expect(hats).toContain('const HAT_MENU_TEXT_CAP = 2;');
    expect(hats).toContain('const radioOffset = Math.max(0, (ROW_TITLE_LINE_HEIGHT * menuTextScale - RADIO_SIZE) / 2);');
    expect(hats).toContain('listRef.current?.flashScrollIndicators()');
    // Whenever the list overflows, the current role comes into view as soon
    // as it is measured, and quiet hints say while roles are hidden above or
    // below; every opening measures afresh.
    expect(hats).toContain('rowLayouts.current.size === hats.length');
    expect(hats).toContain('rowLayouts.current.set(item.key, { y, height });');
    expect(hats).toContain('listRef.current?.scrollTo({ y: viewport.offset, animated: false });');
    expect(hats).toContain('const above = overflows && viewport.offset > 1;');
    expect(hats).toContain('const below = overflows && viewport.offset + viewport.height < viewport.content - 1;');
    expect(hats).toContain('listViewport.current = { offset: 0, height: 0, content: 0 };');
    // The caption stays "Switch role"; while roles are hidden above, a chevron
    // beside it and a hairline under it say so. The bottom hint lies over the
    // list's edge on the menu's fill, so the list height never changes and no
    // band is left at the end.
    expect(hats).toMatch(/\{hiddenRoles\.above \? \([\s\S]{0,260}>More above<\/Text>/);
    expect(hats).toContain("borderBottomColor: hiddenRoles.above ? theme.border : 'transparent'");
    expect(hats).toContain('{hiddenRoles.below ? <FoldHint scale={menuTextScale} color={theme.mutedForeground} background={theme.popover} border={theme.border} /> : null}');
    // The hint takes its own touches, so it never selects the role beneath.
    expect(hats).toContain('<View onStartShouldSetResponder={() => true} accessibilityElementsHidden');
    expect(hats).toContain("foldHint: { position: 'absolute', left: 0, right: 0, bottom: 0,");
    expect(hats).toContain('const offset = Math.min(selected.y, boundary);');
    expect(hats).toContain('viewport.content >= content + padding - 1');
    expect(hats).toContain('setHiddenRoles((current) => (current.above === above && current.below === below ? current : { above, below }));');
    expect(hats).toContain('>Scroll for more roles</Text>');
    expect(hats).toMatch(/accessibilityRole="header">\s*Switch role\s*<\/Text>/);
  });
});
