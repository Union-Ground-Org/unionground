import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type { JsxAttributeValue, JsxOpeningElement, JsxSelfClosingElement, Node as SyntaxNode, PropertyAccessExpression } from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  appendPreviewEventDraft,
  PREVIEW_HATS,
  PREVIEW_NOW,
  previewEventCheckInCode,
  previewBallotCardState,
  previewDeskFor,
  previewEventCheckInPresentation,
  togglePreviewEventCheckIn,
} from '../data/preview';
import { canOpenFeature, CONTRIBUTIONS_COPY, FEATURE_KEYS, PREVIEW_RECOGNITION_RULES, RECOGNITION_RUNGS, recognitionRung } from '../lib/featureCatalog';
import { contrastRatio } from '../theme/contrast';
import { themePalette } from '../theme/tokens';
import { STATUS_RAMP_TOKENS, statusStateForLabel } from '../theme/statusRamp';

// Source-string contract for the P0 layout-chrome and elevation primitives
// (docs/mobile/lovable-exhaustive/triage.md P0-1 and P0-2). These guard the
// shared tokens against a screen quietly reintroducing a one-off shadow or
// dropping the dock/pinned-header inset.

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// Live-session FeatureScreen gates, found by code neighbours rather than
// localized copy: the feature-level `if (mode !== 'preview')` branch, and the
// authenticated branch of DeskFeature (the gate after its preview gate). A
// quote-or-backtick + newline regex cannot see switchHat / qualifyingHats on
// a JSX-brace branch, so the old negatives stayed green no matter what the
// element contained.
function authorizationGateFrom(source: string, from: number): string {
  if (from === -1) return '';
  const open = source.indexOf('<AuthorizationGate', from);
  if (open === -1) return '';
  const close = source.indexOf('/>', open);
  if (close === -1) return '';
  return source.slice(open, close + 2);
}

function liveSessionAuthorizationGates(feature: string): string[] {
  const featureGate = authorizationGateFrom(feature, feature.indexOf("if (mode !== 'preview')"));
  const desk = feature.indexOf('function DeskFeature(');
  const deskPreviewGate = authorizationGateFrom(feature, desk);
  const deskGate = deskPreviewGate
    ? authorizationGateFrom(feature, feature.indexOf(deskPreviewGate, desk) + deskPreviewGate.length)
    : '';
  return [featureGate, deskGate];
}

// The five Union Ground dock roots.
const TAB_ROOTS = [
  '../../app/(tabs)/home.tsx',
  '../../app/(tabs)/work.tsx',
  '../../app/(tabs)/compass.tsx',
  '../../app/(tabs)/campaign.tsx',
  '../../app/(tabs)/account.tsx',
];

const PUSHED_SURFACES = [
  '../../app/legal/[page].tsx',
  '../../app/feature/[key].tsx',
  '../../app/issue/[id].tsx',
  '../../app/channel/[id].tsx',
  '../../app/conversation/[id].tsx',
  '../../app/notifications.tsx',
  '../../app/messages.tsx',
  '../../app/pulse.tsx',
  '../../app/recognition.tsx',
];

describe('elevation tokens (P0-2)', () => {
  const elevation = read('../theme/elevation.ts');

  it('derives every hue from the shipped palette instead of new hex values', () => {
    expect(elevation).toContain("import palette from './palette.json'");
    expect(elevation).toContain("const groundGreen = palette['union-ground'].primary");
    expect(elevation).toContain("const ink = palette['union-ground'].foreground");
    expect(elevation).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('ships the level ladder at the briefed values', () => {
    // Level 0: no shadow at all.
    expect(elevation).toMatch(/export const level0[\s\S]*?shadowOpacity: 0,[\s\S]*?elevation: 0,/);
    // Level 1: contact shadow only, ink/aubergine at or below 5%.
    expect(elevation).toMatch(
      /export const level1: ElevationToken = \{[\s\S]*?shadowOffset: \{ width: 0, height: 1 \},[\s\S]*?shadowOpacity: 0\.05,[\s\S]*?shadowRadius: 2,[\s\S]*?elevation: 1,/,
    );
    // Level 1 hero: one soft ambient pass.
    expect(elevation).toMatch(
      /export const level1Hero[\s\S]*?shadowOffset: \{ width: 0, height: 8 \},[\s\S]*?shadowOpacity: 0\.06,[\s\S]*?shadowRadius: 24,[\s\S]*?elevation: 3,/,
    );
    // Level 2: the pronounced ambient shadow, floating controls only.
    expect(elevation).toMatch(
      /export const level2[\s\S]*?shadowOffset: \{ width: 0, height: 12 \},[\s\S]*?shadowOpacity: 0\.08,[\s\S]*?shadowRadius: 32,[\s\S]*?elevation: 6,/,
    );
    // The dock's ink variant.
    expect(elevation).toMatch(
      /export const dockShadow[\s\S]*?shadowOffset: \{ width: 0, height: 10 \},[\s\S]*?shadowOpacity: 0\.22,[\s\S]*?shadowRadius: 24,[\s\S]*?elevation: 8,/,
    );
    // Level 3: wide soft overlay shadow.
    expect(elevation).toMatch(/export const level3[\s\S]*?shadowRadius: 40,[\s\S]*?elevation: 12,/);
    expect(read('../theme/elevation.ts')).toContain('shadowOffset: { width: 0, height: 18 },');
  });

  it('exports the pressed and selection constants', () => {
    expect(elevation).toContain('export const pressedScale = 0.98');
    expect(elevation).toContain('export const selectionLift');
    expect(elevation).toContain('export const pressedShadow');
  });

  it('extends the existing radius ladder rather than duplicating it', () => {
    const tokens = read('../theme/tokens.ts');
    expect(tokens).toContain('rowRadius: 12');
    expect(tokens).toContain('cardRadius: 16');
    expect(tokens).toContain('controlRadius: 20');
    expect(tokens).toContain('sheetRadius: 28');
    expect(tokens.match(/export const radii/g)?.length).toBe(1);
    expect(read('../theme/elevation.ts')).not.toContain('export const radii');
  });
});

describe('bottom-inset primitive (P0-1a)', () => {
  const chrome = read('../lib/chromeGeometry.ts');

  it('defines native-tab and non-tab resting insets without custom dock geometry', () => {
    expect(chrome).toContain('export const CHROME_CLEARANCE = 12');
    expect(chrome).toContain('export function nativeTabContentInset(): number');
    expect(chrome).toContain('export function screenBottomInset(safeAreaBottom: number): number');
    expect(chrome).not.toContain('dockContentInset');
  });

  it('uses the page resting gap plus the runtime safe area inside every native-tab scroll surface', () => {
    expect(read('../lib/chrome.ts')).toContain('nativeTabContentInset() + insets.bottom');
    for (const file of TAB_ROOTS) {
      // Work delegates its scrolling to the shared feature screen.
      const source = file.endsWith('work.tsx') ? read('../features/WorkScreen.tsx') : read(file);
      expect(source, `${file} must retain page rhythm above the native tab bar`)
        .toMatch(/useNativeTabContentInset\((?:true)?\)|nativeTabContentInset\(\)/);
    }
    // The shared Screen forwards the inset to contentContainerStyle.
    expect(read('./ui.tsx')).toContain('{ paddingTop: topPadding, paddingBottom: bottomPadding }');
    expect(read('./ui.tsx')).toContain('const bottomPadding = bottomInset');
  });

  it('does not apply the removed floating-dock height to Home or Guide', () => {
    expect(read('./HomeCarousel.tsx')).toContain('nativeTabContentInset()');
    expect(read('./CompassPanel.tsx')).not.toContain('dockContentInset');
    expect(read('./CompassPanel.tsx')).toContain('anchoredComposerLift(');
  });

  it('leaves no screen computing its own dock clearance', () => {
    for (const file of [...TAB_ROOTS, './ui.tsx', './HomeCarousel.tsx', './CompassPanel.tsx']) {
      expect(read(file), `${file} must not hardcode dock clearance`).not.toContain('tabBarClearance');
    }
  });
});

describe('pinned header primitive (P0-1b)', () => {
  const header = read('./PinnedHeader.tsx');

  it('backs the title row with the page canvas, with no line along its bottom edge', () => {
    // REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010
    // removed the 52pt porcelain bar. The title now sits on the row beside
    // Back (UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115), and the
    // owner's layout page backs that row once the page scrolls, so scrolled
    // text never reads through the title. The backing is the page's own
    // colour, invisible at rest; no porcelain alpha came back. The hairline
    // it took once scrolled is gone too: no line at a screen's top edge
    // (UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118, the design
    // publish checklist of Nov 18).
    const geometry = read('../lib/chromeGeometry.ts');
    expect(geometry).not.toContain('PINNED_HEADER_HEIGHT');
    expect(geometry).not.toContain('HAIRLINE_SCROLL_THRESHOLD');
    expect(header).not.toContain('PORCELAIN_OPACITY');
    expect(header).not.toContain('HAIRLINE_OPACITY');
    expect(header).not.toContain('backgroundColor: withAlpha');
    expect(header).toContain('{ height: backingHeight, backgroundColor: theme.background }');
    expect(header).toContain('style={[styles.backing, { height: backingHeight, backgroundColor: theme.background }]}');
    expect(header).not.toContain('borderBottomWidth');
    expect(header).not.toContain('scrolled ?');
    expect(header).not.toContain('reportScrollOffset');
  });

  it('floats a 26pt back circle whose target stops at the content start line', () => {
    expect(header).toContain("import { FrostedCapsule, withAlpha } from './TopChrome';");
    expect(header).toContain('backCircle: { width: FLOATING_CONTROL_SIZE, height: FLOATING_CONTROL_SIZE, borderWidth: StyleSheet.hairlineWidth }');
    // The circle keeps a visible edge on the solid top edge (UX-UG-NATIVE-TOP-EDGE-CONTENT-UNDER-STATUS-BAR-AND-DEMO-PILL-20261108).
    expect(header).toContain('<FrostedCapsule style={[styles.backCircle, { borderColor: theme.border }, pressed ? { opacity: 0.82 } : null]}>');
    expect(header).toContain('const backCircleFill = withAlpha(theme.card, 0.7);');
    expect(header).toContain('{ backgroundColor: backCircleFill }');
    expect(header).toContain('width: FLOATING_CONTROL_HIT_WIDTH,');
    expect(header).toContain('left: pinnedHeaderLayout.hitInset,');
    // The target is the slot, so nothing re-inflates it past the circle's own
    // top edge or down over the first row of content.
    expect(header).not.toMatch(/hitSlop=/);
    expect(header).toContain('titleSlot');
    // `flat` and `trailing` went with the bar: there is no bar to flatten and
    // the compact hat capsule floats at the right gutter on its own.
    expect(header).not.toContain('flat = false');
    expect(header).not.toContain('trailing?: ReactNode');
  });

  it('insets pushed-surface content below the title row', () => {
    expect(read('../lib/chromeGeometry.ts')).toContain('return safeAreaTop + CONTENT_START_OFFSET;');
    // The row (back band and title) ends before the first line of content, and
    // never above the one start line tab roots use.
    expect(header).toContain('const contentInset = pinnedRowContentInset(insets.top, spacing.xs, titleHeight);');
    expect(read('./ui.tsx')).toContain('const startLine = pinned?.contentInset ?? contentStartInset(insets.top);');
    // Nothing reports a scroll offset to the row any more: it drew the hairline alone.
    expect(read('./ui.tsx')).not.toContain('reportPinnedScroll');
    expect(read('../../app/conversation/[id].tsx')).not.toContain('reportScrollOffset');
  });

  it('is used by every pushed surface that used to float a bare chevron', () => {
    for (const file of PUSHED_SURFACES) {
      expect(read(file), `${file} must render the pinned header`).toContain('PinnedHeaderScreen');
    }
    // The native stack bar is suppressed so the chevron is not doubled.
    const layout = read('../../app/_layout.tsx');
    for (const route of [
      'issue/[id]', 'notifications', 'messages', 'pulse', 'recognition', 'channel/[id]', 'conversation/[id]',
      'feature/[key]', 'legal/[page]',
      //: the two-person conversation and Write to an officer screens.
      'peer-conversation/[id]', 'officer-contact',
    ]) {
      expect(layout).toContain(`name="${route}" options={{`);
    }
    expect(layout.match(/presentation: 'card', headerShown: false/g)?.length).toBe(11);
  });
});

describe('Home Work drawer null-dashboard state (UX-UG-HOME-WORK-DRAWER-BLANK-DURING-DASHBOARD-LOAD-20260920)', () => {
  const carousel = withoutComments(read('./HomeCarousel.tsx'));
  const workDrawer = carousel.slice(carousel.indexOf("importantForAccessibility={activeDrawer === 'work'"), carousel.indexOf('{...(settledDrawer'));

  it('reads the dashboard error and retry from app state', () => {
    expect(carousel).toMatch(/const \{\s*dashboard,\s*error,\s*refreshing,\s*refresh,/);
  });

  it('never renders an empty drawer while the dashboard is null', () => {
    expect(workDrawer).not.toMatch(/\{dashboard \? \([\s\S]*\) : null\}/);
    const fallback = workDrawer.slice(workDrawer.indexOf(') : ('));
    expect(fallback).toContain("<Heading>{t(\"Campaign work\")}</Heading>");
    // Loading state (no error) and failed state (error text) share one live region.
    expect(fallback).toContain('accessibilityLiveRegion="polite"');
    expect(fallback).toContain("{error ?? t(\"Loading your home.\")}");
  });

  it('offers a retry only after a failure, and refuses duplicates while refreshing', () => {
    const fallback = workDrawer.slice(workDrawer.indexOf(') : ('));
    expect(fallback).toContain('{error ? <Button label={refreshing ? t("Retrying…") : t("Try again")} disabled={refreshing} onPress={() => { void refresh(); }} /> : null}');
    // The Home card already announces this state; the drawer must not queue a second announcement.
    expect(fallback).not.toContain('StateMessage');
  });

  it('keeps the Work widgets when the dashboard is available', () => {
    expect(workDrawer).toMatch(/\{dashboard \? \([\s\S]*<MemoWorkWidgets\s+dashboard=\{dashboard\}/);
  });
});

describe('z-order repairs (P0-1c)', () => {
  it('stands the dock down while a Home drawer is settled', () => {
    const carousel = read('./HomeCarousel.tsx');
    const layout = read('../../app/(tabs)/_layout.tsx');
    expect(carousel).toContain('setDockSuppressed(next != null)');
    expect(layout).toContain('const hidden = useDockSuppressed()');
    expect(layout).toContain('hidden={hidden || androidHomeOnly}');
    // The drawer pan arms on any decisively horizontal drag: the old
    // edge-only strips sat inside Android's system back band (Pixel 10a).
    expect(carousel).toContain('Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15');
    expect(carousel).not.toContain('EDGE_PAN_WIDTH');
  });

  it('draws no band or bar under the status bar on any surface', () => {
    const ui = read('./ui.tsx');
    // The opaque backing went with the 52pt bar on Oct 10, and the top ramp
    // that replaced it is gone too (owner ruling, Nov 22-23, 2026,):
    // content scrolls up behind the clock.
    expect(ui).not.toContain('statusBarBacking');
    expect(ui).not.toContain('OverlayTopBand height');
    expect(ui).not.toContain('TopRamp');
    expect(read('./TopChrome.tsx')).not.toContain('function TopRamp');
  });

  it('starts content on the one shared line, on every surface in scope', () => {
    expect(read('../lib/chromeGeometry.ts')).toContain('return safeAreaTop + CONTENT_START_OFFSET;');
    for (const file of [
      './ui.tsx',
      '../features/PulseScreen.tsx',
      '../../app/(tabs)/compass.tsx',
      './QuickActionsDrawer.tsx',
      './HomeCarousel.tsx',
      '../../app/conversation/[id].tsx',
    ]) {
      expect(read(file), `${file} must take the shared content start line`).toContain('contentStartInset(insets.top)');
      expect(read(file), `${file} must not keep its own top-inset formula`).not.toContain('floatingChromeTopInset');
    }
  });
});

describe('platform-native tabs, top band, and Guide composer', () => {
  // UX-UG-NATIVE-ANDROID-TAB-BAR-OFF-PALETTE-AND-UNLABELED-TABS-20261109:
  // the props the layout really passes, read from its parsed JSX (comments and
  // strings do not count), with each theme token resolved to its color.
  it('labels every Android tab and marks the selected one in the palette, over the canvas', () => {
    const file = fileURLToPath(new URL('../../app/(tabs)/_layout.tsx', import.meta.url));
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const elements: (JsxOpeningElement | JsxSelfClosingElement)[] = [];
    const visit = (node: SyntaxNode) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const props = (element: JsxOpeningElement | JsxSelfClosingElement) => new Map(element.attributes.properties
      .filter(ts.isJsxAttribute)
      .map((attribute): [string, JsxAttributeValue | undefined] => [attribute.name.getText(source), attribute.initializer]));
    const tabs = elements.filter((element) => element.tagName.getText(source) === 'NativeTabs');
    expect(tabs).toHaveLength(1);
    const passed = props(tabs[0]!);
    // `theme.<token>` in a prop or style, as the token name.
    const token = (expression: SyntaxNode | undefined): string => {
      const inner = expression && ts.isJsxExpression(expression) ? expression.expression : expression;
      expect(inner && ts.isPropertyAccessExpression(inner) && inner.expression.getText(source) === 'theme', inner?.getText(source)).toBe(true);
      return (inner as PropertyAccessExpression).name.text;
    };
    const literal = passed.get('labelVisibilityMode');
    expect(literal && ts.isStringLiteral(literal) ? literal.text : null).toBe('labeled');
    const indicator = token(passed.get('indicatorColor'));
    const ripple = token(passed.get('rippleColor'));
    const iconColor = passed.get('iconColor');
    const selectedIcon = iconColor && ts.isJsxExpression(iconColor) && iconColor.expression && ts.isObjectLiteralExpression(iconColor.expression)
      ? iconColor.expression.properties.filter(ts.isPropertyAssignment).find((property) => property.name.getText(source) === 'selected')?.initializer
      : undefined;
    const selected = token(selectedIcon);
    // The host behind the bar paints the canvas.
    const host = elements.find((element) => element.tagName.getText(source) === 'View' && element.parent.parent.parent && ts.isReturnStatement(element.parent.parent.parent));
    const style = host ? props(host).get('style') : undefined;
    const hostBackground = style && ts.isJsxExpression(style) && style.expression && ts.isArrayLiteralExpression(style.expression)
      ? style.expression.elements.filter(ts.isObjectLiteralExpression).flatMap((object) => object.properties.filter(ts.isPropertyAssignment))
        .find((property) => property.name.getText(source) === 'backgroundColor')?.initializer
      : undefined;
    expect(token(hostBackground)).toBe('background');
    // The chosen tokens: light green pill, dark green selection, dark green
    // focus-color ripple. A different color is a deliberate change here.
    expect({ indicator, selected, ripple }).toEqual({ indicator: 'secondary', selected: 'primary', ripple: 'ring' });
    for (const tokens of Object.values(themePalette)) {
      const color = (name: string) => tokens[name as keyof typeof tokens];
      // Selected icon and label on the pill, unselected on the canvas.
      expect(contrastRatio(color(selected), color(indicator))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.mutedForeground, tokens.background)).toBeGreaterThanOrEqual(4.5);
      // A press shows on the selected pill and on the canvas.
      expect(contrastRatio(color(ripple), color(indicator))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color(ripple), tokens.background)).toBeGreaterThanOrEqual(3);
      // The pill is the palette's, not the platform's stock lavender.
      expect(color(indicator)).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('mounts the platform-native tab host without custom overlay chrome', () => {
    const layout = read('../../app/(tabs)/_layout.tsx');
    expect(layout).toContain("import { NativeTabs } from 'expo-router/unstable-native-tabs'");
    expect(layout).toContain('<NativeTabs');
    expect(layout).not.toContain('DockScrim');
    expect(layout).not.toContain('CapsuleTabBar');
    // No separator line along the bar's top edge. Unset, iOS draws its own
    // default hairline, so the layout passes transparent
    // (UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118).
    expect(layout).toContain('shadowColor="transparent"');
    expect(layout).not.toContain('shadowColor={theme.border}');
  });

  it('keeps Home on the same content start line as every other surface', () => {
    const ui = read('./ui.tsx');
    const home = read('../../app/(tabs)/home.tsx');
    // One formula for every path: no preview branch, no platform branch.
    expect(ui).toContain('const startLine = pinned?.contentInset ?? contentStartInset(insets.top);');
    expect(ui).not.toContain('overlayChrome');
    expect(home).toContain('<Screen tabRoot bottomInset={bottomInset} scrollsTopChrome>');
    expect(home).not.toContain('previewFeedEdgeToEdge');
    // Home's own chrome still travels with the finite feed; the ramp does not.
    expect(ui).toContain('{(scrollsTopChrome || tabRoot) && Platform.OS === \'ios\' ? (');
  });

  it('pads the Guide transcript by the measured composer height and follows new replies', () => {
    const compass = read('./CompassPanel.tsx');
    expect(compass).toContain('{ paddingBottom: composerHeight + CHROME_CLEARANCE }');
    expect(compass).toContain('setComposerHeight');
    expect(compass).toContain('event.nativeEvent.layout.height');
    expect(compass).toContain('threadRef.current?.scrollToEnd({ animated: !reduceMotion })');
    // An answer lands on its question with the keyboard down (live audit N9).
    expect(compass).toContain("const answeredQuestionId = lastRole === 'assistant' ? messages.slice(-2)[0]?.id : undefined;");
    expect(compass).toContain('if (answeredQuestionId) Keyboard.dismiss();');
    expect(compass).toContain('else threadRef.current?.scrollTo({ y: Math.max(0, top - spacing.md), animated: !reduceMotion });');
    expect(compass).toContain("onLayout={message.role === 'user' ? (event: LayoutChangeEvent) => { turnTops.current.set(message.id, event.nativeEvent.layout.y); } : undefined}");
    // Keyboard lift is measured within the NativeTabs scene, not the window.
    expect(compass).toContain('const composerLift = anchoredComposerLift(');
    expect(compass).toContain('bottomSafeArea,');
  });
});

describe('owner correction (hard top edge, native tabs, clear composer edge)', () => {
  const ui = read('./ui.tsx');
  const pulse = read('../features/PulseScreen.tsx');

  it('mounts no top band on any surface that used to carry the ramp', () => {
    expect(ui).not.toMatch(/<OverlayTopBand/);
    expect(ui).not.toContain('export function OverlayTopBand');
    // Screen, the two Home drawers, the quick-actions drawer and a loaded
    // conversation all mounted the ramp until the owner removed it .
    for (const file of ['./ui.tsx', './HomeCarousel.tsx', './QuickActionsDrawer.tsx', '../../app/conversation/[id].tsx']) {
      expect(read(file), file).not.toContain('TopRamp');
    }
  });

  it('keeps the frosted capsule blurred on iOS with Reduce Transparency off, opaque everywhere else', () => {
    const ramp = read('./TopChrome.tsx');
    expect(ramp).toContain("import { BlurView } from 'expo-blur';");
    // No gradient band and no masked blur are drawn anywhere any more .
    expect(ramp).not.toContain('expo-linear-gradient');
    expect(ramp).not.toContain('masked-view');
    expect(ramp).toContain("return Platform.OS === 'ios' && !reduceTransparency;");
    // The floating controls keep their own frosted capsule, opaque where the
    // blur is not allowed.
    expect(ramp).toContain('if (!blurAllowed) {');
    expect(ramp).toContain('backgroundColor: theme.card');
    expect(ramp).toContain('withAlpha(theme.background, FROSTED_BACKING_OPACITY)');
    // Only this module crosses the native boundary.
    for (const file of ['./ui.tsx', './PinnedHeader.tsx', './HatSwitcher.tsx', './HomeCarousel.tsx', '../features/PulseScreen.tsx']) {
      expect(read(file), `${file} must reach the blur through TopChrome`).not.toContain("from 'expo-blur'");
    }
  });

  it('keeps page and pinned-header edges hard, with no viewport blur', () => {
    expect(ui).not.toContain("from './ChromeFade'");
    expect(ui).not.toContain('bandEdgeFade');
    const header = read('./PinnedHeader.tsx');
    expect(header).not.toContain("from './ChromeFade'");
    expect(header).not.toContain('edgeFade');
    // No edge at all: the title row's scrolled hairline is gone too
    // (UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118).
    expect(header).not.toContain('borderBottomWidth');
  });

  it('keeps the Guide transcript clear of the composer without a fade overlay', () => {
    const compass = read('./CompassPanel.tsx');
    expect(compass).not.toContain('ChromeFade');
    expect(compass).not.toContain('COMPOSER_SCRIM_HEIGHT');
    expect(compass).toContain('{ paddingBottom: composerHeight + CHROME_CLEARANCE }');
    expect(compass).toContain('threadRef.current?.scrollToEnd({ animated: !reduceMotion })');
  });

  it('leaves every tab root free of custom bottom scrims', () => {
    const layout = read('../../app/(tabs)/_layout.tsx');
    expect(layout).not.toContain('DockScrim');
    for (const file of TAB_ROOTS) {
      expect(read(file), `${file} must not mount a DockScrim`).not.toMatch(/<DockScrim/);
    }
  });
});

describe('pressed and selection response (P0-2)', () => {
  it('reads Reduce Motion from one shared helper', () => {
    expect(read('../lib/reduceMotion.ts')).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(read('../lib/reduceMotion.ts')).toContain('let enabled = true');
    expect(read('./HatSwitcher.tsx')).toContain('const reduceMotion = useReduceMotion()');
    expect(read('./HatSwitcher.tsx')).not.toContain('AccessibilityInfo');
  });

  it('snaps the hat switcher menu open and closed under Reduce Motion', () => {
    const hats = read('./HatSwitcher.tsx');
    const motion = read('../lib/hatSwitcherSheetMotion.ts');
    expect(hats).toContain('const reduceMotion = useReduceMotion()');
    expect(hats).not.toContain('AccessibilityInfo');
    expect(hats).toContain('if (!activeHat || reduceMotion) return;');
    expect(hats).toContain("import { HAT_MENU_CLOSE_MS, HAT_MENU_OPEN_MS, HAT_MENU_TRAVEL, closeHatSwitcherMenu, openHatSwitcherMenu } from '../lib/hatSwitcherSheetMotion'");
    expect(hats).toContain('openHatSwitcherMenu(menu, reduceMotion, () =>');
    expect(hats).toContain('closeHatSwitcherMenu(');
    expect(hats).toContain('Animated.timing(menu, { toValue: 1, duration: HAT_MENU_OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true })');
    expect(hats).toContain('Animated.timing(menu, { toValue: 0, duration: HAT_MENU_CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })');
    expect(hats.match(/}, \[menu, reduceMotion\]\);/g)?.length).toBe(2);
    // The direct timing calls above are the only ones, and both sit behind the
    // helper's Reduce Motion branch.
    expect(hats.match(/Animated\.timing\(menu,/g)?.length).toBe(2);
    expect(motion).toMatch(/if \(reduceMotion\) \{\s*menu\.setValue\(1\);\s*return;/);
    expect(motion).toMatch(/if \(reduceMotion\) \{\s*menu\.setValue\(0\);\s*dismiss\(\);\s*return;/);
  });
});

// P1 wave 1, item 3 (Codex  thread 3): one spring primitive owns the press
// response, and the shared Button and Card are driven by it rather than by
// per-component pressed styles.
describe('spring press primitive (P1-3)', () => {
  const press = read('./PressableScale.tsx');
  const ui = read('./ui.tsx');

  it('springs scale and shadow off a single value, calmly', () => {
    expect(press).toContain('export const PRESS_SPRING = { speed: 26, bounciness: 0 } as const');
    expect(press).toContain('export function usePressSpring');
    expect(press).toContain('export function PressableScale');
    expect(press).toContain('Animated.spring(press, { toValue, useNativeDriver: false, ...PRESS_SPRING })');
    expect(press).toContain('outputRange: [1, reduceMotion ? 1 : pressedScale]');
    expect(press).toContain('elevation.pressedShadow.shadowOpacity');
    expect(press).toContain('elevation.pressedShadow.shadowRadius');
    // No bounce: an overshooting button breaks the calm-iOS contract.
    expect(press).not.toMatch(/bounciness: [1-9]/);
  });

  it('applies the pressed values instantly under Reduce Motion', () => {
    expect(press).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(press).toMatch(/if \(reduceMotion\) \{\s*press\.setValue\(toValue\);\s*return;/);
  });

  it('drives the shared Button and Card, with no press styles left inline', () => {
    expect(ui).toContain("import { PressableScale, usePressSpring } from './PressableScale'");
    expect(ui).toContain('<PressableScale');
    expect(ui).toContain('const press = usePressSpring(pressed, resting)');
    // The old static press styles are gone from both components.
    expect(ui).not.toContain('transform: [{ scale: pressedScale }]');
    expect(ui).not.toContain('pressed && !disabled ? elevation.pressedShadow : null');
    expect(ui).not.toContain('pressed ? elevation.pressedShadow : null');
  });

  it('is applied only where a lane has migrated it', () => {
    // Pin widened by the Codex IA-A review: wave 1 migrated the shared Button
    // and Card, and the review added the Compass source rows, the More-sources
    // row, and the legal jump card header and rows. Everything else keeps its
    // existing opacity feedback until its own lane migrates it, so the
    // primitive still cannot be half-applied by accident.
    for (const file of ['./CompassPanel.tsx', '../features/LegalDocumentScreen.tsx']) {
      expect(read(file), `${file} consumes the shared press primitive`).toContain('<PressableScale');
    }
    for (const file of ['./HatSwitcher.tsx', './FunctionDeck.tsx', './WorkWidgets.tsx']) {
      expect(read(file), `${file} is out of scope for the P1 wave-1 migration`)
        .not.toContain('PressableScale');
    }
  });
});

// Codex IA-A review, item 2: expansion motion is a shared primitive, not a
// constant each screen re-files under its own name.
describe('shared in-place expansion primitive', () => {
  const expansion = read('../lib/expansion.ts');
  const EXPANDING_SCREENS = ['./CompassPanel.tsx', '../features/LegalDocumentScreen.tsx'];

  it('owns the one duration, the one curve, and the Reduce Motion branch', () => {
    expect(expansion).toContain('export const EXPAND_MS = 280;');
    expect(expansion).toContain('export function configureExpansion(reduceMotion: boolean): void');
    // No-op under Reduce Motion: the rows still arrive, without travel.
    expect(expansion).toMatch(/if \(reduceMotion\) return;/);
    expect(expansion).toContain('duration: EXPAND_MS,');
    expect(expansion).toContain('update: { type: LayoutAnimation.Types.easeOut },');
    expect(expansion).toContain('create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },');
  });

  it('is imported by both expanding screens, and no file-local *_EXPAND_MS survives', () => {
    for (const file of EXPANDING_SCREENS) {
      const source = read(file);
      expect(source, `${file} must import the shared expansion helper`)
        .toContain("import { configureExpansion } from '../lib/expansion'");
      expect(source, `${file} must call it rather than configuring its own`)
        .toContain('configureExpansion(reduceMotion)');
      expect(source, `${file} must not keep a one-off expansion constant`)
        .not.toMatch(/_EXPAND_MS/);
      // The Compass keyboard lift still queues its own LayoutAnimation, but no
      // screen may queue a second easeOut expansion beside the primitive.
      expect(source, `${file} must not queue its own expansion animation`)
        .not.toMatch(/LayoutAnimation\.Types\.easeOut/);
    }
  });
});

describe('one-off shadow constants are gone', () => {
  it('leaves no raw shadow literal in the tab-root screens', () => {
    for (const file of TAB_ROOTS) {
      const source = read(file);
      expect(source, `${file} must use elevation tokens, not raw shadows`).not.toMatch(/shadowOpacity:/);
      expect(source, `${file} must use elevation tokens, not raw shadows`).not.toMatch(/shadowRadius:/);
    }
  });

  it('routes the shared surfaces through the elevation module', () => {
    expect(read('../../app/(tabs)/_layout.tsx')).toContain('<NativeTabs');
    expect(read('./HatSwitcher.tsx')).toContain('...elevation.level2');
    // The deck is a level-3 surface, so its rows route through level 0.
    expect(read('./FunctionDeck.tsx')).toContain('...elevation.level0');
    expect(read('./HomeCarousel.tsx')).not.toMatch(/shadow(Color|Offset|Opacity|Radius):/);
    expect(read('../../app/(tabs)/home.tsx')).toContain('...elevation.level1');
  });
});

// Review finding 4: shared components must not carry one-off shadow literals
// either; elevation.ts is the single home for them.
const SHARED_COMPONENTS = [
  './HomeCarousel.tsx',
  './FunctionDeck.tsx',
  './WorkWidgets.tsx',
  './CompassPanel.tsx',
  './HatSwitcher.tsx',
  './PinnedHeader.tsx',
  './PressableScale.tsx',
  './StatusPill.tsx',
  './TransactionalAction.tsx',
  './ui.tsx',
];

describe('shared components carry no raw shadow literals', () => {
  for (const file of SHARED_COMPONENTS) {
    it(`${file} uses elevation tokens`, () => {
      const source = read(file);
      expect(source).not.toMatch(/shadowOpacity:\s*0\.\d/);
    });
  }
});

describe('screen inset pairing', () => {
  it('owns both insets itself instead of pairing with iOS automatic adjustment', () => {
    const ui = read('./ui.tsx');
    // The old code turned automatic adjustment off on some paths and relied on
    // it for the top padding on others, which is how a path could end up with
    // neither. Screen now supplies both paddings on every path.
    expect(ui).toContain('automaticallyAdjustContentInsets={false}');
    expect(ui).toContain('contentInsetAdjustmentBehavior="never"');
    expect(ui).toContain('{ paddingTop: topPadding, paddingBottom: bottomPadding }');
    expect(ui).not.toContain("contentInsetAdjustmentBehavior={overlayChrome");
  });
});

// P1 wave 1, item 5 (pass-4): a pushed surface with no dock still owes the home
// indicator its clearance, and the fallback must not degenerate on a device
// that reports no bottom inset.
describe('pushed-surface bottom inset (P1-5)', () => {
  const geometry = read('../lib/chromeGeometry.ts');
  const ui = read('./ui.tsx');

  it('adds the resting gap on top of the safe area, with a clearance floor', () => {
    expect(geometry).toContain('export const SCREEN_BOTTOM_GAP = 32');
    expect(geometry).toContain('export function screenBottomInset(safeAreaBottom: number): number');
    expect(geometry).toContain('return Math.max(safeAreaBottom, CHROME_CLEARANCE) + SCREEN_BOTTOM_GAP');
  });

  it('applies unconditionally to every non-dock Screen', () => {
    expect(ui).toContain('const bottomPadding = bottomInset ?? screenBottomInset(insets.bottom)');
    // The old gate is what let a surface fall through to the page padding.
    expect(ui).not.toContain('pinned || overlayChrome ? insets.bottom + spacing.xxl');
  });
});

// ---------------------------------------------------------------------------
// P1 wave 1 (docs/mobile/lovable-exhaustive/batches/pass4-verification.md)
// ---------------------------------------------------------------------------

describe('hard-edged primary chrome (P1-1)', () => {
  const ui = read('./ui.tsx');
  const header = read('./PinnedHeader.tsx');

  it('keeps the top treatment to the ramp alone, with no second fade', () => {
    expect(ui).not.toContain('statusBarBacking');
    expect(ui).not.toContain('ChromeFade');
    expect(ui).not.toContain('ChromeSurfaceFade');
    expect(header).not.toContain('PORCELAIN_OPACITY');
    expect(header).not.toContain('ChromeFade');
    expect(header).not.toContain('ChromeSurfaceFade');
  });

  it('does not host scrolling surface tint in primary chrome owners', () => {
    expect(ui).not.toContain('useChromeSurfaceHost');
    expect(ui).not.toContain('ChromeSurfaceProvider');
    expect(header).not.toContain('useChromeSurfaceHost');
    expect(header).not.toContain('ChromeSurfaceProvider');
  });

  it('removes artifacting tint registration from Messages and Activity', () => {
    const messages = read('../../app/messages.tsx');
    const activity = read('../../app/notifications.tsx');
    expect(messages).not.toContain('ChromeSurfaceBand');
    expect(activity).not.toContain('ChromeSurfaceBand');
    expect(activity).toContain('<View style={[styles.headerBand, { backgroundColor: theme.primary }]}>');
    for (const file of TAB_ROOTS) {
      expect(read(file), `${file} must not declare a tinted chrome band`).not.toContain('ChromeSurfaceBand');
    }
  });
});

describe('Guide Reduce Motion and ramp clearance (P1-2)', () => {
  const compass = read('./CompassPanel.tsx');

  it('reads the shared Reduce Motion helper and never animates against it', () => {
    expect(compass).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(compass).toContain('const reduceMotion = useReduceMotion()');
    expect(compass).not.toContain('scrollToEnd({ animated: true })');
    expect(compass.match(/scrollToEnd\(\{ animated: !reduceMotion \}\)/g)?.length).toBe(2);
  });

  it('follows the transcript to the end when the keyboard lifts the ramp', () => {
    expect(compass).toContain('if (keyboardOverlap <= 0) return;');
    expect(compass).toMatch(/}, \[keyboardOverlap, composerHeight, reduceMotion\]\);/);
  });

  it('pads the transcript past the composer without adding a ramp', () => {
    expect(compass).toContain('{ paddingBottom: composerHeight + CHROME_CLEARANCE }');
    expect(compass).not.toContain('COMPOSER_SCRIM_HEIGHT');
    expect(compass).not.toContain('ChromeFade');
    expect(compass).toContain('const composerLift = anchoredComposerLift(');
    expect(compass).not.toContain('style={{ bottom: composerLift + composerHeight }}');
  });

  it('follows composer growth with a fresh scroll-to-end', () => {
    const compass = read('./CompassPanel.tsx');
    expect(compass).toMatch(/\[keyboardOverlap, composerHeight, reduceMotion\]/);
  });
});

describe('pinned header back fallback (P1-4)', () => {
  const header = read('./PinnedHeader.tsx');

  it('replaces into Home when there is nothing to pop', () => {
    expect(header).toContain("export const BACK_FALLBACK_ROUTE = '/(tabs)/home'");
    expect(header).toMatch(/if \(router\.canGoBack\(\)\) \{\s*router\.back\(\);\s*return;\s*\}\s*router\.replace\(BACK_FALLBACK_ROUTE\);/);
    // replace, not push: the protected surface must leave the history stack,
    // and Home never selects a hat the user did not choose.
    expect(header).not.toContain('router.push(BACK_FALLBACK_ROUTE)');
  });

  it('keeps the VoiceOver label honest about where the control goes', () => {
    expect(header).toContain("const backLabel = nativeUiText(language)(onBack || canGoBack ? 'Back' : 'Home')");
    expect(header).toContain('accessibilityLabel={backLabel}');
  });
});

// Visual-language brief §B: gold is a fill, bar, badge, tile or stroke role.
// Gold letters are allowed only on a dark-gold or aubergine fill, never on
// porcelain (b05-3).
const GOLD_TEXT = /(?<![A-Za-z])color:\s*(theme\.(?:accent|compass)|NIGHT\.(?:gold|amber)|BAR\.(?:gold|goldHi)|'#(?:D9A441|8A6414|F2C879)')(?![A-Za-z])/;

const GOLD_SCAN_FILES = [
  '../../app/(tabs)/home.tsx',
  '../../app/messages.tsx',
  '../features/PulseScreen.tsx',
  '../features/WorkScreen.tsx',
  '../../app/(tabs)/campaign.tsx',
  '../../app/(tabs)/account.tsx',
  '../../app/channel/[id].tsx',
  './ChannelPollCard.tsx',
  '../../app/conversation/[id].tsx',
  '../../app/issue/[id].tsx',
  '../../app/notifications.tsx',
  './CompassPanel.tsx',
  './WorkWidgets.tsx',
  './FunctionDeck.tsx',
  './ui.tsx',
];

// A text role is either an inline colour on a <Text>, or a StyleSheet entry
// that sizes type. Both forms are checked, because the four named offenders
// used one each.
function goldTextRoles(source: string): string[] {
  return source.split('\n').filter((line) => (
    GOLD_TEXT.test(line) && (line.includes('<Text') || line.includes('fontSize'))
  ));
}

describe('gold text roles (P1-6, b05-3)', () => {
  it('leaves no gold foreground text on a porcelain surface', () => {
    for (const file of GOLD_SCAN_FILES) {
      expect(goldTextRoles(read(file)), `${file} paints gold as text`).toEqual([]);
    }
  });

  it('repairs the four reviewed offenders by name', () => {
    const channel = read('../../app/channel/[id].tsx');
    const pulse = read('../features/PulseScreen.tsx');
    // Channel "LIVE POLL" eyebrow and the thread hint read in aubergine.
    const pollCard = read('./ChannelPollCard.tsx');
    expect(channel).toContain('<ChannelPollCard poll={poll}');
    expect(pollCard).toContain('styles.pollLabel, { color: theme.primary }');
    // BUG-UG-NATIVE-MESSAGE-INERT-CONTROLS-20260904 tightened this further:
    // the reply count is status text, not an action, so it reads in the muted
    // foreground rather than the accent that made it look like a link.
    expect(channel).toContain('style={[styles.threadHint, { color: theme.mutedForeground }]}');
    expect(channel + pollCard).not.toMatch(/styles\.(pollLabel|threadHint), \{ color: theme\.compass/);
    expect(channel).not.toMatch(/styles\.threadHint, \{ color: theme\.primary/);
    // Pulse hero subtitle and agenda status words read in aubergine and ink.
    expect(pulse).toContain('<Text style={styles.heroStatus}>STRONG</Text>');
    expect(pulse).toMatch(/heroStatus: \{ color: NIGHT\.mint/);
    expect(pulse).toMatch(/segStatus: \{ color: NIGHT\.ink/);
  });

  it('keeps gold fills, dots, bars and strokes untouched', () => {
    const channel = read('./ChannelPollCard.tsx');
    expect(channel).toContain('styles.liveDot, { backgroundColor: theme.compass }');
    expect(channel).toContain('borderLeftColor: theme.accent');
    // Gold letters are fine on a gold fill: the Compass badge is filled now.
    expect(read('./CompassPanel.tsx')).toContain('{ backgroundColor: theme.compass, borderColor: theme.compass }');
    expect(read('./CompassPanel.tsx')).toContain('{ color: theme.compassForeground }');
  });
});

// ---------------------------------------------------------------------------
// P1 wave 2a (b02a-17 elevation ladder + the icon-role audit)
// ---------------------------------------------------------------------------

// The external verdict on wave 1: "L1 cards, L2 controls and L3 drawer rows are
// still rendered at the same weight, so depth is not yet carrying hierarchy."
// The repair is application, not new tokens: a level-3 surface owns the shadow
// and its own contents go flat.
describe('elevation ladder application (b02a-17)', () => {
  const carousel = read('./HomeCarousel.tsx');
  const deck = read('./FunctionDeck.tsx');
  const work = read('./WorkWidgets.tsx');
  const hats = read('./HatSwitcher.tsx');
  const home = read('../../app/(tabs)/home.tsx');

  it('flattens the drawer contents: no level-1 card shadow inside a level-3 drawer', () => {
    // The features deck: shortcut circles separate by hairline and fill only.
    expect(deck).toContain('...elevation.level0');
    expect(deck).not.toContain('...elevation.level1');
    expect(deck).toContain("rowDivider: {\n    height: StyleSheet.hairlineWidth,");
    expect(deck).toContain('borderWidth: StyleSheet.hairlineWidth');
    // The Work drawer's widgets never carried a shadow and must not grow one.
    expect(work).not.toContain("from '../theme/elevation'");
    expect(work).not.toMatch(/shadow(Color|Offset|Opacity|Radius):/);
    expect(work).not.toMatch(/\belevation:\s*\d/);
  });

  it('gives the drawer canvas the dimmer, unelevated under-layer both sides', () => {
    // Brief §E: the under-layer sits on an unelevated, dimmer canvas. The
    // features deck already used theme.muted; the Work drawer matches it now.
    expect(deck).toContain("backgroundColor: theme.muted");
    expect(carousel).toContain('backgroundColor: theme.muted,');
    expect(carousel).toContain('style={{ width, backgroundColor: theme.muted }}');
    expect(carousel).not.toContain('backgroundColor: theme.background,\n          width: drawerWidth');
  });

  it('defines one clipped Home sheet without a false third-page edge', () => {
    //  owner ruling: a rounded panel with a shadow. The facing-edge
    // hairline and its painted fade read as the frame of a second screen.
    expect(carousel).not.toContain('DrawerFacingEdge');
    expect(carousel).not.toContain('facingEdgeGeometry');
    expect(carousel).toContain("homeCardClip: { flex: 1, overflow: 'hidden' },");
    expect(carousel).not.toContain('borderWidth: 1 },');
    expect(carousel).not.toContain('borderLeftWidth: visibleDrawer');
    expect(carousel).not.toContain('borderRightWidth: visibleDrawer');
    expect(carousel).not.toContain('elevation: progress.interpolate');
    expect(carousel).not.toContain('shadowOffset: { width:');
    expect(carousel).not.toMatch(/transform: \[\{ translateX \}, \{ scale:/);
  });

  it('interpolates each facing edge continuously, and stands still under Reduce Motion', () => {
    // Each direction owns its radius and edge opacity from the first drag
    // pixel. The opposite, top and bottom edges therefore stay flush rather
    // than exposing a scaled under-canvas or switching at the 8px threshold.
    expect(carousel).toContain('const frame = drawerFrame(renderOffset, drawerWidth, HOME_CARD_RADIUS);');
    expect(carousel).toContain('const featureCornerRadius = frame.featureRadius;');
    expect(carousel).toContain('const workCornerRadius = frame.workRadius;');
    expect(carousel).not.toContain('translateX.interpolate');
    expect(carousel).toContain('borderTopLeftRadius: featureCornerRadius');
    expect(carousel).toContain('borderTopRightRadius: workCornerRadius');
    expect(carousel).not.toContain('HOME_CARD_LIFT_SCALE');
    // The binary radius the interpolation replaced.
    expect(carousel).not.toContain('borderTopLeftRadius: HOME_CARD_RADIUS');
    // Animated radii have no native-driver equivalent, so travel and curve
    // continue to settle together on the JS driver.
    expect(carousel).toContain('useNativeDriver: false,');
    // Reduce Motion is the instant swap every other motion primitive takes,
    // read from the one shared probe.
    expect(carousel).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    // …and read through a ref, not the render closure: the pan responder is
    // memoised on the geometry alone, so a `snapTo` closing over the state
    // would keep animating for a member who enabled Reduce Motion mid-session.
    expect(carousel).toContain('const reduceMotionRef = useRef(reduceMotion);');
    expect(carousel).toContain('reduceMotionRef.current = reduceMotion;');
    expect(carousel).toMatch(/if \(reduceMotionRef\.current\) \{\s*translateX\.setValue\(destination\);/);
    expect(carousel).not.toMatch(/if \(reduceMotion\) \{\s*translateX\.setValue\(destination\);/);
  });

  it('raises the hat dropdown to level 3, rows flat, and keeps the pill transparent', () => {
    expect(hats).toMatch(/\n  menu: \{[\s\S]*?borderRadius: radii\.md,[\s\S]*?\.\.\.elevation\.level3,\s*\},/);
    // A dropdown is not a bottom sheet: no sheet radius, no grabber, no Modal.
    expect(hats).not.toContain('sheetRadius');
    expect(hats).not.toContain('grabber');
    expect(hats).not.toContain('<Modal');
    // The rows inside it stay flat: fill and radius only, no elevation pass.
    const row = hats.match(/\n  row: \{[\s\S]*?\n  \},/)?.[0] ?? '';
    expect(row).not.toBe('');
    expect(row).not.toContain('elevation');
    expect(row).not.toContain('shadow');
    // The pill is a floating control over content now, so it keeps the level-2
    // lift on every path and takes its fill from the shared frosted capsule.
    expect(hats).toContain('pill: { height: PILL_HEIGHT, ...elevation.level2 },');
    expect(hats).not.toContain('pillOpaque');
    expect(hats).not.toContain("backgroundColor: 'transparent'");
  });

  it('gives each Home surface exactly one hero and leaves every other card at level 1', () => {
    // IA wave B: the hero pass is named once on this surface and the two
    // objects that can wear it are mutually exclusive, so "exactly one hero"
    // is now enforced by construction rather than by counting declarations.
    expect(home.match(/elevation\.level1Hero\w*/g)?.length).toBe(1);
    expect(home).toContain('const HERO_PASS = elevation.level1HeroLift;');
    // Preview surface: the KPI band on the member hat, the desk shortcut on a
    // staff hat — never both (b03a-6/13).
    expect(home).toContain('style={[styles.statBand, staffHat ? elevation.level1 : HERO_PASS]}');
    expect(home).toMatch(/deskHero: \{[\s\S]*?\.\.\.HERO_PASS,/);
    // The band wears the hero, not each of its four cells: four identical hero
    // cards were four competing heroes (p1-wave2a "statRow-level hero").
    expect(home).not.toMatch(/stat: \{[^}]*elevation\.level1Hero/);
    // Authenticated surface: the Next-up card.
    expect(home.match(/<Card hero/g)?.length).toBe(1);
    expect(home).toContain('<Card hero pressed={pressed}>');
    // The MY UNION / TODAY cards and the header buttons keep the contact pass.
    expect(home).toMatch(/card: \{[^}]*\.\.\.elevation\.level1 \}/);
    expect(home).toMatch(/iconBtn: \{[\s\S]*?\.\.\.elevation\.level1,/);
    // And no second hero anywhere else on a tab root.
    for (const file of TAB_ROOTS) {
      if (file.endsWith('home.tsx')) continue;
      const source = read(file);
      expect(source, `${file} must not declare a second hero`).not.toContain('level1Hero');
      expect(source, `${file} must not declare a second hero`).not.toContain('<Card hero');
    }
  });

  it('lifts the hero pass by one blur step without touching the briefed ladder', () => {
    // p1-wave2a P2 disposition on b02a-17: the briefed hero cast only 2-3 RGB
    // steps of underside ramp, so the disposition allowed "one blur step or a
    // 1px top edge highlight". A white card on porcelain has nothing lighter
    // than its own fill to highlight with, so the ladder's answer is the blur.
    const tokens = read('../theme/elevation.ts');
    expect(tokens).toContain('export const level1HeroLift: ElevationToken = {');
    // The lift is derived, not retyped: the hero's own offset and opacity — the
    // two numbers brief §A pins — with the next rung's blur.
    expect(tokens).toContain('...level1Hero,');
    expect(tokens).toContain('shadowRadius: level2.shadowRadius,');
    // And the briefed hero token itself is untouched (the ladder test above
    // still reads its exact values).
    expect(tokens).toMatch(/export const level1Hero: ElevationToken = \{[\s\S]*?shadowRadius: 24,/);
    // The shared hero role consumes it, so no screen picks the rung by hand.
    expect(read('./ui.tsx')).toContain('const resting = hero ? elevation.level1HeroLift : elevation.level1;');
  });
});

// Icon-role audit: a glyph that carries meaning is a non-text element and owes
// 3:1 against the fill it sits on (the Activity vote icon computed 1.89:1).
// Reuse the shipped luminance math so this suite cannot drift from the
// contrast audit (review finding on).
const ICON_CONTRAST_FLOOR = 3;

const ratio = contrastRatio;

const palette = JSON.parse(read('../theme/palette.json')) as Record<string, Record<string, string>>;
const themeModes = Object.keys(palette);

describe('meaningful icon glyphs clear the 3:1 non-text floor', () => {
  it('proves the pairing the Activity vote icon used to ship', () => {
    // Gold glyph on the lavender secondary fill — the reported 1.89:1.
    expect(ratio(palette['union-ground']!.secondary!, palette['union-ground']!.accent!)).toBeLessThan(ICON_CONTRAST_FLOOR);
  });

  it('inverts the vote icon to a gold fill with the palette dark-gold ink', () => {
    const activity = read('../../app/notifications.tsx');
    expect(activity).toContain("case 'vote': return { fill: theme.accent, glyph: theme.accentForeground };");
    expect(activity).toContain('backgroundColor: tint.fill');
    expect(activity).toContain('color={tint.glyph}');
    // The old single-colour tint on a fixed secondary chip is gone.
    expect(activity).not.toContain("issue 'vote': return theme.accent;");
    expect(activity).not.toContain('[styles.icon, { backgroundColor: theme.secondary }]');
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      expect(ratio(tokens.accent!, tokens.accentForeground!), `${mode} vote glyph`)
        .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
    }
  });

  it('keeps the other Activity kinds on pairings that already clear the floor', () => {
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      for (const glyph of ['compass', 'primary', 'secondaryForeground'] as const) {
        expect(ratio(tokens.secondary!, tokens[glyph]!), `${mode} ${glyph} on secondary`)
          .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      }
    }
  });

  it('keeps every Home tile on an audited semantic fill/foreground pair', () => {
    const home = read('../../app/(tabs)/home.tsx');
    expect(home).toContain('color={tile.glyph}');
    for (const [fill, glyph] of [
      ['primary', 'primaryForeground'],
      ['accent', 'accentForeground'],
      ['secondary', 'secondaryForeground'],
      ['compass', 'compassForeground'],
    ] as const) {
      expect(home).toContain(`color: theme.${fill}`);
      expect(home).toContain(`glyph: theme.${glyph}`);
      for (const mode of themeModes) {
        expect(ratio(palette[mode]![fill]!, palette[mode]![glyph]!), `${mode} Home ${fill} tile`)
          .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      }
    }
  });

  it('leaves the decorative and already-compliant gold glyphs alone', () => {
    // Compass attribution sparkle: dark gold on porcelain, well over the floor.
    expect(read('./CompassPanel.tsx')).toContain('<Ionicons name="sparkles" size={14} color={theme.compass}');
    expect(ratio(palette['union-ground']!.background!, palette['union-ground']!.compass!))
      .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
    // The Work pulse chip already inverts to gold fill + dark ink.
    expect(read('../features/WorkScreen.tsx')).toContain('color={theme.accentForeground}');
  });
});

// ---------------------------------------------------------------------------
// P1 wave 2b (triage P1-4 row/pill grammar + P1-5 transactional primitive)
// ---------------------------------------------------------------------------

describe('status pill primitive and state ramp (P1-4, brief §C)', () => {
  const pill = read('./StatusPill.tsx');
  const ramp = read('../theme/statusRamp.ts');
  const ui = read('./ui.tsx');

  it('ships the briefed anatomy: 22-24px capsule, 6px dot, sentence issue', () => {
    expect(pill).toContain('export const STATUS_PILL_HEIGHT = 24');
    expect(pill).toContain('export const STATUS_PILL_DOT = 6');
    expect(pill).toContain('borderRadius: radii.pill');
    expect(pill).toContain('export function sentenceCase');
    // The old pill capitalised every word, which is title case, not the
    // sentence case the brief asks for.
    expect(pill).not.toContain("textTransform: 'capitalize'");
  });

  it('lets the dot carry the hue while the body stays a tinted neutral', () => {
    expect(pill).toContain('style={[styles.pill, { backgroundColor: theme.muted }]}');
    expect(pill).toContain('{ backgroundColor: statusRamp(theme)[resolved] },');
    // One saturated fill per row: the pill body never takes a state fill.
    expect(pill).not.toMatch(/styles\.pill, \{ backgroundColor: theme\.(primary|accent|compass)/);
    // The hue only restates the label, so it is never announced on its own.
    expect(pill).toContain('accessibilityElementsHidden');
  });

  it('gives attention — and only attention — a second, non-colour channel (w2b-2)', () => {
    // ~6px of copper was the whole cue at board glance, so the state now also
    // differs in size and carries a stroke.
    expect(pill).toContain('export const STATUS_PILL_ATTENTION_DOT = 8');
    expect(pill).toContain('export const STATUS_PILL_ATTENTION_RING = 1');
    // The palette key is named once, in the ramp module, and the component
    // reads the theme through that name — the export the audit rows quote is
    // the export the pill consumes, so the two cannot drift apart.
    expect(pill).toContain("import { STATUS_ATTENTION_RING_TOKEN, statusRamp, statusStateForLabel");
    expect(pill).toContain("resolved === 'attention' ? [styles.attentionDot, { borderColor: theme[STATUS_ATTENTION_RING_TOKEN] }] : null,");
    expect(pill).toContain('borderWidth: STATUS_PILL_ATTENTION_RING');
    // The ring is a palette token, never a component tint.
    expect(pill).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    // No other state is ringed: two ringed states are no channel at all.
    expect(pill.match(/styles\.attentionDot/g)?.length).toBe(1);
  });

  it('audits the attention ring as its own ramp token', () => {
    expect(ramp).toContain("export const STATUS_ATTENTION_RING_TOKEN = 'statusAttentionRing'");
    // Not a dead export (P2 follow-up): StatusPill is its consumer.
    expect(read('./StatusPill.tsx')).toContain('theme[STATUS_ATTENTION_RING_TOKEN]');
    expect(palette['union-ground']!.statusAttention).toBe('#8A5A00');
    expect(palette['union-ground']!.statusAttentionRing).toBe('#4E3505');
    const audit = read('../../scripts/contrast-audit.mjs');
    expect(audit).toContain("['muted', 'statusAttentionRing', 3,");
    expect(audit).toContain("['statusAttention', 'statusAttentionRing', 1.5,");
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      // Visible on the body it sits on, and visibly not the dot it encircles.
      expect(ratio(tokens.muted!, tokens.statusAttentionRing!), `${mode} ring on the pill body`)
        .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      expect(ratio(tokens.statusAttention!, tokens.statusAttentionRing!), `${mode} ring against its dot`)
        .toBeGreaterThanOrEqual(1.5);
      const ringBodyContrast = ratio(tokens.muted!, tokens.statusAttentionRing!);
      const dotBodyContrast = ratio(tokens.muted!, tokens.statusAttention!);
      if (mode === 'union-ground-dark') {
        expect(ringBodyContrast, `${mode} lighter ring moves toward its dark pill body`)
          .toBeLessThan(dotBodyContrast);
      } else {
        expect(ringBodyContrast, `${mode} darker ring moves away from its light pill body`)
          .toBeGreaterThan(dotBodyContrast);
      }
    }
  });

  it('keeps active and attention apart in both schemes (F6)', () => {
    // The dark scheme ran both states through the gold family, 1.43:1 apart:
    // one hue at two lightnesses, which is not two states.
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      expect(ratio(tokens.statusActive!, tokens.statusAttention!), `${mode} active vs attention`)
        .toBeGreaterThanOrEqual(1.7);
    }
    expect(palette['union-ground-dark']!.statusAttention).not.toBe(palette['union-ground-dark']!.accent);
    expect(read('../../scripts/contrast-audit.mjs')).toContain("['statusActive', 'statusAttention', 1.7,");
  });

  it('names the four ramp states as palette tokens, not component literals', () => {
    expect(ramp).toContain("export type StatusState = 'active' | 'attention' | 'queued' | 'done'");
    expect(STATUS_RAMP_TOKENS).toEqual({
      active: 'statusActive',
      attention: 'statusAttention',
      queued: 'statusQueued',
      done: 'statusDone',
    });
    expect(ramp).not.toMatch(/#[0-9A-Fa-f]{6}/);
    for (const token of Object.values(STATUS_RAMP_TOKENS)) {
      for (const mode of themeModes) {
        expect(palette[mode]![token], `${mode}.${token}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('keeps every ramp dot legible on the pill body it sits on', () => {
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      for (const token of Object.values(STATUS_RAMP_TOKENS)) {
        expect(ratio(tokens.muted!, tokens[token]!), `${mode} ${token} dot on the pill body`)
          .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      }
    }
    // Why the ramp is its own token set rather than aliases: the raw accent
    // gold and the lavender secondary fill both disappear at dot size, which is
    // the defect the Activity icon-role audit already repaired once.
    expect(ratio(palette['union-ground']!.muted!, palette['union-ground']!.accent!)).toBeLessThan(ICON_CONTRAST_FLOOR);
    expect(ratio(palette['union-ground']!.muted!, palette['union-ground']!.secondary!)).toBeLessThan(ICON_CONTRAST_FLOOR);
  });

  it('resolves free-text record statuses with a closed word list', () => {
    expect(statusStateForLabel('Active')).toBe('active');
    expect(statusStateForLabel('overdue')).toBe('attention');
    expect(statusStateForLabel('Resolved')).toBe('done');
    // "Preview" contains "review": a substring rule would file the My union
    // chapter pill as needing attention.
    expect(statusStateForLabel('Preview')).toBe('queued');
    expect(statusStateForLabel('Committee review')).toBe('attention');
  });

  it('files the words the record vocabulary actually ships (F7)', () => {
    // Filed before any broad sweep: these four fell through to "active", which
    // is the state that carries no emphasis — an approved handshake stayed on
    // the board as live work and a due-soon task lost its copper entirely.
    expect(statusStateForLabel('Attention')).toBe('attention');
    expect(statusStateForLabel('Due soon')).toBe('attention');
    expect(statusStateForLabel('Approved')).toBe('done');
    expect(statusStateForLabel('Confirmed')).toBe('done');
    // Still a closed word list, not a substring rule.
    expect(statusStateForLabel('Approved with conditions')).toBe('active');
    expect(statusStateForLabel('Due')).toBe('active');
  });

  it('extends the shipped component instead of duplicating it', () => {
    expect(ui).toContain("export { StatusPill } from './StatusPill'");
    expect(ui).not.toContain('export function StatusPill');
    // Both existing call sites keep importing it from the ui module.
    expect(read('../../app/issue/[id].tsx')).toContain('<StatusPill label={item.status} />');
    expect(read('../../app/(tabs)/campaign.tsx')).toContain('<StatusPill label="Current" />');
  });

  it('migrates the Work board column headers onto the ramp', () => {
    const work = read('../features/WorkScreen.tsx');
    expect(work).toContain("import { StatusPill } from '../components/StatusPill'");
    expect(work).toContain('<StatusPill label={column.label} state={column.state} />');
    expect(work).toContain("{ key: 'review', label: 'Committee review', state: 'attention'");
    expect(work).toContain("{ key: 'active', label: 'Organizing', state: 'active'");
    expect(work).toContain("{ key: 'done', label: 'Resolved', state: 'done'");
    // The three competing saturated pill fills are gone.
    expect(work).not.toContain('columnPillColors');
    expect(work).not.toContain('boardPillText');
  });

  it('leaves the broad sweep to a later wave', () => {
    // Only the named surfaces migrate here; a half-swept screen would be worse
    // than an unswept one.
    for (const file of ['./WorkWidgets.tsx', './FunctionDeck.tsx', '../../app/(tabs)/home.tsx']) {
      expect(read(file), `${file} is out of scope for the wave-2b pill migration`)
        .not.toContain('StatusPill');
    }
  });
});

describe('single unread encoding (P1-4, b05-4 and b02b-29)', () => {
  const messages = read('../../app/messages.tsx');
  const activity = read('../../app/notifications.tsx');

  it('uses native messaging hierarchy for unread rows', () => {
    expect(messages.match(/styles\.badge,/g)?.length).toBe(1);
    expect(messages).toContain('<View style={[styles.badge, { backgroundColor: theme.primary }]}>');
    expect(messages).toContain("fontWeight: item.unread ? '800' : '700'");
    expect(messages).toContain("fontWeight: item.unread ? '600' : '400'");
    expect(messages).toContain("rowTitle: { flex: 1, fontSize: 16.5, lineHeight: 22, ...typeface.controlStrong }");
  });

  it('keeps texting rows free of web-list chevrons', () => {
    // The chevrons belong to the two explicit actions above the inbox,
    // "Message your steward" and "Write to an officer", which share
    // one style; inbox rows themselves use the familiar full-row tap target.
    expect(messages.match(/name="chevron-forward"/g)?.length).toBe(2);
    expect(messages.match(/styles\.stewardAction[\s\S]*?name="chevron-forward"/g)?.length).toBe(2);
    expect(messages).toContain('styles.rowMetaLine');
  });

  it('replaces invented shortcut counts with backed inbox filters', () => {
    expect(messages).toContain('MESSAGE_FILTERS.map((key) =>');
    expect(messages).toContain('filterCounts[key]');
    expect(messages).toContain('accessibilityState={{ selected }}');
    expect(messages).not.toContain("label: 'Threads'");
    expect(messages).not.toContain("label: 'Huddles'");
    expect(messages).not.toContain("label: 'Drafts'");
  });

  it('keeps the Activity dot and drops the competing title weight', () => {
    // An update carries no count, and the dot pairs with the kind glyph, so the
    // dot is the encoding that survives.
    expect(activity).toContain('accessibilityLabel={unreadLabel} />');
    expect(activity).toContain('unreadLabel={copy.unread}');
    expect(activity).toContain("rowTitle: { fontSize: 16, lineHeight: 22, ...typeface.control }");
    // New rows used a 17px/700 heading beside the dot; New and Earlier rows
    // now share one title style.
    expect(activity).not.toContain('<Heading level={3}>{item.title}</Heading>');
    expect(activity).not.toContain('earlierTitle');
    expect(activity.match(/style=\{\[styles\.rowTitle\b/g)?.length).toBe(3);
    // The title is still a header for VoiceOver.
    expect(activity).toContain('<Text accessibilityRole="header" style={[styles.rowTitle, styles.flex,');
  });
});

describe('transactional primitive (P1-5, b04a roll-up)', () => {
  const primitive = read('./TransactionalAction.tsx');
  const ui = read('./ui.tsx');
  const feature = read('../features/FeatureScreen.tsx');

  it('puts the spinner inside the control that was pressed', () => {
    expect(ui).toContain('busy = false');
    expect(ui).toContain('const inert = disabled || busy');
    // A radio option (selected set) adds its selected state; busy stays exposed either way.
    expect(ui).toContain('accessibilityState={selected === undefined ? { disabled: inert, busy } : { disabled: inert, busy, selected }}');
    expect(ui).toMatch(/\{busy\s*\n?\s*\? <ActivityIndicator size="small"/);
    expect(primitive).toContain('busy={action.busy}');
    // A second press while the write is in flight must not start a second one.
    expect(primitive).toContain('if (running.current) return;');
    // A synchronous write settles in the same batch instead of flashing a
    // spinner for one frame and mounting its confirmation a tick early.
    expect(primitive).toContain('if (!(result instanceof Promise)) {');
    expect(primitive).toContain("setStatus('busy');");
  });

  it('confirms with a 44px row and one shared entrance', () => {
    expect(primitive).toContain('export const CONFIRMATION_ROW_HEIGHT = 44');
    expect(primitive).toContain('minHeight: CONFIRMATION_ROW_HEIGHT');
    expect(primitive).toContain('<Ionicons name="checkmark-circle"');
    expect(primitive).toContain('export const ENTER_SPRING = { speed: 18, bounciness: 0 } as const');
    // Calm spring, same rule as the press primitive: nothing overshoots.
    expect(primitive).not.toMatch(/bounciness: [1-9]/);
    // The tinted fill alone measured 1.19:1 on the white card (w2b-9), so the
    // field takes the same level-1 hairline every card and row carries.
    expect(primitive).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(primitive).toContain('{ backgroundColor: theme.secondary, borderColor: theme.border }');
  });

  it('speaks the arrival once, on every platform (F1)', () => {
    // `accessibilityLiveRegion` is Android-only: on iOS the confirmation
    // landed silently. The announcement is the primitive's, so no screen can
    // forget it and none can double it.
    // IA wave B ( follow-up 5): a second surface — the Be heard submit
    // condition line — needed the same iOS path, so the per-platform branch
    // moved into one module and both callers speak through it.
    const announce = read('../lib/announce.ts');
    expect(primitive).toContain("import { queueAccessibilityAnnouncement } from '../lib/announce'");
    expect(primitive).toContain('return queueAccessibilityAnnouncement(');
    expect(announce).toContain('export function announceForAccessibility(message: string): void {');
    expect(announce).toContain('AccessibilityInfo.announceForAccessibility(message)');
    // iOS queues behind whatever VoiceOver is still saying instead of cutting
    // it off; `queue` is an iOS-only option, so the branch is explicit.
    expect(announce).toContain("if (Platform.OS === 'ios') {");
    expect(announce).toContain('AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });');
    // No screen may grow a second announcement path beside it.
    for (const file of ['./CompassPanel.tsx', './TransactionalAction.tsx', '../features/FeatureScreen.tsx']) {
      expect(read(file), `${file} must announce through the shared helper`)
        .not.toContain('AccessibilityInfo.announceForAccessibility');
    }
    expect(primitive).toContain('export function useTransactionalEntrance(enabled = true, announcement?: string)');
    expect(primitive).toContain('const entrance = useTransactionalEntrance(enabled, message);');
    expect(primitive).toContain('const entrance = useTransactionalEntrance(enabled, announce);');
    // One effect lifetime per arrival, with a retry identity and cancellation
    // cleanup independent of the Reduce Motion animation branch.
    expect(primitive).toContain('const announcementAttempt = useRef(0);');
    expect(primitive).toContain('`transactional-arrival:${++announcementAttempt.current}`');
    expect(primitive).toContain('}, [announcement, enabled]);');
    // A second mechanism on the same row would speak it twice on Android.
    expect(primitive).not.toMatch(/accessibilityLiveRegion=/);
    // The reveal arrivals say the artifact's own words, never new copy — with
    // the printed interpunct spoken as the pause it draws.
    expect(feature).toContain('announce={`Submitted. ${title}. In review with the committee.`}');
    expect(feature).toContain("announce={`${item.dateLabel}. ${item.meta.split(' · ').join(', ')}`}");
    expect(feature).not.toContain('announce={`${item.dateLabel}. ${item.meta}`}');
    // The live ballot's receipt is an arrival too, and it announces the
    // receipt alone: a spoken selection is a broken secret ballot.
    expect(feature).toContain('<TransactionalReveal enabled={cast.done} announce={`Recorded. Receipt ${ballot.receiptCode}.`}>');
    expect(feature).not.toMatch(/announce=\{`[^`]*\$\{choice\}/);
    // Sign-in, MFA, and Compass pause keep an Android live region for the
    // persistent error copy. The helper's Android path would speak the same
    // text a second time, so those three surfaces gate the helper to iOS.
    const signIn = read('../../app/sign-in.tsx');
    const mfa = read('../../app/mfa-challenge.tsx');
    const compass = read('./CompassPanel.tsx');
    expect(signIn).toContain("if (Platform.OS === 'ios') announceForAccessibility(text)");
    expect(signIn).toContain('accessibilityLiveRegion="polite"');
    expect(mfa).toContain('const translated = catalogLabel(text);');
    expect(mfa).toContain("if (Platform.OS === 'ios') announceForAccessibility(translated)");
    expect(mfa).toContain('accessibilityLiveRegion="polite"');
    expect(compass).toContain("if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(pauseMessage))");
    expect(compass).toContain('accessibilityLiveRegion="assertive"');
  });

  it('swaps instantly under Reduce Motion, from the shared probe', () => {
    expect(primitive).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(primitive).toMatch(/if \(!enabled \|\| reduceMotion\) \{\s*enter\.setValue\(1\);\s*return;/);
    // The probe stays shared: the primitive may announce, but it may not grow
    // its own Reduce Motion listener beside the one in src/lib/reduceMotion.
    expect(primitive).not.toContain('AccessibilityInfo.isReduceMotionEnabled');
    expect(primitive).not.toContain('reduceMotionChanged');
  });

  it('builds the entrance driver once, not on every render (F8)', () => {
    expect(primitive).not.toMatch(/= useRef\(new Animated\.Value/);
    expect(primitive).toContain('if (enterRef.current === null) enterRef.current = new Animated.Value(enabled ? 0 : 1);');
  });

  it('owns the success haptic so no flow fires a second one', () => {
    expect(primitive).toContain('void haptics.success();');
    const bodies = {
      cast: feature.match(/function cast\(id: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '',
      submit: feature.match(/const submit = useTransactionalAction\(\(\) => \{[\s\S]*?\n  \}\);/)?.[0] ?? '',
      log: feature.match(/const log = useTransactionalAction\(\(\) => \{[\s\S]*?\n  \}\);/)?.[0] ?? '',
      // The live write joins the same rule (F2): the hook fires the success
      // haptic, so the screen must not fire a second one.
      castVote: feature.match(/async function castVote\(ballot: MobileBallot\) \{[\s\S]*?\n  \}/)?.[0] ?? '',
    };
    for (const [name, body] of Object.entries(bodies)) {
      expect(body, `${name} run body must be present`).not.toBe('');
      expect(body, `${name} must not fire its own success haptic`).not.toContain('haptics');
    }
  });

  it('is wired into all three graded preview flows', () => {
    expect(feature).toContain('const cast = useTransactionalAction(onCast)');
    expect(feature).toContain('<TransactionalButton label="Cast secret vote" action={cast} disabled={!choice} />');
    expect(feature).toContain('<TransactionalButton label="Submit for committee review" action={submit} disabled={summary.trim().length < 8} />');
    expect(feature).toContain('<TransactionalButton label="Log this shift" action={log} disabled={!hours.trim()} />');
    // What each flow shows is unchanged; only its arrival is standardised.
    expect(feature).toContain('message={`Recorded. Receipt ${receipt}. ${BALLOT_RECEIPT_SENTENCE}`}');
    expect(feature).toContain('<Body muted>In review with the committee.</Body>');
    expect(feature).toContain('enabled={title === lastSubmitted}');
    expect(feature).toContain('enabled={item.id === loggedID}');
    // A receipt or a row already on the record at mount is not an arrival.
    expect(feature).toContain('enabled={cast.done}');
  });

  it('carries the one real async write, spinner in its own button (F2)', () => {
    // The busy path was unreachable while every call site settled
    // synchronously; the live ballot is the write that exercises it.
    expect(feature).toContain('const cast = useTransactionalAction(onCast);');
    // Votes are final: the press opens a confirmation, and only its confirm
    // button runs the write (REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103).
    expect(feature).toContain('<TransactionalButton label="Cast final vote" action={confirmCast} disabled={otherBusy || disabled || !choice} />');
    expect(feature).toContain('{ text: confirmation.confirmLabel, onPress: cast.perform },');
    // The label no longer swaps: the spinner is the loading feedback and the
    // button keeps its name.
    expect(feature).not.toMatch(/label=\{[^}]*Casting final vote/);
    // A failed vote returns the control to idle instead of settling into a
    // confirmation the member never earned.
    expect(feature).toMatch(/setError\(nextError instanceof Error \? nextError\.message : 'The vote was not confirmed\.'\);[\s\S]{0,400}?throw nextError;/);
    // One ballot is one control: the screen-wide flag now only refuses the
    // ballots that were not pressed.
    expect(feature).toContain('otherBusy={busy !== null && busy !== ballot.id}');
    // Copy and the privacy boundary are untouched by the migration.
    expect(feature).toContain('<Body>Receipt: {ballot.receiptCode}</Body>');
    expect(feature).toContain('<Body muted>{BALLOT_FINAL_HINT}</Body>');
  });

  it('drops the exports nothing consumed (F8)', () => {
    expect(read('./StatusPill.tsx')).not.toContain('statusPillStyles');
    expect(read('../theme/statusRamp.ts')).not.toContain('STATUS_STATES');
  });
});

// Item 3 of this wave: the Pulse re-photograph is a capture-time action, so no
// Pulse source may move in it. This pins the two agenda/statement strings the
// verification note is waiting on.
describe('Pulse is untouched by the depth wave', () => {
  it('keeps the wave-1 statement rows exactly as photographed', () => {
    const pulse = read('../features/PulseScreen.tsx');
    expect(pulse).toContain('<Text style={styles.heroStatus}>STRONG</Text>');
    expect(pulse).toMatch(/heroStatus: \{ color: NIGHT\.mint/);
    expect(pulse).not.toContain('elevation.');
  });
});

// ---------------------------------------------------------------------------
// P2 copy, SAMPLE boundary and small-IA wave (triage "Accepted —
// screen-scoped"). These are sentences and affordances a reviewer read on a
// captured frame; pinning them keeps a later edit from quietly restoring the
// claim the review rejected.
// ---------------------------------------------------------------------------

describe('P2 copy wave', () => {
  it('points the sign-in caveat at the drawers that exist (b01-3)', () => {
    const signIn = read('../../app/sign-in.tsx');
    //  follow-up: the repaired sentence joined two independent clauses
    // with a bare comma. The conjunction is part of the pin now, so the splice
    // cannot come back with the next copy edit.
    expect(signIn).toContain('All tools sit under Home on the left, and Campaign work sits under Home on the right.');
    expect(signIn).not.toContain('on the left, Campaign work sits under Home');
    // The old line named Compass — which is the member right pane, not a Home
    // drawer — and taught a gesture instead of the map.
    expect(signIn).not.toContain('Home swipes right');
    expect(signIn).not.toMatch(/swipes? (right|left)/);
  });

  it('says Sent, and says what sending does and does not promise (b04b)', () => {
    const feature = read('../features/FeatureScreen.tsx');
    expect(feature).toContain('<Text style={[styles.eyebrow, { color: theme.primary }]}>Sent</Text>');
    // "Received" claimed an act the chapter had not performed.
    expect(feature).not.toContain('>Received</Text>');
    expect(feature).toContain('A committee member reads them; a reply is not guaranteed.');
  });

  it('calls the Guide badge PREVIEW, not BETA (b06-7)', () => {
    const compass = read('./CompassPanel.tsx');
    expect(compass).toContain(">{t('PREVIEW')}</Text>");
    expect(compass).not.toContain('>BETA</Text>');
    // In the demo the role switcher's DEMO is the one status word on screen.
    expect(compass).toContain("const demoChrome = mode === 'preview' ? Boolean(previewHat) : Boolean(sampleHat);");
    expect(compass).toContain('{previewPill ? null : demoChrome ? (');
    expect(compass).toContain("<Text maxFontSizeMultiplier={2} style={[styles.previewWord, { color: theme.mutedForeground }]}>{t('Preview')}</Text>");
  });
});

describe('preview Meetings desk actions', () => {
  it('appends a preview-session draft and marks meetings as checked in', () => {
    expect(PREVIEW_NOW).toBe('2026-08-13T12:00:00.000Z');
    expect(appendPreviewEventDraft([], { title: '  ', place: 'Boston office hall' })).toEqual([]);
    expect(appendPreviewEventDraft([], { title: 'Campaign meeting', place: '  ' })).toEqual([]);
    const drafted = appendPreviewEventDraft([], { title: ' Campaign meeting ', place: ' Boston office hall + Zoom ' });
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({
      id: 'authored-1',
      title: 'Campaign meeting',
      place: 'Boston office hall + Zoom',
      startsAt: '2026-08-20T14:00:00-04:00',
      summary: 'Preview session draft. Not published to the campaign calendar.',
    });
    const second = appendPreviewEventDraft(drafted, { title: 'Committee huddle', place: 'Zoom' });
    expect(second.map((item) => item.id)).toEqual(['authored-2', 'authored-1']);
    expect(previewEventCheckInCode('2026-08-30T14:00:00-04:00')).toBe('HBV-AUG30');
    expect(previewEventCheckInCode('not-a-date')).toBe('HBV-EVENT');
    const pending = previewEventCheckInPresentation('2026-08-30T14:00:00-04:00', false);
    expect(pending).toEqual({
      code: 'HBV-AUG30',
      checkedIn: false,
      actionLabel: 'Check in · HBV-AUG30',
      statusLabel: 'Checked in · HBV-AUG30',
    });
    expect(previewEventCheckInPresentation('2026-08-30T14:00:00-04:00', true).checkedIn).toBe(true);
    const once = togglePreviewEventCheckIn([], 'evt-demo');
    expect(once).toEqual(['evt-demo']);
    expect(togglePreviewEventCheckIn(once, 'evt-demo')).toEqual(['evt-demo']);
    expect(togglePreviewEventCheckIn(once, 'evt-history-demo')).toEqual(['evt-demo', 'evt-history-demo']);
  });

  it('keeps preview Meetings on the preview desk and does not claim worker check-in', () => {
    const feature = read('../features/FeatureScreen.tsx');
    const desk = feature.slice(
      feature.indexOf('function EventsFeature('),
      feature.indexOf('function RewardsFeature('),
    );
    expect(desk).toContain('Author a preview-session draft and mark a meeting as checked in. Codes stay in the app.');
    expect(desk).not.toContain('check in workers');
    expect(desk).not.toContain('function saveDraftEvent');
    expect(desk).not.toContain('onPress={saveDraftEvent}');
    expect(desk).toContain('onPress={() => setAuthored(appendPreviewEventDraft(authored, { title: draftTitle, place: draftPlace }))}');
    expect(desk).toContain('onPress={() => setCheckedInIds((current) => togglePreviewEventCheckIn(current, item.id))}');
    expect(desk).toContain('previewEventCheckInPresentation(item.startsAt, checkedInIds.includes(item.id))');
    expect(desk).toContain('label={checkIn.actionLabel}');
    expect(desk).not.toContain('Check-in · WOR-AUG30');
    expect(feature).toContain("if (featureKey === 'events' || featureKey === 'events-desk') return <EventsFeature deskTitle={featureKey === 'events-desk'} />");
    expect(feature).toContain("if (['events', 'events-desk', 'rewards', 'numbers', 'workload', 'rights', 'chapter', 'tasks', 'steward-appointments'].includes(featureKey)) return <LiveLivedInScreen key={partnerScope} featureKey={featureKey} sourceID={sourceID} onOpenTask={openTask} />");
  });
});

// Union Ground has no points economy: the web's Contributions view and the
// safe-recognition migration acknowledge verified, voluntary work without
// points, tiers, perk claims or a ledger. The preview's Contributions screen
// replaced Union Ground's redemption store with the same acknowledgement.
describe('preview Contributions acknowledgement', () => {
  const feature = read('../features/FeatureScreen.tsx');
  const live = read('../features/LiveLivedInScreens.tsx');
  const catalog = read('../lib/featureCatalog.ts');
  const rewards = feature.slice(
    feature.indexOf('function RewardsFeature('),
    feature.indexOf('function ReportsFeature('),
  );
  const sections = live.slice(live.indexOf('export function ContributionsSections('), live.indexOf('function LiveWorkloadScreen('));

  it('keeps the participation path in the web order and resolves unknown rungs to Learn', () => {
    expect(RECOGNITION_RUNGS.map((rung) => rung.label)).toEqual(['Learn', 'Attend', 'Volunteer', 'Organize', 'Lead']);
    expect(recognitionRung('organize')).toBe('organize');
    expect(recognitionRung('tier-3')).toBe('learn');
    expect(recognitionRung(undefined)).toBe('learn');
  });

  it('mirrors the recognition kinds the database allows, with no cost or stock', () => {
    expect(PREVIEW_RECOGNITION_RULES.map((rule) => rule.recognitionKind)).toEqual([
      'training_complete', 'orientation_complete', 'peer_outreach_complete', 'committee_commitment_complete', 'commitment_complete',
    ]);
    for (const rule of PREVIEW_RECOGNITION_RULES) {
      expect(Object.keys(rule).sort()).toEqual(['description', 'label', 'recognitionKind']);
      expect(`${rule.label} ${rule.description}`).not.toMatch(/\bpoints?\b|\btier|chapter|member\b/i);
    }
  });

  it('carries the web boundary copy word for word', () => {
    expect(CONTRIBUTIONS_COPY.noEffect).toBe('Recognition has no effect on representation, issues, voting, services, benefits, access, standing, discipline, assigned roles, or leadership eligibility.');
    expect(CONTRIBUTIONS_COPY.boundarySub).toBe('Recognition records contribution. It does not rank workers.');
    expect(CONTRIBUTIONS_COPY.notRecognizedTitle).toBe('Never recognized or scored');
    expect(CONTRIBUTIONS_COPY.recentSub).toBe('No quota. No streak penalty.');
  });

  it('renders the preview through the shared sections and never a balance, tier, catalog or ledger', () => {
    expect(rewards).toContain('const rewards = previewDesk?.rewards;');
    expect(rewards).toContain('<ContributionsSections');
    expect(rewards).toContain('rules={PREVIEW_RECOGNITION_RULES}');
    expect(rewards).toContain('acknowledgements={rewards?.acknowledgements ?? []}');
    expect(feature).toContain("if (featureKey === 'rewards') return <RewardsFeature />");
    expect(feature).toContain("if (['events', 'events-desk', 'rewards', 'numbers', 'workload', 'rights', 'chapter', 'tasks', 'steward-appointments'].includes(featureKey)) return <LiveLivedInScreen key={partnerScope} featureKey={featureKey} sourceID={sourceID} onOpenTask={openTask} />");
    for (const source of [rewards, sections]) {
      expect(source).not.toMatch(/\bpoints?\b|Tier|Redeem|totalPoints|tierName|setClaimedIds|Ledger/);
    }
    for (const retired of ['REWARD_CATALOG', 'previewRewardState', 'redeemPreviewReward', 'PreviewRewardLedger']) {
      expect(catalog).not.toContain(retired);
      expect(feature).not.toContain(retired);
    }
    expect(sections).toContain('{CONTRIBUTIONS_COPY.noEffect}');
    expect(sections).toContain('{RECOGNITION_RUNGS.map((rung) => (');
    expect(sections).toContain('{CONTRIBUTIONS_COPY.notRecognizedList}');
  });
});

// TEST-UG-MOBILE-PREVIEW-KEY-STATES-ABSENT-20260920: the member preview
// must reach the decisive Voting and Rewards states. The mobile lane has no
// React renderer, so the states are computed with the same helpers the shipped
// BallotCard and RewardsFeature call on the same desk, and the source pins
// below prove the screens render from those helpers, not substitute markup.
describe('preview key states: open vote and contributions acknowledgement', () => {
  const feature = read('../features/FeatureScreen.tsx');
  const desk = previewDeskFor('member');

  it('gives the worker preview an open vote with selectable options and a cast control', () => {
    expect(canOpenFeature('preview', 'voting', 'member')).toBe(true);
    const states = desk.ballots.map((ballot) => ({ id: ballot.id, ...previewBallotCardState(ballot, PREVIEW_NOW) }));
    const open = states.filter((state) => state.open);
    expect(open.length).toBeGreaterThanOrEqual(1);
    for (const state of open) {
      expect(state.label).toBe('Open vote');
      expect(state.options).toEqual(['Yes', 'No', 'Abstain']);
      expect(state.canCast).toBe(true);
    }
    // The existing ballots keep their honest closed state.
    expect(states.filter((state) => ['ballot-2026', 'ballot-2025', 'pulse-new-members'].includes(state.id)).map((state) => state.open))
      .toEqual([false, false, false]);
  });

  it('renders the open state through the shipped BallotCard from the preview desk', () => {
    const voting = feature.slice(feature.indexOf('function VotingFeature('), feature.indexOf('function FormsFeature('));
    expect(voting).toContain('const ballots = previewDesk?.ballots ?? [];');
    expect(voting).toContain('<BallotCard');
    expect(voting).toContain('const { open, label, options, canCast } = previewBallotCardState(ballot);');
    expect(voting).toContain('accessibilityRole="radio"');
    expect(voting).toContain('{!receipt && canCast');
    expect(voting).toContain('<TransactionalButton label="Cast secret vote" action={cast} disabled={!choice} />');
    expect(feature).toContain("if (featureKey === 'voting') return <VotingFeature />;");
  });

  it('gives the worker preview verified acknowledgements on a current path, with no balance to spend', () => {
    expect(canOpenFeature('preview', 'rewards', 'member')).toBe(true);
    const contributions = desk.rewards;
    expect(contributions).not.toBeNull();
    expect(contributions!.totalVerified).toBeGreaterThan(0);
    expect(contributions!.recentVerified).toBeLessThanOrEqual(contributions!.totalVerified);
    expect(RECOGNITION_RUNGS.map((rung) => rung.key)).toContain(contributions!.currentRung);
    expect(contributions!.acknowledgements.length).toBeGreaterThanOrEqual(1);
    const kinds = PREVIEW_RECOGNITION_RULES.map((rule) => rule.recognitionKind);
    for (const item of contributions!.acknowledgements) expect(kinds).toContain(item.recognitionKind);
    expect(Object.keys(contributions!).sort()).toEqual(['acknowledgements', 'actionsYtd', 'currentRung', 'recentVerified', 'totalVerified']);
  });

  it('renders the acknowledgement state through the shipped RewardsFeature', () => {
    const rewards = feature.slice(feature.indexOf('function RewardsFeature('), feature.indexOf('function ReportsFeature('));
    expect(rewards).toContain('const rewards = previewDesk?.rewards;');
    expect(rewards).toContain("currentRung={rewards?.currentRung ?? 'learn'}");
    expect(rewards).not.toContain('disabled=');
  });
});

describe('P2 SAMPLE boundary (b04b)', () => {
  const feature = read('../features/FeatureScreen.tsx');

  it('drops the per-card amber SAMPLE pill on Campaigns', () => {
    // The boundary is the hat pill plus the session sentence; a gold pill per
    // card restated it, failed contrast, and spent the accent token doing it.
    expect(feature).not.toContain("{entry.current ? 'Your campaign' : 'SAMPLE'}");
    expect(feature).not.toContain('backgroundColor: entry.current ? theme.secondary : theme.accent');
    expect(feature).toContain('{entry.current ? (');
    expect(feature).toContain('<Text style={[styles.workChipText, { color: theme.secondaryForeground }]}>Your campaign</Text>');
  });

  it('keeps the two markers the boundary actually rests on', () => {
    expect(read('./HatSwitcher.tsx')).toContain('PREVIEW · {current.label}');
    //  follow-up: the second marker on Chapters is the sentence under the
    // list, not the field-notes chip. Chapters' own sentence is pinned here;
    // the session-only chip keeps its pin below as the write-surface marker it
    // actually is, so neither can be dropped in the other's name.
    expect(feature).toContain('Preview context only. Your worker account and authorization have not changed.');
    expect(feature).toContain('PREVIEW · session-only');
  });
});

describe('P2 data defects', () => {
  it('reports each personal metric once, from the computed source (b04b-1)', () => {
    const feature = read('../features/FeatureScreen.tsx');
    // The desk KPI band restated metrics this screen computes from the same
    // records, and printed both — "Unread updates" appeared twice with
    // different numbers.
    expect(feature).toContain('const reported = new Set(computed.map((item) => item.label));');
    expect(feature).toContain('const deskOnly = (previewDesk?.kpis ?? []).filter((item) => !reported.has(item.label));');
    // Each card names its own scope, so a chapter KPI never reads as personal.
    expect(feature).toContain("...deskOnly.map((item) => ({ ...item, scope: reportMetricScopeLabel('chapter', 'current desk') })),");
    expect(feature).toContain('{scoped.map((item) => (');
    expect(feature).not.toContain('<Card><Heading level={3}>{metrics.unreadNotifications}</Heading>');
  });

  it('renders both poll surfaces from one apportioned share (b05-13)', () => {
    const channel = read('../../app/channel/[id].tsx');
    const pulse = read('../features/PulseScreen.tsx');
    const pollCard = read('./ChannelPollCard.tsx');
    expect(channel).toContain('<ChannelPollCard poll={poll}');
    expect(pollCard).toContain('const shares = pollShares(poll.options);');
    expect(pulse).toContain('const pollPercent = pollShares(poll.options);');
    // No surface rounds a fraction of its own any more.
    for (const source of [channel, pollCard, pulse]) {
      expect(source).not.toContain('Math.round(share * 100)');
      expect(source).not.toContain('option.votes / pollTotal');
    }
  });
});

describe('P2 small IA', () => {
  const hats = read('./HatSwitcher.tsx');

  it('states the hat sheet selection with a leading radio dot (b03a-2)', () => {
    expect(hats).toContain('<View style={[styles.radio, { marginTop: radioOffset, borderColor: selected ? theme.primary : theme.mutedForeground }]}>');
    expect(hats).toContain('{selected ? <View style={[styles.radioFill, { backgroundColor: theme.primary }]} /> : null}');
    // The trailing checkmark read as "done" and left the unselected rows with
    // no selection affordance at all.
    expect(hats).not.toContain('<Ionicons name="checkmark" size={22}');
    // The radio dot is visual; iOS needs a button trait to announce an action.
    expect(hats).toContain('accessibilityRole="button"');
    expect(hats).toContain('accessibilityState={{ selected, disabled: switching }}');
  });

  it('leaves the screen at full strength behind the dropdown, so the pill needs no dimming (b03a-8)', () => {
    // b03a-8 dimmed the pill with the bottom sheet's 35% scrim so it did not
    // hold full strength over a darkened Home. The dropdown has no scrim at
    // all, and the pill only fades with the Home drawers' reveal.
    expect(hats).not.toContain('SHEET_SCRIM_OPACITY');
    expect(hats).not.toContain('sheetDim');
    expect(hats).toContain('const pillDim = Animated.subtract(1, homeDrawerReveal);');
    expect(hats).toContain('opacity: pillOpacity,');
    expect(hats).toContain('scrollsWithHome ? Animated.multiply(pillDim, homePillVisibility) : pillDim');
  });

  it('answers a zero-match channel search instead of emptying the rail (B02a)', () => {
    const rail = read('./ChapterRail.tsx');
    expect(rail).toContain('{visibleChannels.length === 0 ? (');
    expect(rail).toContain('No channels match that search');
    // Same answer the sibling feature search already gave.
    expect(read('./FunctionDeck.tsx')).toContain('No features match that search.');
  });

  it('pairs every chapter-rail tile and avatar with semantic theme colors', () => {
    const rail = read('./ChapterRail.tsx');
    const audit = read('../../scripts/contrast-audit.mjs');
    expect(rail).toContain("['primary', 'primaryForeground']");
    expect(rail).toContain("['compass', 'compassForeground']");
    expect(rail).toContain("['accent', 'accentForeground']");
    expect(rail).toContain("['secondary', 'secondaryForeground']");
    expect(rail).toContain('background: chapter.selected ? theme.primary : theme.secondary');
    expect(rail).toContain('foreground: chapter.selected ? theme.primaryForeground : theme.secondaryForeground');
    expect(rail).toContain('backgroundColor: chapter.background, borderColor: theme.primary');
    expect(rail).toContain('color: chapter.foreground');
    expect(rail).toContain('backgroundColor: person.background, borderColor: theme.primary');
    expect(rail).toContain('color: person.foreground');
    expect(rail).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(audit).toContain("['muted', 'primary', 3, 'Chapter rail tile outline against rail']");
    expect(audit).toContain("['card', 'primary', 3, 'Chapter rail avatar outline against panel']");
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      expect(ratio(tokens.muted!, tokens.primary!), `${mode} tile outline against rail`)
        .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      expect(ratio(tokens.card!, tokens.primary!), `${mode} avatar outline against panel`)
        .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
    }
  });

  it('renders the campaign rail at its destination without animation under Reduce Motion', () => {
    const rail = read('./ChapterRail.tsx');
    expect(rail).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(rail).toContain('const reduceMotion = useReduceMotion()');
    expect(rail).toMatch(/if \(reduceMotion\) \{\s*shift\.setValue\(destination\);\s*scrim\.setValue\(open \? 1 : 0\);\s*return;/);
    expect(rail).toMatch(/}, \[open, reduceMotion, scrim, shift\]\);/);
  });

  it('lets inbox titles wrap once without turning rows into dense cards', () => {
    expect(read('../../app/messages.tsx'))
      .toContain('<Text numberOfLines={2} style={[styles.rowTitle, { color: theme.foreground, fontWeight: item.unread');
  });

  it('keeps native inbox filters, results, and composer accessible on iOS and Android', () => {
    const messages = read('../../app/messages.tsx');
    expect(messages).toContain('accessibilityRole="tablist"');
    expect(messages).toContain('accessibilityRole="button"');
    // The result count speaks on iOS and through Android's live region, only
    // after the member's own filter or search change
    // (useResultCountAnnouncement.test.ts).
    const announcement = read('../features/useResultCountAnnouncement.ts');
    expect(announcement).toContain("if (Platform.OS === 'ios') void AccessibilityInfo.announceForAccessibility(message);");
    expect(messages).toContain('useResultCountAnnouncement(JSON.stringify([filter, query]), copy.resultCount(resultCount))');
    expect(messages).toContain('accessibilityState={{ selected }}');
    expect(messages).toContain('autoFocus');
  });

  it('shows the committee member conversation CTA only for the worker identity', () => {
    const messages = read('../../app/messages.tsx');
    expect(messages).toContain('const staffBriefingHat = mode === \'preview\'');
    expect(messages).toContain('previewHat && previewHat !== \'member\' ? previewHat : null');
    expect(messages).toContain("mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null");
    const composeStart = messages.indexOf('{!staffBriefingHat ? (');
    expect(composeStart).toBeGreaterThan(-1);
    const composeBlock = messages.slice(composeStart, messages.indexOf('</Pressable>', composeStart) + 12);
    expect(composeBlock).toContain('accessibilityLabel={stewardConversation ? copy.messageSteward : copy.composerTitle}');
    expect(composeBlock).toContain('onPress={openSteward}');
    const rowStart = messages.lastIndexOf('{!staffBriefingHat ? (');
    expect(rowStart).toBeGreaterThan(composeStart);
    const rowBlock = messages.slice(rowStart, messages.indexOf('</Pressable>', rowStart) + 12);
    expect(rowBlock).toContain('accessibilityLabel={copy.messageSteward}');
    expect(rowBlock).toContain('onPress={openSteward}');
    expect(messages).toContain('{staffBriefingHat ? (');
    expect(messages).toContain('{composerOpen && !staffBriefingHat ? (');
    expect(messages).not.toContain('{composerOpen ? (');
    expect(messages).toContain('if (staffBriefingHat) return;');
    expect(messages).toMatch(/if \(!staffBriefingHat\) return;\s*setComposerOpen\(false\);\s*setDraft\(''\);\s*setSendError\(null\);/);
  });

  it('makes the Campaign retaliation notice an in-app committee action', () => {
    const campaign = read('../../app/(tabs)/campaign.tsx');
    expect(campaign).toContain('Worried about retaliation?');
    expect(campaign).toContain('The Guide and this app are not emergency services or legal advice.');
    expect(campaign).toContain("const organizingHat = mode === 'preview'");
    expect(campaign).toContain('{!organizingHat ? (');
    expect(campaign).toContain('accessibilityRole="button"');
    expect(campaign).toContain('accessibilityLabel="Message the committee"');
    expect(campaign).toContain('findNativeStewardConversation(dashboard?.conversations ?? [])');
    expect(campaign).toContain("'/messages'");
    expect(campaign).toContain('minHeight: minimumTouchTarget');
    expect(campaign).not.toContain('Linking');
    expect(campaign).not.toMatch(/\btel:/);
    expect(campaign).not.toMatch(/\bmailto:/);
  });

  // Supersedes "names the currently shown theme when it diverges from the saved
  // selection": with Union Ground the only theme (owner ruling, Nov 3, 2026)
  // the saved and shown theme cannot diverge, so the section is a statement,
  // not a radio group. The app is light only since Nov 5, 2026
  // (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105), so it shows the
  // light swatch alone and no longer names an appearance.
  it('states Union Ground as the one theme, light only', () => {
    const account = read('../../app/(tabs)/account.tsx');
    expect(account).not.toContain('busyTheme');
    expect(account).not.toContain("accessibilityRole=\"radiogroup\" accessibilityLabel={t(\"App theme\")}");
    expect(account).toContain('accessibilityLabel={`${catalogLabel(option.label)}. ${catalogLabel(option.description)}`}');
    expect(account).toContain('{[light].map((swatch) => (');
    expect(account).not.toMatch(/resolveTheme\([^)]*,\s*true\)/);
    // The SAMPLE Steward pin is retired with the palettes it guarded against:
    // every hat wears Union Ground (owner ruling, Nov 3, 2026).
    expect(account).not.toContain('PREVIEW Committee stays Union Ground');
    expect(account).toContain('Union Ground is the theme on every desk');
  });

  it('uses localized, non-sensitive native inbox status and error copy', () => {
    const messages = read('../../app/messages.tsx');
    expect(messages).toContain("import { inboxChannelLoadNotice, messageInboxCopy } from '../src/lib/messageInboxCopy';");
    expect(messages).toContain('inboxChannelLoadNotice(copy, store.loadFault(), store.status() === \'error\')');
    expect(messages).toContain('{channelsError ? <Notice>{channelsError}</Notice> : null}');
    expect(messages).not.toContain('Campaign channels could not load: {channelsError}');
    expect(messages).toContain('{copy.resultCount(resultCount)}');
    expect(messages).toContain('copy.unreadCount(item.unread)');
  });
});

// ---------------------------------------------------------------------------
// P2 IA wave A (triage "Accepted — screen-scoped": Compass canvas b06-2..6,
// the gate template b06-17, and the four IA items b04b Be heard / Rights /
// Search, b01-22 and b01-30).
// ---------------------------------------------------------------------------

describe('Guide canvas (b06-2 … b06-6, brief §D)', () => {
  const compass = read('./CompassPanel.tsx');
  const sourceNavigation = read('../lib/compassSourceNavigation.ts');
  const featureRoute = read('../../app/feature/[key].tsx');
  const featureScreen = read('../features/FeatureScreen.tsx');
  const livedInScreens = read('../features/LiveLivedInScreens.tsx');

  it('populates the composer from a suggestion chip instead of sending (b06-2)', () => {
    expect(compass).toContain('function populateComposer(draft: string) {');
    expect(compass).toContain('inputRef.current?.focus();');
    expect(compass).toContain('onPress={() => { populateComposer(suggestion); }}');
    // The blocker: a chip used to fire the question with no editable step.
    expect(compass).not.toContain('void submit(suggestion)');
    // Populating a composer the member cannot send from would be worse than
    // the blocker, so the same guard the send button uses gates the write.
    expect(compass).toContain('if (!historyReady || paused || pendingSave || busy) return;');
  });

  it('renders the assistant turn as unbubbled canvas text (b06-3)', () => {
    // No fill, no radius, no shadow: the answer is page text under the ✦
    // attribution, not a level-1 card floating over the canvas.
    expect(compass).toContain('<View style={styles.assistantBody}>');
    expect(compass).toContain('assistantBody: { gap: spacing.sm },');
    expect(compass).not.toContain('styles.assistantBody, { backgroundColor: theme.card }');
    // The attribution row itself is unchanged.
    expect(compass).toContain('<Ionicons name="sparkles" size={14} color={theme.compass}');
  });

  it('tints the worker bubble lavender instead of filling it aubergine (b06-4)', () => {
    expect(compass).toContain('<View style={[styles.bubble, styles.userBubble, { backgroundColor: theme.secondary, borderColor: theme.border }]}>');
    // The near-invisible fill (1.08:1 on the canvas) carries the audited
    // hairline, same as the sources block and the secondary Button.
    expect(compass).toContain('bubble: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md }');
    expect(compass).toContain('<Text style={[styles.bubbleText, { color: theme.secondaryForeground }]}>{message.body}</Text>');
    // The solid aubergine fill with reversed white text is gone.
    expect(compass).not.toContain('styles.userBubble, { backgroundColor: theme.primary }');
    // And the pairing that replaced it is one the contrast audit already owns.
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      expect(ratio(tokens.secondary!, tokens.secondaryForeground!), `${mode} worker bubble`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('opens each resolvable approved source in its native reader (b06-5)', () => {
    expect(compass).toContain("? t('Opens this approved source')");
    expect(compass).toContain('activateCompassSource(');
    expect(compass).toContain('onRouteOut?.();');
    expect(compass).toContain('router.push(destination as never);');
    expect(compass).toContain("name={source.destination ? 'open-outline' : 'create-outline'}");
    expect(compass).toContain('const sourceDisabled = !source.destination');
    expect(compass).toContain('accessibilityState={{ disabled: sourceDisabled }}');
    expect(compass).toContain('disabled={sourceDisabled}');
    expect(sourceNavigation).toContain('`/feature/rights?source=${encodeURIComponent(source.id)}`');
    expect(sourceNavigation).toContain('`/feature/chapter?source=${encodeURIComponent(source.id)}`');
    expect(featureRoute).toContain('sourceID={source}');
    expect(featureScreen).toContain("compassSourceMatchesReaderRecord(sourceID, 'kb', item.id)");
    expect(livedInScreens).toContain("compassSourceMatchesReaderRecord(sourceID, 'kb', article.slug)");
    expect(livedInScreens).toContain("compassSourceMatchesReaderRecord(sourceID, 'doc', document.id)");
    expect(compass).not.toContain('onPress={() => { populateComposer(`Tell me more about ${source.title} (${source.ref}).`); }}');
    // A 48px row, in the flat tinted hairline block the brief specifies.
    expect(compass).toContain('source: { minHeight: minimumTouchTarget,');
    expect(compass).toContain('sources: { borderWidth: StyleSheet.hairlineWidth,');
    // No source row may send: the only sender is the send button.
    expect(compass).not.toMatch(/source[\s\S]{0,200}void submit\(/);
  });

  it('carries no privacy note below the composer (Guide copy contract)', () => {
    // Pin flipped by the Codex IA-A review. The Compass copy contract:
    // "Do not repeat the preview privacy note below the composer." The standing
    // contract supersedes b06-6, which had filed an 11px muted line there. The
    // disclosure is not lost — it is stated once, on the ai-disclosure legal
    // surface, which is the surface that owns it.
    expect(compass).not.toContain('disclaimer');
    expect(compass).not.toContain('Do not enter passwords');
    expect(compass).not.toContain('Guide answers from approved campaign sources');
    expect(read('../lib/legalDocuments.ts'))
      .toContain('Do not enter passwords, Social Security numbers, medical details, or coworker lists.');
    // Nothing at all hangs under the input: the dock's only child is the
    // composer, so its measured height is the composer's height.
    const dock = compass.slice(
      compass.indexOf('style={[styles.composerDock'),
      compass.indexOf('const styles = StyleSheet.create'),
    );
    // The composer's own TextInput is the only Text-family element left in the
    // dock; no `<Text>` line may hang beneath it.
    expect(dock).toContain('<TextInput');
    expect(dock).not.toMatch(/<Text[\s>]/);
    // Transcript padding resolves from that one measured composer with no
    // gradient overlay at the viewport edge.
    expect(compass).toContain('style={[styles.composerDock, { marginBottom: composerLift }]}');
    expect(compass).toContain('{ paddingBottom: composerHeight + CHROME_CLEARANCE }');
    expect(compass).not.toContain('COMPOSER_SCRIM_HEIGHT');
  });
});

describe('authorization gate template (b06-17)', () => {
  const feature = read('../features/FeatureScreen.tsx');
  const hats = read('./HatSwitcher.tsx');
  const store = read('../lib/hatSwitcher.ts');

  it('serves all three gates from one template', () => {
    // Pin updated by the IA-wave-A review: the template took a qualifying-hats
    // set so the sentence can name the hats instead of describing them.
    expect(feature).toContain('function AuthorizationGate({ title, body, qualifyingHats, switchHat = false, rolePicker = false }');
    // Three gate screens, twelve call sites: integrations, operations,
    // leadership health, chapter memberships, steward appointments, the
    // steward desk sections have role-specific branches (this edition has no Dues gate); the
    // general feature gate has a live branch and two preview branches, and
    // the desk gate has one of each.
    expect(feature.match(/<AuthorizationGate/g)?.length).toBe(11);
    // Destination-first titles: the gate names what you tried to open first.
    expect(feature).toContain('title={`${title} is an organizing tool`}');
    expect(feature).toContain('title={`${title} opens under another role`}');
    expect(feature).toContain('title={`${title} is not open to your role`}');
    expect(feature).not.toContain("title=\"Switch hats to open this desk\"");
  });

  it('ships the control the copy used to describe, not a description of it', () => {
    expect(feature).toContain("import { requestHatSwitcher } from '../lib/hatSwitcher'");
    expect(feature).toContain('label="Switch role"');
    expect(feature).toContain('onPress={requestHatSwitcher}');
    // The prose that pointed at an off-screen control is gone.
    expect(feature).not.toContain('from Switch hat to open this staff tool');
    expect(feature).not.toContain('opens only after you choose that hat from Switch hat');
  });

  it('offers the switch only where a hat switcher exists', () => {
    // A live session has no hat switcher at all (the demo-origin
    // contract), so those gates take no button and state the human route.
    expect(feature).toContain('Ask a campaign administrator if your assignment changed.');
    for (const liveSessionGate of liveSessionAuthorizationGates(feature)) {
      expect(liveSessionGate.length).toBeGreaterThan(0);
      expect(liveSessionGate).not.toContain('switchHat');
    }
  });

  it('reaches the sheet through a monotonic request store, not a shared parent', () => {
    expect(store).toContain('export function requestHatSwitcher(): void');
    expect(store).toContain('export function useHatSwitcherRequests(): number');
    expect(store).toContain('useSyncExternalStore');
    expect(hats).toContain("import { useHatSwitcherRequests } from '../lib/hatSwitcher'");
    expect(hats).toContain('const seenRequests = useRef(requests);');
    expect(hats).toContain('if (requests === seenRequests.current) return;');
    // The sheet still owns its own visibility.
    expect(hats).toContain('const [open, setOpen] = useState(false);');
  });
});

describe('P2 IA wave A screens', () => {
  const feature = read('../features/FeatureScreen.tsx');
  const legal = read('../features/LegalDocumentScreen.tsx');

  it('files Be heard as a radiogroup with nothing pre-selected (b04b)', () => {
    expect(feature).toContain('const [topic, setTopic] = useState<string | null>(null);');
    expect(feature).toContain('<View accessibilityRole="radiogroup" accessibilityLabel="Topic" style={styles.wrap}>');
    expect(feature).toContain('accessibilityState={{ selected: topic === item, checked: topic === item }}');
    // IA wave B named the condition once so the visible line and the iOS
    // announcement ( follow-up 5) cannot state two different rules.
    expect(feature).toContain('const unmet = topic === null || body.trim().length < 8;');
    expect(feature).toContain('disabled={unmet}');
    // The default filed every unread report under App feedback.
    expect(feature).not.toContain("useState('App feedback')");
    // Copy is untouched by this wave.
    expect(feature).toContain('A committee member reads them; a reply is not guaranteed.');
  });

  it('turns Rights into a reading list with a reading view (b04b)', () => {
    expect(feature).toContain('const RIGHTS_SCRIPT_SIZE = 17;');
    expect(feature).toContain('rightsIndexRow: { minHeight: 64,');
    expect(feature).toContain('onPress={() => { void haptics.select(); setOpenID(item.id); }}');
    expect(feature).toContain("label={t(\"Copy or share this script\")}");
    expect(feature).toContain("label={readLarge ? t(\"Back to reading size\") : t(\"Read large\")}");
    // The five stacked full-script cards are gone.
    expect(feature).not.toMatch(/<Card key=\{item\.id\}>\s*<Heading level=\{3\}>\{item\.title\}<\/Heading>\s*<Body muted>\{item\.summary\}<\/Body>\s*<Body>\{item\.script\}<\/Body>/);
  });

  it('scopes the search haystack and counts what it found (b04b)', () => {
    expect(feature).toContain('const SEARCH_RECENTS_CAP = 3;');
    expect(feature).toContain('const SEARCH_SCOPES = [');
    expect(feature).toContain('<View accessibilityRole="radiogroup" accessibilityLabel="Search scope" style={styles.wrap}>');
    expect(feature).toContain("`${results.length} ${results.length === 1 ? 'result' : 'results'}`");
    // The pre-query dump of eight unlabelled rows is gone.
    expect(feature).not.toContain('haystack.slice(0, 8)');
    // The frozen no-match copy is untouched.
    expect(feature).toContain('<StateMessage title="No authorized matches" body="Try another word from an issue, form, or rights lesson you can already see." />');
  });

  it('Search href-or-not-button', () => {
    const search = feature.slice(feature.indexOf('function SearchFeature()'), feature.indexOf('function CasesFeature()'));
    const live = withoutComments(search);
    const map = live.slice(live.indexOf('results.map((item) => {')).replace(/\s+/g, ' ');
    expect(search).toContain("scope: 'cases'");
    expect(search).toContain('href: `/issue/${item.id}`');
    expect(search).toContain("scope: 'events'");
    expect(search).toContain("scope: 'forms'");
    expect(search).toContain("scope: 'rights'");
    expect(search).toContain("scope: 'ballots'");
    // Only cases rows carry a destination. Events, forms, rights and ballots
    // omit href, so they must not ship as buttons VoiceOver would activate.
    expect(search).not.toMatch(/scope: 'events'[\s\S]{0,120}href:/);
    // No renderer in this package: pin the host JSX to the helper so a static
    // View cannot quietly become a dead Pressable/button while helper tests pass.
    expect(map).toContain('const row = presentSearchRow(item);');
    expect(map).toContain("if (row.kind === 'pressable') { return ( <Pressable key={item.id} accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel} onPress={() => { void haptics.select(); pressSearchRow(row, (href) => { router.push(href as never); }); }} >");
    expect(map).toContain('return ( <View key={item.id} accessible accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel}>');
    expect(map.match(/<Pressable/g)?.length).toBe(1);
    expect(map).not.toContain('accessibilityRole="button"');
    expect(map).not.toContain('onPress={() => { return;');
    expect(live).not.toContain('<View key={item.id} accessible accessibilityLabel={item.title}>');
    expect(live).not.toContain('if (item.href) { void haptics.select(); router.push(item.href as never); }');
  });

  it('gives a long document a collapsed jump card, off under Reduce Motion (b01-22)', () => {
    expect(legal).toContain('const JUMP_CARD_MIN_SECTIONS = 5;');
    // REQ-UG-NATIVE-LEGAL-READER-INSTRUMENT-PARITY-20261017: the
    // card counts and lists the instrument sections as well as the summary.
    expect(legal).toContain('const jumpEntries = legalJumpEntries(document);');
    expect(legal).toContain('jumpEntries.length > JUMP_CARD_MIN_SECTIONS');
    expect(legal).toContain('<JumpCard sections={jumpEntries} onJump={jumpTo} />');
    expect(legal).toContain('const [expanded, setExpanded] = useState(false);');
    // Pin updated by the Codex IA-A review: the 280ms easeOut and the Reduce
    // Motion branch moved into the shared expansion primitive, so the screen
    // states the intent and the module owns the motion.
    expect(legal).toContain("import { configureExpansion } from '../lib/expansion'");
    expect(legal).toContain('configureExpansion(reduceMotion);');
    expect(legal).not.toContain('JUMP_EXPAND_MS');
    expect(legal).not.toContain('LayoutAnimation');
    expect(legal).toContain('accessibilityState={{ expanded }}');
    // In-page anchors, measured from the page's own scroll surface — and no
    // sticky TOC: the card scrolls away with the document.
    expect(legal).toContain('scrollRef.current?.scrollTo({ y: Math.max(0, top - clearance), animated: !reduceMotion });');
    // Anchored by id, not heading: a summary and its instrument share headings.
    expect(legal).toContain('sectionTops.current[id] = event.nativeEvent.layout.y;');
    expect(legal).toContain('onLayout={measure(legalSummaryAnchor(index))}');
    expect(legal).toContain('onLayout={measure(LEGAL_INSTRUMENT_ANCHOR)}');
    expect(legal).toContain('onLayout={measure(legalInstrumentAnchor(index))}');
    expect(legal).toContain('onPress={() => onJump(entry.id)}');
    expect(legal).not.toContain("position: 'absolute'");
    // Screen lends the handle; it still owns the surface and both insets.
    // attachScroll forwards the same node to the caller's scrollRef.
    expect(read('./ui.tsx')).toContain('scrollRef?: RefObject<ScrollView | null>;');
    expect(read('./ui.tsx')).toContain('if (scrollRef) scrollRef.current = node;');
    expect(read('./ui.tsx')).toContain('ref={attachScroll}');
  });

  it('fixes the cross-link order and keeps the current page in it (b01-30)', () => {
    // REQ-UG-FORMAL-ACCESSIBILITY-STATEMENT-20261010 appended the
    // formal statement after the summary it sits behind.
    expect(legal).toContain("const CROSS_LINK_ORDER: LegalPageKey[] = ['about', 'privacy', 'terms', 'ai-disclosure', 'retention', 'accessibility', 'accessibility-statement'];");
    expect(legal).toContain('const CROSS_LINK_CLAUSES: Record<LegalPageKey, string> = {');
    expect(legal).toContain('accessibilityLabel={`${item.title}, current page`}');
    expect(legal).toContain('accessibilityState={{ disabled: true }}');
    expect(legal).toContain('>Current</Text>');
    // The old block dropped the current page and shipped no second line.
    expect(legal).not.toContain('LEGAL_PAGE_KEYS.filter((key) => key !== current)');
    // A document the canonical order forgets still appears.
    expect(legal).toContain('LEGAL_PAGE_KEYS.filter((key) => !CROSS_LINK_ORDER.includes(key))');
  });
});

// ---------------------------------------------------------------------------

describe('IA wave B review fixes', () => {
  it('stacks the chart series on the order whose weakest seam is highest (iab order ruling)', () => {
    const ramp = read('../theme/statusRamp.ts');
    expect(ramp).toContain("['done', 'queued', 'active', 'attention']");
    // The first pass optimised one seam and opened a worse one (queued touching
    // attention at 1.243:1). The rule is the floor across every adjacency, and
    // 1.554:1 is the best any permutation of the four shipped light inks
    // reaches — so this pin is a real ceiling, not a preference.
    const order = ['statusDone', 'statusQueued', 'statusActive', 'statusAttention'] as const;
    const seams = order.slice(0, -1).map((token, index) => ratio(palette['union-ground']![token]!, palette['union-ground']![order[index + 1]!]!));
    expect(Math.min(...seams)).toBeGreaterThanOrEqual(1.554);
  });

  it('separates the quorum bar at the fill, leaving both tracks on the muted step', () => {
    // The first pass darkened the track to `border`; that is the hairline
    // step, and a 6pt bar filled with it reads as part-full at 0%. Both tracks
    // are back on the muted canvas and the separation moved to the fill.
    const feature = read('../features/FeatureScreen.tsx');
    expect(feature).toContain('styles.workTrack, { backgroundColor: theme.muted, borderColor: theme.border }');
    expect(feature).not.toContain('styles.workTrack, { backgroundColor: theme.border');
    // The desk hero fill is the ramp's attention step, which the contrast
    // audit already holds at 3:1+ on the muted body (light computes 4.37:1).
    expect(feature).toContain('backgroundColor: theme.statusAttention }]');
    expect(ratio(palette['union-ground']!.muted!, palette['union-ground']!.statusAttention!)).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['union-ground-dark']!.muted!, palette['union-ground-dark']!.statusAttention!)).toBeGreaterThanOrEqual(3);
  });
});

describe('IA wave A review refinements', () => {
  const ui = read('./ui.tsx');
  const legal = read('../features/LegalDocumentScreen.tsx');
  const feature = read('../features/FeatureScreen.tsx');
  const compass = read('./CompassPanel.tsx');

  it('states the Be heard submit condition on screen and clears it when met (iaa-16)', () => {
    expect(feature).toContain("const BE_HEARD_CONDITION = 'Choose a topic and add a few words to send.';");
    expect(feature).toContain('{unmet ? (');
    expect(feature).toContain('<Body muted>{BE_HEARD_CONDITION}</Body>');
    //  follow-up 5: the Android-only live region kept its attribute and
    // iOS gained the announcement it never had.
    expect(feature).toContain('accessibilityLiveRegion="polite"');
    expect(feature).toContain("import { useAccessibilityAnnouncementQueue } from '../lib/announce'");
    // iab F9: from the send handler, not from the state. Watching `unmet` fired
    // on every re-entry, so backspacing across the 8-character boundary spoke
    // the sentence over VoiceOver's echo of the deleted character. The send is
    // the transition with nothing else on screen to report it.
    expect(feature).toMatch(/void haptics\.success\(\);[\s\S]{0,240}?queueAnnouncement\(BE_HEARD_CONDITION\);\s*\}\}/);
    expect(feature).not.toContain('if (unmet && !wasUnmet.current) queueAnnouncement(BE_HEARD_CONDITION);');
    expect(feature).not.toContain('const wasUnmet =');
    // The visible line is still the reactive half of the same rule.
    expect(feature).toContain('const unmet = topic === null || body.trim().length < 8;');
  });

  it('labels the Be heard topic group visibly (iaa-17)', () => {
    expect(feature).toContain('Choose one topic</Text>');
  });

  it('separates rights index rows with the audited border token, not muted (iaa-19)', () => {
    const row = feature.slice(feature.indexOf('styles.rightsIndexRow'), feature.indexOf('styles.rightsIndexRow') + 400);
    expect(row).toContain('borderTopColor: theme.border');
    expect(row).not.toContain('borderTopColor: theme.muted');
  });

  it('gives the shared secondary button the level-1 hairline (shared MAJOR)', () => {
    // The fill measured 1.08:1 against porcelain, so the control had no edge.
    // Same repair as the w2b-9 confirmation field, on the variant rather than
    // the disabled state, so a disabled secondary keeps its edge too.
    expect(ui).toContain("const outlined = variant === 'secondary';");
    expect(ui).toContain('outlined ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border } : null,');
    // The fill is untouched and the variant is not promoted to primary.
    expect(ui).toContain("? { background: theme.secondary, foreground: theme.secondaryForeground }");
    // The hairline is a real edge on both the canvas and the white card it can
    // also sit on, in both schemes.
    for (const mode of themeModes) {
      const tokens = palette[mode]!;
      for (const surface of ['background', 'card', 'secondary'] as const) {
        expect(ratio(tokens[surface]!, tokens.border!), `${mode} secondary button edge on ${surface}`)
          .toBeGreaterThanOrEqual(ICON_CONTRAST_FLOOR);
      }
    }
  });

  it('moves the jump card to the interactive rung and states its size', () => {
    // Tinted fill from the secondary family — the Compass sources treatment —
    // over the level-1 hairline Card already carries. No new hex, no shadow.
    expect(legal).toContain('<Card style={[styles.jumpCard, { backgroundColor: theme.secondary }]}>');
    expect(legal).toContain('>On this page · {sections.length} sections</Body>');
    expect(legal).toContain('accessibilityLabel={`On this page, ${sections.length} sections`}');
    // The white card fill and the bare background flash are both gone.
    expect(legal).not.toContain('<Card style={styles.jumpCard}>');
    expect(legal).not.toContain('style={({ pressed }) => [styles.jumpHeader, pressed ? { backgroundColor: theme.muted } : null]}');
    // Collapsed by default, and the row separators read on the tinted fill.
    expect(legal).toContain('const [expanded, setExpanded] = useState(false);');
    expect(legal).toContain('{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },');
    // Text stays inside the audited secondary pairing.
    expect(legal).toContain('{ color: theme.secondaryForeground }');
  });

  it('narrows the gate sentence to the hats the worker actually holds', () => {
    // Three-part template, recorded in the component doc comment so a future
    // gate cannot drift out of it.
    expect(feature).toContain('1. **Destination title.**');
    expect(feature).toContain('2. **Qualifying-hats sentence.**');
    expect(feature).toContain('3. **Action button.**');
    // The intersection: qualifying hats ∩ the hats the preview store holds.
    expect(feature).toContain("const heldHats = mode === 'preview' ? PREVIEW_HATS : [];");
    expect(feature).toContain('heldHats.filter((item) => qualifyingHats.includes(item.key))');
    expect(feature).toContain('const sentence = qualifying.length > 0 ? qualifyingSentence(qualifying.map((item) => item.label)) : body;');
    expect(feature).toContain('function qualifyingSentence(labels: string[]): string {');
    expect(feature).toContain('return `The ${labels[0]} role opens it.`;');
    // A staff desk qualifies its own hat; a staff tool every hat but Member.
    expect(feature).toContain('qualifyingHats={[featureKey]}');
    expect(feature).toContain("qualifyingHats={['steward']}");
    expect(feature).toContain('qualifyingHats={STAFF_HAT_KEYS}');
    expect(feature).toContain('qualifyingHats={isPreviewHatKey(expectedHat) ? [expectedHat as PreviewHatKey] : undefined}');
    expect(feature).toContain("const STAFF_HAT_KEYS: PreviewHatKey[] = PREVIEW_HATS");
    // A live session supplies no held hats, so its gate keeps the filed
    // sentence and still takes no button.
    expect(feature).toContain('Ask a campaign administrator if your assignment changed.');
    for (const liveSessionGate of liveSessionAuthorizationGates(feature)) {
      expect(liveSessionGate.length).toBeGreaterThan(0);
      expect(liveSessionGate).not.toContain('qualifyingHats');
    }
    // The action stays in the button, not in the sentence.
    expect(feature).toContain('label="Switch role"');
  });

  it('ships no Dues destination on any hat', () => {
    // Dues belong to an existing union; Union Ground leaves them out.
    expect(FEATURE_KEYS as readonly string[]).not.toContain('dues');
    expect(feature).not.toContain('DUES_HAT_KEYS');
    expect(feature).not.toContain("featureKey === 'dues'");
  });

  it('caps the Guide sources block at three rows with a More row', () => {
    expect(compass).toContain('const SOURCE_ROWS_VISIBLE = 3;');
    expect(compass).toContain('const shownSources = sourcesExpanded ? allSources : allSources.slice(0, SOURCE_ROWS_VISIBLE);');
    expect(compass).toContain('{shownSources.map((source, index) => {');
    //  follow-up 1 (a11y conformance): the count is a property of the
    // answer, not of the toggle, so it survives the block being open and the
    // row can still say what collapsing would hide.
    expect(compass).toContain('const hiddenSources = Math.max(0, allSources.length - SOURCE_ROWS_VISIBLE);');
    expect(compass).toContain("accessibilityLabel={sourcesExpanded ? t('Fewer sources') : t('More sources, {count} more', { count: hiddenSources })}");
    expect(compass).toContain("accessibilityHint={sourcesExpanded ? t('Hides the extra approved sources') : t('Shows the remaining approved sources')}");
  });

  it('makes the Guide More-sources row a real toggle with a live expanded state', () => {
    // The row used to hardcode `expanded: false` and then unmount itself on
    // press, so VoiceOver reported a state that was never true and then lost
    // focus. A control that claims `expanded` has to answer for both values.
    expect(compass).toContain('accessibilityState={{ expanded: sourcesExpanded }}');
    expect(compass).not.toContain('accessibilityState={{ expanded: false }}');
    expect(compass).toContain('const sourcesExpanded = expandedSources[message.id] === true;');
    expect(compass).toContain('setExpandedSources((current) => ({ ...current, [messageID]: !current[messageID] }));');
    // The row stays mounted in both states, so focus stays on the control the
    // member just operated: it is rendered on the cap, never on the toggle.
    expect(compass).toContain('{hiddenSources > 0 ? (');
    // Label, copy and chevron all move together.
    expect(compass).toContain("{sourcesExpanded ? t('Fewer sources') : t('More sources · {count}', { count: hiddenSources })}");
    expect(compass).toContain("name={sourcesExpanded ? 'chevron-up' : 'chevron-down'}");
    // Expands in place through the shared expansion primitive, instantly under
    // Reduce Motion — the same branch every expansion in the app takes. Pin
    // updated by the Codex IA-A review: the one-off constant is gone.
    expect(compass).toContain("import { configureExpansion } from '../lib/expansion'");
    expect(compass).toContain('function expandSources(messageID: string) {');
    expect(compass).toContain('configureExpansion(reduceMotion);');
    expect(compass).not.toContain('SOURCES_EXPAND_MS');
    // Same 48px row anatomy, and the count rides the title so second lines
    // stay provenance-only.
    expect(compass).toContain('source: { minHeight: minimumTouchTarget,');
    expect(compass.match(/styles\.sourceRef/g)?.length).toBe(1);
  });

  it('compresses the source rows and the jump card instead of only dimming them', () => {
    // Codex IA-A review, item 3. The native depth contract: "Pressed
    // elements compress or lower subtly", implemented "through shared tokens
    // and primitives … not one-off per-screen shadow or animation constants".
    // The 0.82 dim is not dropped — it is Button's own `pressedOpacity`, so
    // these rows now mirror the shared control exactly, and Reduce Motion is
    // degraded to no motion inside PressableScale rather than per screen.
    for (const [name, source] of [['Compass sources', compass], ['legal jump card', legal]] as const) {
      expect(source, `${name} must consume the shared press primitive`)
        .toContain('<PressableScale');
      // Level 0: a row inside a flat grouped block never floats, so the
      // spring compresses without inventing a shadow the block does not have.
      expect(source, `${name} rests flat`).toContain('resting={elevation.level0}');
      expect(source, `${name} keeps Button's dim on the way down`).toContain('pressedOpacity={0.82}');
    }
    // Compression plus dim was invisible on a flat
    // level-0 row, so the Compass rows also paint a pressed fill.
    expect(compass.match(/pressedFill=\{pressedRowFill\(theme\.foreground\)\}/g)?.length, 'both Guide row kinds paint the pressed fill').toBe(2);
    // No hand-rolled opacity-only pressed style may survive on these rows.
    expect(compass).not.toMatch(/styles\.source,[\s\S]{0,240}opacity: pressed/);
    expect(legal).not.toMatch(/styles\.jump(Header|Row)[\s\S]{0,160}opacity: pressed/);
    // 48px targets and the VoiceOver labels survive the swap.
    expect(compass).toContain('source: { minHeight: minimumTouchTarget,');
    expect(compass).toContain("? t('Opens this approved source')");
    expect(compass).toContain(": t('Puts a follow-up question about this source in the composer')");
    // The More-sources hint became a toggle-aware ternary in IA wave B; it is
    // pinned in full by the toggle test above.
    expect(compass).toContain("'Shows the remaining approved sources'");
    expect(legal).toContain('jumpHeader: { minHeight: minimumTouchTarget,');
    expect(legal).toContain('jumpRow: { minHeight: minimumTouchTarget,');
    // The header hint follows the same `expanded` value as its state and
    // chevron: once open, the next press collapses the links, so it cannot
    // keep promising to show them.
    expect(legal).toContain("accessibilityHint={expanded ? 'Hides the section links' : 'Shows a link to each section'}");
    expect(legal).not.toContain('accessibilityHint="Shows a link to each section"');
    expect(legal).toContain('accessibilityHint="Jumps to this section"');
  });
});

describe('finite, edge-to-edge Home feed (owner correction 2026-08-26)', () => {
  const geometry = read('../lib/chromeGeometry.ts');
  const chrome = read('../lib/chrome.ts');
  const ui = read('./ui.tsx');
  const hats = read('./HatSwitcher.tsx');
  const root = read('../../app/_layout.tsx');
  const tabs = read('../../app/(tabs)/_layout.tsx');
  const home = read('../../app/(tabs)/home.tsx');

  it('has one honest content copy and no teleport geometry', () => {
    expect(home).toContain('<Screen tabRoot bottomInset={bottomInset} scrollsTopChrome>');
    expect(home).not.toMatch(/<Screen[^>]*\bloop(?:\s|>)/);
    expect(geometry).not.toContain('loopScrollAdjustment');
    expect(geometry).not.toContain('loopEligible');
    expect(geometry).not.toContain('LOOP_EDGE_GUARD');
    expect(ui).not.toContain('loopCopy');
    expect(ui).not.toContain('loopActive');
    expect(ui).not.toContain('scrollTo({ y: loopStep');
  });

  it('keeps a truthful scroll extent and restores normal refresh behavior', () => {
    expect(ui).toContain('showsVerticalScrollIndicator');
    expect(ui).toContain('refreshControl={onRefresh ? <RefreshControl');
    expect(ui).toContain('{children}');
    expect(ui).not.toContain('accessibilityElementsHidden={loopEngaged}');
  });

  it('starts on the shared content line, then moves all Home chrome to the top edge', () => {
    expect(ui).toContain('const startLine = pinned?.contentInset ?? contentStartInset(insets.top);');
    expect(ui).toContain('if (scrollsTopChrome) syncHomeAwayFromTop(event.nativeEvent.contentOffset.y)');
    expect(ui).toContain('<Animated.ScrollView');
    expect(ui).toContain('{ useNativeDriver: true, listener: publishScrollState }');
    // Nothing is fixed at the top: Home's own chrome travels with the feed
    // and no ramp stays behind under the clock .
    expect(ui).not.toContain('TopRamp');
    expect(chrome).toContain('export const homeScrollOffset = new Animated.Value(0)');
    expect(hats).toContain('const homeTravel = Animated.multiply(homeScrollOffset, -1)');
    expect(hats).toContain('accessibilityElementsHidden={scrollsWithHome && homeAwayFromTop}');
    expect(hats).toContain("importantForAccessibility={scrollsWithHome && homeAwayFromTop ? 'no-hide-descendants' : 'auto'}");
    expect(root).toContain("<HatSwitcher scrollsWithHome={pathname === '/home'} onMenuVisibilityChange={setHatMenuOpen} />");
  });

  it('clears the final item and asks the native bar to minimize on scroll', () => {
    expect(ui).toContain('const bottomPadding = bottomInset ?? screenBottomInset(insets.bottom)');
    expect(ui).toContain('{ paddingTop: topPadding, paddingBottom: bottomPadding }');
    expect(home).toContain('const bottomInset = useNativeTabContentInset(true);');
    expect(tabs).toContain("minimizeBehavior={screenReader || pathname !== '/home' || restoringTabBar ? 'never' : 'onScrollDown'}");
    expect(chrome).toContain('export function useHomeAwayFromTop(): boolean');
    expect(chrome).toContain('export function requestHomeScrollToTop(): void');
    expect(ui).toContain("ownedScrollRef.current?.scrollTo({ y: 0, animated: !reduceMotion })");
    expect(tabs).toContain("Platform.OS === 'android' && pathname === '/home' && homeAwayFromTop");
    expect(tabs).toContain("accessibilityLabel={t(\"Home, navigation minimized\")}");
    expect(tabs).toContain('requestHomeScrollToTop()');
    expect(tabs).toContain("width: '20%'");
    expect(tabs).toContain('width: minimumTouchTarget');
    expect(tabs).toContain('<Ionicons name="home" size={24} color={theme.primaryForeground} />');
    // The minimized control keeps its own 3:1 surface, bounded to the touch
    // target in the left slot. The fill is the surface; the slot stays 20%.
    expect(tabs).toContain('style={[styles.androidHome, { backgroundColor: theme.primary, borderRadius: radii.pill }]}');
    expect(tabs).toContain("width: '20%'");
    expect(tabs).toContain('width: minimumTouchTarget');
  });

  it('leaves no touch-intercepting tab host over Android Home content while navigation is minimized', () => {
    const carousel = read('./HomeCarousel.tsx');
    // The native host is hidden, and it is not replaced by a full-width control.
    expect(tabs).toContain('hidden={hidden || androidHomeOnly}');
    expect(tabs).toContain('pointerEvents="box-none"');
    expect(tabs).toContain("width: '20%'");
    expect(tabs).not.toContain('right: 0,\n    alignItems: \'center\',\n  },\n  androidHome:');
    // Home's own box ends above the band that hidden host can still hit and
    // clips the handles riding their row below it; a row is never pinned to
    // the box edge over the desk card .
    expect(carousel).toContain('marginBottom: minimizedReserve');
    expect(carousel).toContain('androidMinimizedHomeReserve(insets.bottom, spacing.xl, minimumTouchTarget)');
    expect(carousel).toContain("homeBox: { flex: 1, overflow: 'hidden' },");
    expect(carousel).not.toContain('handleScrollLift');
    expect(carousel).not.toContain('handleLift');
    expect(geometry).toContain('export function androidMinimizedHomeReserve');
    expect(geometry).toContain('export function homeHandleDrawnSpan');
    expect(geometry).not.toContain('export function clampedHandleTranslate');
    expect(carousel).not.toContain('handleRowHidden');
  });

  it('keeps the Home ScrollView discoverable by the native iOS tab host', () => {
    expect(ui).toContain("import { ScrollViewMarker } from 'react-native-screens/experimental'");
    expect(ui).toContain("(scrollsTopChrome || tabRoot) && Platform.OS === 'ios'");
    // Only tab root routes: a pushed screen with a bottom inset (Union,
    // Account) has no tab bar and takes no edge effect.
    // Messages and Pulse are pushed screens in this edition's five-tab dock.
    for (const root of ['../../app/(tabs)/home.tsx', '../features/WorkScreen.tsx']) {
      expect(read(root), root).toContain('<Screen tabRoot bottomInset={bottomInset}');
    }
    expect(read('../../app/(tabs)/campaign.tsx')).not.toContain('<Screen tabRoot');
    expect(read('../../app/(tabs)/account.tsx')).not.toContain('<Screen tabRoot');
    expect(ui).toContain('<ScrollViewMarker style={styles.safe} scrollEdgeEffects={TAB_BAR_EDGE_EFFECTS}>{scrollSurface}</ScrollViewMarker>');
    // Every iOS tab root turns UIKit's bottom scroll-edge effect off, so no
    // frosted band sits above the tab bar (owner ruling, Nov 22-23, 2026,).
    expect(ui).toContain("const TAB_BAR_EDGE_EFFECTS: ComponentProps<typeof ScrollViewMarker>['scrollEdgeEffects'] = { bottom: 'hidden' };");
    // At Home's top the bar may not stay minimized: 'never' brings it back.
    expect(tabs).toContain("minimizeBehavior={screenReader || pathname !== '/home' || restoringTabBar ? 'never' : 'onScrollDown'}");
  });

});
// ---------------------------------------------------------------------------
// IA wave B (triage "Accepted — screen-scoped": shared desk template, Home
// staff shortcut + hat-aware band, Pulse regrouping, drawer settle, and the
// eight-item follow-up lane from the  rounds). These pin the structures a
// reviewer read on a captured frame, so a later edit cannot quietly return the
// screen the review rejected.
// ---------------------------------------------------------------------------

describe('shared staff-desk template (b03b)', () => {
  const feature = read('../features/FeatureScreen.tsx');

  it('serves all five desks from one template with a per-desk hero identity', () => {
    // One template, five identities: the desk names the KPI it leads with and
    // the template does the rest, so a sixth desk cannot ship a sixth layout.
    expect(feature).toContain('const DESK_HERO_KPI: Record<string, string> = {');
    for (const hat of ['steward', 'coordinator', 'advisor', 'admin', 'vp']) {
      expect(feature, `${hat} must name its hero KPI`).toMatch(new RegExp(`\\n  ${hat}: '`));
    }
    expect(feature).toContain('const hero = kpis.find((item) => item.label === heroLabel) ?? kpis[0] ?? null;');
    expect(feature).toContain('const supporting = kpis.filter((item) => item !== hero);');
    // Hero-plus-two: the hero takes the shared hero pass and the display size,
    // the other two sit beside it on the contact pass.
    expect(feature).toContain('<Card hero>');
    // iab F10: shrink-to-fit, the same treatment Home's stat value already
    // takes — a 40px display size and a value like "213/300" cannot both be
    // assumed to fit one line at every text size.
    expect(feature).toContain('<Text adjustsFontSizeToFit numberOfLines={1} style={[styles.deskHeroValue, { color: theme.cardForeground }]}>{hero.value}</Text>');
    expect(read('../../app/(tabs)/home.tsx')).toContain('<NumberFlow decorative adjustsFontSizeToFit numberOfLines={1} value={cell.value} style={styles.statValue} />');
    expect(feature).toContain('deskKpiRow: { flexDirection: \'row\',');
    // The three stacked one-number cards the template replaced.
    expect(feature).not.toContain('{kpis.map((item) => (');
  });

  it('carries the role eyebrow over the work noun (b03a-3, deferred from #1018)', () => {
    // "ADMIN DESK" over "Chapter admin": the role noun wins wherever a hat is
    // named, and the desk keeps the work noun under an 11px role eyebrow.
    expect(feature).toContain('`${(PREVIEW_HATS.find((item) => item.key === expectedHat)?.label ?? expectedHat).toUpperCase()} DESK`');
    expect(feature).toContain("roleEyebrow: { fontSize: 11,");
    expect(feature).toContain('<Text style={[styles.roleEyebrow, { color: theme.primary }]}>{eyebrow}</Text>');
    // And the verbatim one-sentence status line is still the desk's own copy.
    expect(feature).toContain("<Body muted>{previewDesk?.summary ?? 'Authorized desk work for this role.'}</Body>");
  });

  it('draws the one gold progress bar on a ratio hero (b03b-11)', () => {
    // The president's 213/300 got its denominator named in; this is the
    // other half. The rule is the shape of the value, not the name of the desk,
    // so exactly one desk in the roster has a ratio and exactly one bar ships.
    expect(feature).toContain('function deskHeroProgress(value: string)');
    expect(feature).toContain('accessibilityRole="progressbar"');
    expect(feature).toContain('accessibilityValue={{ min: 0, max: heroProgress.total, now: heroProgress.done }}');
    // Gold is a fill role here (brief §B), and it is the *one* gold-family
    // progress bar b03b-11 asked for: every other track in the file fills
    // aubergine. iab F1 moved it off raw `accent` (1.83:1 on the track) and
    // onto the ramp's attention step, which the audit already holds at 3:1+.
    expect(feature.match(/styles\.(work|driver)Fill[\s\S]{0,200}?backgroundColor: theme\.statusAttention/g)?.length).toBe(1);
    expect(feature.match(/styles\.(work|driver)Fill[\s\S]{0,200}?backgroundColor: theme\.accent/g) ?? []).toHaveLength(0);
    expect(feature).toContain("styles.workFill, { width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: theme.primary }");
    expect(feature).toContain("styles.driverFill, { width: `${Math.max(3, Math.min(100, value))}%`, backgroundColor: theme.primary }");
  });

  it('indexes the desk sections at 48px with count badges and honest chevrons', () => {
    expect(feature).toContain('deskSectionRow: { minHeight: minimumTouchTarget,');
    // iab F2: the badge counts the row's own noun, from an explicit per-key
    // map — not the row's widget data source. Through `widgetSourceFor` the
    // admin "Form templates" row wore a 3 under a "7 active templates" KPI,
    // "Active cases" wore a 5 beside an "Open cases 4" hero, "Membership
    // trend" counted ballots and "By article cited" counted forms.
    expect(feature).toContain('function deskSectionCount(sectionKey: string, desk: PreviewDesk | null, openCases: number, unreadThreads: number)');
    expect(feature).toContain('switch (sectionKey) {');
    expect(feature).not.toContain('switch (widgetSourceFor(sectionKey)) {');
    expect(feature).not.toContain("import { STAFF_HAT_FUNCTIONS, widgetSourceFor } from '../lib/hatFunctions';");
    for (const contradicted of ['coordinator-articles', 'vp-trend']) {
      expect(feature, `${contradicted} must not carry a badge`).toContain(`case '${contradicted}': return null;`);
    }
    expect(feature).toContain("case 'coordinator-cases': return openCases;");
    expect(feature).toContain("case 'steward-messages': return unreadThreads;");
    expect(feature).toContain('const openCases = cases.filter((item) => item.status === \'active\').length;');
    // iab F7: a countable collection renders its number including 0. The
    // missing badge is reserved for a row that is a view rather than a queue,
    // so the two states stay distinguishable.
    expect(feature).toContain("case 'advisor-turnout': return desk?.ballots.length ?? null;");
    expect(feature).not.toContain('rather than a zero the fixture cannot stand behind');
    expect(feature).toContain('default: return null;');
    expect(feature).toContain('{count != null ? (');
    // Chevron only on the rows that push. Same-desk rows have no real section
    // target, so they stay static readings rather than fake jump buttons.
    expect(feature).toContain('{sameDesk ? null : <Ionicons name="chevron-forward"');
    // Pressed compression comes from the shared primitive, at level 0 because a
    // row inside a grouped card never floats.
    expect(feature).toContain('resting={elevation.level0}');
    expect(feature).toContain('pressedOpacity={0.82}');
    // VoiceOver hears the count, not just the label.
    expect(feature).toContain('accessibilityLabel={count != null ? `${section.label}, ${count}` : section.label}');
    const desk = withoutComments(feature.slice(feature.indexOf('function DeskFeature('), feature.indexOf('\nconst styles = StyleSheet.create'))).replace(/\s+/g, ' ');
    expect(desk).toContain('const sameDesk = isSameDeskSection(section, expectedHat);');
    expect(desk).toContain('if (sameDesk) { return ( <View key={section.key} accessible accessibilityLabel={count != null ? `${section.label}, ${count}` : section.label} style={[styles.deskSectionRow, divider]} >');
    expect(desk).toContain('<PressableScale key={section.key} accessibilityRole="button"');
    expect(desk).toContain('onPress={() => { void haptics.select(); router.push(section.href as never); }}');
    expect(desk).not.toContain('planDeskJump');
    expect(desk).not.toContain('performDeskJump');
    expect(desk).not.toContain('jumpToSection');
    expect(desk).not.toContain('setAccessibilityFocus');
    expect(desk).not.toContain('findNodeHandle');
    expect(desk).not.toContain('arrow-down');
    expect(desk).not.toContain('sectionTops');
    expect(desk).not.toMatch(/if \(sameDesk\) \{ return \( <PressableScale/);
  });
});

describe('Home staff desk shortcut and hat-aware band (b03a-6/13)', () => {
  const home = read('../../app/(tabs)/home.tsx');

  it('routes Home to the selected hat\'s desk with the desk\'s own sentence', () => {
    // b03a-6: putting on a staff hat changed the numbers and stranded the work
    // — there was no route at all from Home to that hat's desk.
    expect(home).toContain('const deskPath = staffHat ? `/feature/${staffHat}` : null;');
    expect(home).toContain('const DESK_SHORTCUT_HEIGHT = 72;');
    expect(home).toContain('minHeight: DESK_SHORTCUT_HEIGHT,');
    // It reuses the desk's status sentence rather than inventing a second
    // description of the same desk.
    expect(home).toContain('<Text numberOfLines={2} style={styles.deskHeroSub}>{previewDesk.summary}</Text>');
    expect(home).toContain('{FEATURE_TITLES[staffHat]}');
    expect(home).toContain('function deskEyebrow(hat: Exclude<PreviewHatKey, \'member\'>): string {');
    // And it is hat-conditional: the member hat has no desk to shortcut.
    expect(home).toContain('{staffHat && previewDesk && deskPath ? (');
  });

  it('reports desk numbers on a staff hat instead of worker arithmetic (b03a-13)', () => {
    // The Admin Home used to open on 0 open cases / 0 due / 18 unread / 1
    // action — four member numbers under a staff identity.
    expect(home).toContain('const deskCells = (previewDesk?.kpis ?? []).map((kpi) => ({');
    expect(home).toContain('const statCells = staffHat && deskCells.length > 0 ? deskCells : memberCells;');
    // Every staff cell routes to that desk, not to the member Work tab.
    expect(home).toContain("href: deskPath ?? '/(tabs)/home',");
    // The band still renders once, so the two hats cannot diverge in anything
    // but their data.
    expect(home).toContain('{statCells.map((cell, index) => (');
    expect(home).toContain('accessibilityLabel={cell.announce}');
    // Cells are flat panes inside one banded surface, hairline-separated.
    expect(home).toContain('statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: theme.border },');
  });
});

describe('#1021 follow-up lane', () => {
  const feature = read('../features/FeatureScreen.tsx');
  const legal = read('../features/LegalDocumentScreen.tsx');
  const header = read('./PinnedHeader.tsx');
  const back = read('../lib/screenBack.ts');

  it('2 — answers Back from the rights reading view instead of popping the feature', () => {
    // Back used to pop the whole feature, so a member who opened Weingarten and
    // pressed Back landed on Home rather than on the list they were reading.
    expect(back).toContain('export function runScreenBackInterceptor(): boolean {');
    expect(back).toContain('export function useScreenBackInterceptor(handler: ScreenBackInterceptor | null): void {');
    // Both entry points, so the header chevron and the Android hardware button
    // can never disagree about which level Back is on.
    expect(back).toContain("BackHandler.addEventListener('hardwareBackPress', () => handler());");
    expect(header).toContain('if (runScreenBackInterceptor()) return;');
    // iab F4: focus-gated, not mount-gated. The slot is global, so a lesson
    // left mounted under a pushed conversation must release it or it swallows
    // the first Back press on the screen that is actually on top.
    expect(feature).toContain("import { useIsFocused, useNavigation, useRouter } from 'expo-router';");
    expect(feature).toContain('const isFocused = useIsFocused();');
    expect(feature).toContain('const routedLessonOpen = Boolean(sourceID && !sourceDismissed && lesson);');
    expect(feature).toContain('useScreenBackInterceptor(isFocused && openID !== null && !routedLessonOpen ? interceptBack : null);');
    expect(feature).not.toContain('useScreenBackInterceptor(openID === null ? null : interceptBack);');
    expect(back).toContain('Pass `null` whenever the screen is not focused.');
    expect(feature).toContain('if (openID === null) return false;');
    // iab F5: the iOS left-edge swipe is a gesture on the stack and would pop
    // the whole feature past the interceptor, so it stands down for exactly as
    // long as a lesson is open and is restored on the way back to the index.
    expect(feature).toContain('navigation.setOptions({ gestureEnabled: openID === null || routedLessonOpen });');
    // The scroll reset: index and reading view share one surface, so without
    // it the reader arrives mid-script — or back on the index at the script's
    // offset.
    expect(feature).toContain('scrollRef.current?.scrollTo({ y: 0, animated: false });');
    expect(feature).toContain('}, [openID]);');
  });

  it('3 — says how much of the pre-query list it is showing', () => {
    expect(feature).toContain('`Showing ${results.length} of ${scoped.length}`');
    expect(feature).toContain('results.length < scoped.length');
    // The plain scope label survives for a scope that fits under the cap.
    expect(feature).toContain(": 'In this scope'}");
  });

  it('4 — branches the share haptic on the result and surfaces a real failure', () => {
    expect(feature).toContain('if (result.action === Share.sharedAction) {');
    expect(feature).toContain('void haptics.success();');
    expect(feature).toContain('{shareError ? <Notice>{shareError}</Notice> : null}');
    expect(feature).toContain('void haptics.warning();');
    // The old handler cheered on dismissal and swallowed the throw.
    expect(feature).not.toMatch(/await Share\.share\(\{ title: lesson\.title[\s\S]{0,80}\n\s*void haptics\.select\(\);/);
  });

  it('6 — caps Read large so it cannot double-scale at an AX step', () => {
    expect(feature).toContain('const RIGHTS_SCRIPT_MAX_SCALE = 2;');
    // Both modes top out at the same ceiling, so the button is a shortcut to
    // it rather than a second multiplier on top of Dynamic Type.
    expect(feature).toContain('const RIGHTS_SCRIPT_LARGE_MAX_SCALE = (RIGHTS_SCRIPT_MAX_SCALE * RIGHTS_SCRIPT_SIZE) / RIGHTS_SCRIPT_LARGE_SIZE;');
    expect(feature).toContain('maxFontSizeMultiplier={readLarge ? RIGHTS_SCRIPT_LARGE_MAX_SCALE : RIGHTS_SCRIPT_MAX_SCALE}');
    expect(RIGHTS_SCRIPT_LARGE_CEILING).toBe(RIGHTS_SCRIPT_PLAIN_CEILING);
  });

  it('8 — never leaves a top hairline where the first ordered legal key is missing', () => {
    // The divider used to ride the *ordered* index, so a key the order names
    // but the document set no longer ships left the next row carrying a top
    // hairline against the card's own rounded edge.
    expect(legal).toContain('const rows = ordered');
    expect(legal).toContain('.filter((entry): entry is { key: LegalPageKey; item: NonNullable<ReturnType<typeof legalDocument>> } => entry.item != null);');
    expect(legal).toContain('{rows.map(({ key, item }, index) => {');
    expect(legal).toContain('const divider = index > 0 ?');
    // The old shape: a null row consumed an index.
    expect(legal).not.toContain('if (!item) return null;');
    // The canonical order and its forgotten-key fallback are untouched.
    expect(legal).toContain('LEGAL_PAGE_KEYS.filter((key) => !CROSS_LINK_ORDER.includes(key))');
  });
});

// The two ceilings item 6 asserts are equal, computed here rather than trusted
// from the source string, so a later edit to either constant has to keep the
// property the finding actually asked for.
const RIGHTS_SCRIPT_PLAIN_CEILING = 17 * 2;
const RIGHTS_SCRIPT_LARGE_CEILING = 22 * ((2 * 17) / 22);

// ---------------------------------------------------------------------------
// REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010
// (docs/mobile/top-chrome-progressive-blur-spec-20261010.md). The owner's
// October 10 decision: no band, no bar, no hairline; one progressive blur under
// the status bar; free-floating 26pt controls; one content start line; one
// title scale. The arithmetic itself is executed in ../lib/chromeGeometry.test.ts.
// ---------------------------------------------------------------------------

describe('one top treatment, one start line, one title scale (top-chrome 2026-10-10)', () => {
  const hats = read('./HatSwitcher.tsx');
  const ui = read('./ui.tsx');

  // Every surface in the record's scope, plus the two overlays it does not
  // name, so the exceptions stay deliberate instead of accumulating.
  const SCOPED_SURFACES = [
    './ui.tsx',
    './PinnedHeader.tsx',
    './HatSwitcher.tsx',
    './HomeCarousel.tsx',
    './QuickActionsDrawer.tsx',
    './TopChrome.tsx',
    '../features/PulseScreen.tsx',
    '../../app/(tabs)/compass.tsx',
    '../../app/conversation/[id].tsx',
  ];
  // Out of the record's scope on purpose: `mfa-challenge.tsx` is a pre-session
  // challenge with no chrome over it, and `ChapterRail.tsx` is the chapter rail
  // the owner's captures did not include.
  const OUT_OF_SCOPE = ['../../app/mfa-challenge.tsx', './ChapterRail.tsx'];

  it('leaves no surface in scope computing its own top inset', () => {
    for (const file of SCOPED_SURFACES) {
      const source = withoutComments(read(file));
      // The seven formulas the record inventoried all had this shape.
      expect(source, `${file} must not add its own top inset`).not.toMatch(/insets\.top\s*\+/);
      expect(source, `${file} must not keep the old helper`).not.toContain('floatingChromeTopInset');
      expect(source, `${file} must not keep the pinned-bar helper`).not.toContain('pinnedHeaderContentInset');
    }
    // The exceptions are named, and they are the only ones.
    for (const file of OUT_OF_SCOPE) {
      expect(withoutComments(read(file)), `${file} is the documented exception`).toMatch(/insets\.top\s*\+/);
    }
  });

  it('floats the hat pill at the shared control offset, in one line when compact', () => {
    expect(hats).toContain('const PILL_HEIGHT = FLOATING_CONTROL_SIZE;');
    expect(hats).toContain('const pillTop = floatingControlTop(insets.top, spacing.xs);');
    expect(hats).toContain('const pillBandHeight = floatingControlHitHeight(insets.top, pillTop);');
    expect(hats).toContain('{ top: pillTop, height: pillBandHeight }');
    // The same offset and bounds the back circle takes, from the same helpers.
    const header = read('./PinnedHeader.tsx');
    expect(header).toContain('const controlTop = floatingControlTop(insets.top, spacing.xs);');
    expect(header).toContain('const bandHeight = floatingControlHitHeight(insets.top, controlTop);');
    // One line, at the right gutter, on a pushed screen.
    expect(hats).toContain('{modeLabel} <Ionicons name="chevron-down" size={11} color={ink} /></Text>');
    expect(hats).not.toMatch(/pillInnerCompact: \{[^}]*flexDirection: 'column'/);
    expect(hats).toContain("paddingRight: pinnedHeaderLayout.hitInset,");
    // The 48pt compact capsule paints its whole width, so its column sits at the
    // painted gutter, not the round control's hit inset (it ran to the edge).
    expect(hats).toContain("anchorTrailing: {\n    alignItems: 'flex-end',\n    paddingRight: pinnedHeaderLayout.trailingInset,");
  });

  it('stops the pill sheen under Reduce Motion, through the ring it already had', () => {
    const shine = read('./ShineBorder.tsx');
    expect(hats).toContain('drift');
    expect(hats).toContain('duration={PILL_SHEEN_CYCLE_MS}');
    expect(hats).toContain('fillOpacity={PILL_SHEEN_FILL_OPACITY}');
    // One Reduce Motion branch, in the component that owns the animation, and
    // it parks the travel on frame zero rather than freezing a mid-slide.
    expect(shine).toMatch(/if \(reduceMotion\) \{[\s\S]*?travel\.stopAnimation\(\);\s*travel\.setValue\(0\);\s*return;/);
    expect(shine.indexOf('const loop = drift')).toBeGreaterThan(shine.indexOf('if (reduceMotion)'));
    expect(hats).not.toContain('Animated.loop');
  });

  it('paints page titles at one scale', () => {
    // Same scale; the family and weight (Archivo 800) come from the typography
    // role (UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115).
    expect(ui).toContain('heading1: { ...typeface.heading, fontSize: 22, lineHeight: 28, letterSpacing: -0.25 },');
    // A pushed screen's title is painted on the row beside Back at the same
    // scale, two lines at most, and no longer as a scrolled PageTitle.
    const header = read('./PinnedHeader.tsx');
    expect(header).toContain('title: { ...typeface.heading, fontSize: 22, lineHeight: 28, letterSpacing: -0.25 },');
    expect(header).toMatch(/numberOfLines=\{2\}\s+ellipsizeMode="tail"\s+allowFontScaling=\{false\}/);
    // Font size and line height scale together, up to the cap.
    expect(header).toContain('fontSize: PINNED_TITLE_FONT_SIZE * titleScale, lineHeight: PINNED_TITLE_LINE_HEIGHT * titleScale');
    expect(ui).not.toContain('PageTitle');
    expect(ui).not.toContain('pageSubtitle');
    expect(ui).toContain('numberOfLines={level === 1 ? 2 : undefined}');
    // The 33/38 Georgia serif left page titles entirely.
    expect(ui).not.toContain('fontSize: 33');
    expect(ui).not.toContain("fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' })");
    // Home's greeting keeps its own 23/26 serif: the sibling 320pt record owns
    // that line, and this change must not move it.
    const home = read('../../app/(tabs)/home.tsx');
    expect(home).toContain('greeting: { fontFamily: Platform.select({ ios: \'Georgia\', default: \'serif\' }), fontWeight: \'600\', fontSize: 23, color: theme.foreground, lineHeight: 26 },');
  });
});

describe('no phone screen draws a band at its top or bottom edge (#9607)', () => {
  // no band, blur, feather, gradient or scrim at the top or bottom of any
  // screen of the phone apps, iPhone and Android. A class check over every
  // app source, so a new screen cannot bring the ramp or a hard edge back.
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'testing' ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const sources = ['app', 'src'].flatMap((root) => walk(join(appRoot, root)));

  it('mounts no top ramp, gradient band or masked blur anywhere', () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      const name = relative(appRoot, file);
      expect(source, name).not.toMatch(/<TopRamp\b/);
      expect(source, name).not.toContain("from 'expo-linear-gradient'");
      expect(source, name).not.toContain("from '@react-native-masked-view/masked-view'");
    }
  });

  it('asks UIKit for no visible scroll-edge effect on any screen', () => {
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(appRoot, file)).not.toMatch(/(top|bottom): '(hard|soft)'/);
    }
  });
});
