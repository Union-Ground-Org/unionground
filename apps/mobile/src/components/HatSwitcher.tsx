import { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PREVIEW_HATS, type PreviewHatKey } from '../data/preview';
import {
  FLOATING_CONTROL_HIT_WIDTH,
  FLOATING_CONTROL_LIFT,
  FLOATING_CONTROL_SIZE,
  HAT_MENU_ROW_HEIGHT,
  HAT_MENU_WIDTH,
  PILL_SHEEN_CYCLE_MS,
  floatingControlHitHeight,
  floatingControlTop,
  hatMenuBottomInset,
  hatMenuMaxHeight,
  hatMenuTop,
  hatPillPlacementForPath,
  homeDrawerReveal,
  homeScrollOffset,
  useDockSuppressed,
  useHomeAwayFromTop,
} from '../lib/chrome';
import { useHatSwitcherRequests } from '../lib/hatSwitcher';
import { HAT_MENU_CLOSE_MS, HAT_MENU_OPEN_MS, HAT_MENU_TRAVEL, closeHatSwitcherMenu, openHatSwitcherMenu } from '../lib/hatSwitcherSheetMotion';
import { pinnedHeaderLayout } from '../lib/pinnedHeaderOrder';
import { nativeTabPath } from '../lib/quickActions';
import { useReduceMotion } from '../lib/reduceMotion';
import { useReduceTransparency } from '../lib/reduceTransparency';
import { haptics } from '../services/haptics';
import { SAMPLE_HATS } from '../services/sampleSession';
import { storeDemoText } from '../lib/storeDemoCopy';
import { useApp } from '../state/AppProvider';
import { elevation, pressedScale } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { ShineBorder } from './ShineBorder';
import { FrostedCapsule } from './TopChrome';
import { Body } from './ui';

import { typeface } from '../theme/typeface';
// The pill is its own floating frosted capsule now, the same height as every
// other floating control
// (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010): the
// 36pt pill rode a fixed strip, and on a pushed screen its compact form
// collapsed to a two-line stack 2pt from the screen edge.
const PILL_HEIGHT = FLOATING_CONTROL_SIZE;
// The tap target is the anchor slot, not a hitSlop: it is 48pt wide and holds
// 48pt below the safe-area line, anchored at the capsule's top edge so it never
// grows into the status-bar frame, where a tap is never delivered (gate round
// 3 on pull request 4254; the 8pt of overlap is added on top, not counted).
// The band was 36pt, ending at the content start line, until
// BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019 measured it on both
// phones; it now runs 20pt past that line, over the title text.
const COMPACT_PILL_WIDTH = FLOATING_CONTROL_HIT_WIDTH;
// The sheen on the fill is a hint of the ring's own light, never a second
// surface: the decorative palette would fail contrast if it carried anything.
const PILL_SHEEN_FILL_OPACITY = 0.1;

// Content can pass under the pill now, so the capsule carries a frosted
// backing under its gradient keyline and tinted fill, and a slow sheen drifts
// across both. Its dropdown is the only fully opaque surface. The menu drops
// from the pill it belongs to, the way a segmented picker or a nav-bar menu
// does on iOS.
export function HatSwitcher({ scrollsWithHome = false, onMenuVisibilityChange }: { scrollsWithHome?: boolean; onMenuVisibilityChange?: (visible: boolean) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const windowHeight = dimensions.height;
  const fontScale = dimensions.fontScale;
  // Above the default text size the role descriptions wrap in full, and from
  // the larger standard sizes (about 1.24 and up) the role menu also takes the
  // screen's width; every line in it stops at the app's 2x text cap. At XXXL
  // a fixed 280 pt menu chopped each role's words mid-line (demo audit, Nov 7,
  // 2026).
  const largeMenuText = fontScale > 1.2;
  const menuTextScale = Math.min(fontScale, HAT_MENU_TEXT_CAP);
  // The radio sits on the role name's line at every size, not the middle of a
  // tall row.
  const radioOffset = Math.max(0, (ROW_TITLE_LINE_HEIGHT * menuTextScale - RADIO_SIZE) / 2);
  const listRef = useRef<ScrollView>(null);
  const pathname = usePathname();
  const { mode, previewHat, switchPreviewHat, sampleHat, switchSampleHat, storeDemo, exitStoreDemo, storeDemoExitBusy, memberLanguage } = useApp();
  const demoText = storeDemoText(memberLanguage);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Live accounts have neither hat, so they never get a switcher.
  const activeHat = mode === 'preview' ? previewHat : sampleHat;
  const hats = mode === 'preview' ? PREVIEW_HATS : SAMPLE_HATS;
  const reduceMotion = useReduceMotion();
  // Whenever the list is taller than the menu (large text, a short screen):
  // as soon as it is measured it brings the current role into view, so an
  // Admin or President visitor sees their filled radio, and flashes the scroll
  // indicator; quiet hints then say while roles are hidden above or below.
  const rowLayouts = useRef(new Map<string, { y: number; height: number }>());
  const listViewport = useRef({ offset: 0, height: 0, content: 0 });
  const placedCurrentRole = useRef(false);
  const [endPadding, setEndPadding] = useState(0);
  const [hiddenRoles, setHiddenRoles] = useState({ above: false, below: false });
  const measureList = useCallback((next: Partial<{ offset: number; height: number; content: number }>) => {
    const viewport = { ...listViewport.current, ...next };
    listViewport.current = viewport;
    const overflows = viewport.height > 0 && viewport.content > viewport.height + 1;
    // Wait for every row: dynamic text gives each one a different height, and
    // native layout events need not arrive in role order.
    const selected = activeHat ? rowLayouts.current.get(activeHat) : undefined;
    if (viewport.height > 0 && !placedCurrentRole.current && selected && rowLayouts.current.size === hats.length) {
      const rows = [...rowLayouts.current.values()].sort((a, b) => a.y - b.y);
      const content = Math.max(...rows.map(row => row.y + row.height));
      const bottomClamp = Math.max(0, content - viewport.height);
      // Round the bottom clamp forward to a real row boundary. Rounding back
      // can hide the selected last row; native clamping can cut the first one.
      const boundary = rows.find(row => row.y >= bottomClamp)?.y ?? selected.y;
      const offset = Math.min(selected.y, boundary);
      const padding = Math.max(0, offset + viewport.height - content);
      setEndPadding(padding);
      // First let the trailing space reach native layout, otherwise scrollTo
      // would still be clamped to the old, mid-row maximum.
      if (viewport.content >= content + padding - 1) {
        placedCurrentRole.current = true;
        viewport.offset = offset;
        listRef.current?.scrollTo({ y: viewport.offset, animated: false });
        if (overflows) listRef.current?.flashScrollIndicators();
      }
    }
    const above = overflows && viewport.offset > 1;
    const below = overflows && viewport.offset + viewport.height < viewport.content - 1;
    setHiddenRoles((current) => (current.above === above && current.below === below ? current : { above, below }));
  }, [activeHat, hats.length]);
  // Reduce Transparency asks for opaque chrome: the pill takes the card fill
  // and keeps its ring and keyline, so the demo boundary stays legible either way.
  const reduceTransparency = useReduceTransparency();
  const pulse = useRef(new Animated.Value(0)).current;
  const menu = useRef(new Animated.Value(0)).current;
  const homeAwayFromTop = useHomeAwayFromTop();
  // A settled Home drawer is the top layer; the pill belongs to the sheet it
  // rode in on and must neither paint over the drawer nor take its taps.
  const drawerOpen = useDockSuppressed();
  // Home, Messages, Pulse and Work centre the labelled pill. Pushed screens
  // (including Compass, My union and Account) keep a compact trailing trigger
  // beside Back. Both PREVIEW and SAMPLE use the same route classification.
  const placement = hatPillPlacementForPath(pathname);
  const compact = placement === 'pinned-trailing';
  const pillOffScreen = scrollsWithHome && homeAwayFromTop;

  useEffect(() => {
    onMenuVisibilityChange?.(open && Boolean(activeHat));
    return () => onMenuVisibilityChange?.(false);
  }, [activeHat, onMenuVisibilityChange, open]);

  useEffect(() => {
    if (!activeHat || reduceMotion) return;
    const pulseAnimation = Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 260, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]);
    pulseAnimation.start();
    return () => { pulseAnimation.stop(); };
  }, [activeHat, pulse, reduceMotion]);

  // An unmounted switcher leaves no running animation behind.
  useEffect(() => () => { menu.stopAnimation(); }, [menu]);

  const openMenu = useCallback(() => {
    void haptics.select();
    setFailure(null);
    // Reset before mounting the list, so no early native layout event can use
    // measurements from the previous role or text size.
    rowLayouts.current.clear();
    listViewport.current = { offset: 0, height: 0, content: 0 };
    placedCurrentRole.current = false;
    setEndPadding(0);
    setHiddenRoles({ above: false, below: false });
    setOpen(true);
    openHatSwitcherMenu(menu, reduceMotion, () =>
      Animated.timing(menu, { toValue: 1, duration: HAT_MENU_OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    );
  }, [menu, reduceMotion]);

  // b06-17: an authorization gate can ask for this menu from anywhere in the
  // app. The count seen at mount is the baseline, so a request left over from a
  // previous screen never opens the menu on arrival.
  const requests = useHatSwitcherRequests();
  const seenRequests = useRef(requests);
  useEffect(() => {
    if (requests === seenRequests.current) return;
    seenRequests.current = requests;
    openMenu();
  }, [openMenu, requests]);

  const closeMenu = useCallback(() => {
    closeHatSwitcherMenu(
      menu,
      reduceMotion,
      () => Animated.timing(menu, { toValue: 0, duration: HAT_MENU_CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      () => setOpen(false),
    );
  }, [menu, reduceMotion]);

  // Leaving the route closes the menu; a dropdown never outlives its anchor.
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    if (open) closeMenu();
  }, [closeMenu, open, pathname]);

  // Not a Modal, so Android's back button no longer dismisses it for free.
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeMenu();
      return true;
    });
    return () => { subscription.remove(); };
  }, [closeMenu, open]);

  // The offline PREVIEW roster is retired (empty); the SAMPLE roster follows
  // the server's persona list, so a live SAMPLE persona always has its roles
  // (UB-UG-NATIVE-DEMO-ENTRY-RESTORED-20261107).
  if (!activeHat || hats.length === 0) return null;
  const current = hats.find((item) => item.key === activeHat) ?? hats[0]!;
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });
  const lift = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, -2] });
  // The pill fades with the Home drawers' reveal: it is Home chrome, so it
  // leaves with the sheet rather than hovering, off-centre, over the drawer.
  const pillDim = Animated.subtract(1, homeDrawerReveal);
  const homeTravel = Animated.multiply(homeScrollOffset, -1);
  // Native scroll events drive both travel and visibility: a busy JS thread
  // must not leave this root sibling painted above the scene's safe viewport.
  const homePillVisibility = homeScrollOffset.interpolate({ inputRange: [0, FLOATING_CONTROL_LIFT], outputRange: [1, 0], extrapolate: 'clamp' });
  const pillOpacity = scrollsWithHome ? Animated.multiply(pillDim, homePillVisibility) : pillDim;
  const menuSlide = menu.interpolate({ inputRange: [0, 1], outputRange: [HAT_MENU_TRAVEL, 0] });
  const chevronTurn = menu.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  // Keep the shared resting position; Home travels and fades over the first
  // control-lift distance rather than moving its content start or viewport.
  const pillTop = floatingControlTop(insets.top, spacing.xs);
  const pillBandHeight = floatingControlHitHeight(insets.top, pillTop);
  const menuTop = hatMenuTop(pillTop, PILL_HEIGHT);
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other';
  const menuMaxHeight = hatMenuMaxHeight(windowHeight, menuTop, hatMenuBottomInset(insets.bottom, platform, nativeTabPath(pathname)), spacing.xl);
  // Visitors meet the same word as the web demo ("Guided demo"); SAMPLE stays
  // the internal name of the build and its sign-in safety marker.
  const modeLabel = mode === 'preview' ? 'PREVIEW' : 'DEMO';
  // Ink sits on the canvas while the pill is transparent, and on the card fill
  // once Reduce Transparency asks for an opaque pill: theme.foreground /
  // theme.cardForeground each pair with their surface at 14.9:1 or better.
  const ink = reduceTransparency ? theme.cardForeground : theme.foreground;

  async function selectHat(key: PreviewHatKey) {
    if (switching) return;
    if (mode === 'preview') {
      switchPreviewHat(key);
      closeMenu();
      return;
    }
    setSwitching(true);
    setFailure(null);
    try {
      await switchSampleHat(key);
      closeMenu();
    } catch {
      setFailure('Could not switch roles. Try again.');
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <View
        pointerEvents={drawerOpen || pillOffScreen ? 'none' : 'box-none'}
        accessibilityElementsHidden={drawerOpen || open}
        importantForAccessibility={drawerOpen || open ? 'no-hide-descendants' : 'auto'}
        style={[styles.anchor, compact ? styles.anchorTrailing : null, { top: pillTop, height: pillBandHeight }]}
      >
        {/* The pill is part of the screen it sits on, not of the menu. */}
        <Animated.View
          accessibilityElementsHidden={scrollsWithHome && homeAwayFromTop}
          importantForAccessibility={scrollsWithHome && homeAwayFromTop ? 'no-hide-descendants' : 'auto'}
          style={{
            opacity: pillOpacity,
            transform: scrollsWithHome
              ? [{ translateY: homeTravel }, { scale }, { translateY: lift }]
              : [{ scale }, { translateY: lift }],
          }}
        >
          <Pressable
            accessible
            accessibilityRole="button"
            accessibilityLabel={mode === 'preview' ? `PREVIEW demo, switch role, ${current.label}` : `Demo, switch role, ${current.label}`}
            accessibilityHint="Opens the demo role menu"
            // Names the signed-in demo persona for automation: the hat comes
            // from the session (sampleHatForSession), never from on-screen text.
            testID={`demo-signed-in-${activeHat}`}
            accessibilityState={{ expanded: open }}
            onAccessibilityTap={openMenu}
            onPress={open ? closeMenu : openMenu}
            style={({ pressed }) => [
              compact ? styles.compactTarget : styles.floatingTarget,
              { opacity: pressed ? 0.82 : 1 },
              pressed && !reduceMotion ? { transform: [{ scale: pressedScale }] } : null,
            ]}
          >
            {/* Frosted capsule: the backing lets the canvas through while the
                ink still reads on it, the ring is the identity, and the sheen
                drifts across keyline and fill together on one slow cycle. Off
                screen, under an open menu, or under Reduce Motion the ring and
                the sheen hold still. */}
            <FrostedCapsule style={[styles.pill, compact ? styles.pillCompact : styles.pillLabelled]}>
              <ShineBorder
                drift
                duration={PILL_SHEEN_CYCLE_MS}
                fillOpacity={PILL_SHEEN_FILL_OPACITY}
                paused={open || drawerOpen || pillOffScreen}
                style={styles.pillRing}
              >
                {/* The ring's colours are decorative and fall below 3:1 on the
                    light themes; this keyline is the boundary that carries the
                    contrast (theme.border is 3.5:1 or better on every theme). */}
                <View pointerEvents="none" style={[styles.keyline, { borderColor: theme.border }]} />
                <View style={[styles.pillInner, compact ? styles.pillInnerCompact : null]}>
                  {/* iOS fits a shrink-to-fit label once; after the system text
                      size changed with the app open it kept the old fit and the
                      label collapsed to a sliver until a restart. The font
                      scale key makes the label draw afresh
                      at each new size. */}
                  {compact ? (
                    <Text key={`demo-mode-${fontScale}`} adjustsFontSizeToFit maxFontSizeMultiplier={1.4} minimumFontScale={0.8} numberOfLines={1} style={[styles.compactMode, { color: ink }]}>{modeLabel} <Ionicons name="chevron-down" size={11} color={ink} /></Text>
                  ) : (
                    <>
                      {/* Android's shrink-to-fit collapses this label to a few
                          pixels in the content-sized row once system text is
                          large (font scale 2.0, Nov 8, 2026), so there the
                          label only stops at its 1.4x cap and ends with an
                          ellipsis if a narrow screen runs out of room. */}
                      <Text
                        key={`demo-label-${fontScale}`}
                        adjustsFontSizeToFit={Platform.OS !== 'android'}
                        maxFontSizeMultiplier={1.4}
                        minimumFontScale={0.7}
                        numberOfLines={1}
                        style={[styles.pillLabel, { color: ink }]}
                      >
                        {mode === 'preview' ? <>PREVIEW · {current.label}</> : <>DEMO · {current.label}</>}
                      </Text>
                      <Animated.View style={{ transform: [{ rotate: chevronTurn }] }}>
                        <Ionicons name="chevron-down" size={12} color={ink} />
                      </Animated.View>
                    </>
                  )}
                </View>
              </ShineBorder>
            </FrostedCapsule>
          </Pressable>
        </Animated.View>
      </View>
      {open ? (
        // The overlay is the modal view: VoiceOver ignores its siblings (the
        // pill and the screen), and the two-finger scrub dismisses it.
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal onAccessibilityEscape={closeMenu}>
          {/* Transparent scrim: a dropdown dismisses on any outside tap and
              never dims the screen it hangs from. Assistive tech closes the
              menu with the Close row below, the escape gesture, or Back. */}
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            style={StyleSheet.absoluteFill}
            onPress={closeMenu}
          />
          <View
            pointerEvents="box-none"
            style={[styles.menuHost, compact ? styles.menuHostTrailing : null, { top: menuTop }]}
          >
            <Animated.View
              style={[
                styles.menu,
                largeMenuText ? styles.menuLargeText : null,
                {
                  maxHeight: menuMaxHeight,
                  backgroundColor: theme.popover,
                  borderColor: theme.border,
                  opacity: menu,
                  transform: [{ translateY: menuSlide }],
                },
              ]}
            >
              {/* While roles are hidden above, a small "More above" on the
                  caption's line and a hairline under it say the list is
                  scrolled; neither changes the caption's height, so the list
                  never moves. */}
              <View style={[styles.captionRow, { borderBottomColor: hiddenRoles.above ? theme.border : 'transparent' }]}>
                <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} style={[styles.menuCaption, { color: theme.mutedForeground }]} accessibilityRole="header">
                  Switch role
                </Text>
                {hiddenRoles.above ? (
                  <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} numberOfLines={1} accessibilityElementsHidden importantForAccessibility="no" style={[styles.foldHintLabel, styles.moreAbove, { color: theme.mutedForeground }]}>More above</Text>
                ) : null}
              </View>
              <View style={styles.listFrame}>
              <ScrollView
                ref={listRef}
                bounces={false}
                style={styles.listScroll}
                contentContainerStyle={{ paddingBottom: endPadding }}
                keyboardShouldPersistTaps="handled"
                scrollEventThrottle={32}
                onLayout={(event) => measureList({ height: event.nativeEvent.layout.height })}
                onContentSizeChange={(_width, height) => measureList({ content: height })}
                onScroll={(event) => measureList({ offset: event.nativeEvent.contentOffset.y })}
              >
                <View accessibilityLabel="Switch role" style={styles.list}>
                  {hats.map((item, index) => {
                    const selected = item.key === activeHat;
                    return (
                      <Pressable
                        key={item.key}
                        onLayout={(event) => {
                          const { y, height } = event.nativeEvent.layout;
                          rowLayouts.current.set(item.key, { y, height });
                          measureList({});
                        }}
                        // iOS exposes radio roles as cells; buttons retain an
                        // actionable native trait alongside the selection.
                        accessible
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: switching }}
                        accessibilityLabel={item.label}
                        accessibilityHint={`Switches the demo to ${item.label}. ${item.description}`}
                        disabled={switching}
                        onPress={() => { void selectHat(item.key); }}
                        style={({ pressed }) => [
                          styles.row,
                          index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border } : null,
                          { backgroundColor: selected ? theme.secondary : pressed ? theme.muted : 'transparent' },
                        ]}
                      >
                        {/* b03a-2: a radiogroup states its selection with a
                            leading ring on every row, filled on exactly one. */}
                        <View style={[styles.radio, { marginTop: radioOffset, borderColor: selected ? theme.primary : theme.mutedForeground }]}>
                          {selected ? <View style={[styles.radioFill, { backgroundColor: theme.primary }]} /> : null}
                        </View>
                        <View style={styles.rowCopy}>
                          <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} style={[styles.rowTitle, { color: theme.foreground }]}>{item.label}</Text>
                          <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} numberOfLines={fontScale > 1 ? undefined : 2} style={[styles.rowBody, { color: theme.mutedForeground }]}>{item.description}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
              {/* Over the list's bottom edge, on the menu's own fill: it hides
                  only the part of a row that is cut off anyway, and leaves no
                  band behind when the list reaches its end. */}
              {hiddenRoles.below ? <FoldHint scale={menuTextScale} color={theme.mutedForeground} background={theme.popover} border={theme.border} /> : null}
              </View>
              {failure ? (
                <View accessibilityLiveRegion="polite">
                  <Body style={[styles.status, { color: theme.destructive }]}>{failure}</Body>
                </View>
              ) : null}
              {switching ? <Body muted style={styles.status}>Switching…</Body> : null}
              {/* The store build's demo: the DEMO pill is its banner on every
                  screen, and Exit demo sits in its menu, returning the app to
                  the Production sign-in. */}
              {storeDemo ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={demoText('Exit demo')}
                  accessibilityHint={demoText('Returns to the Union Ground sign-in.')}
                  accessibilityState={{ disabled: switching || storeDemoExitBusy, busy: storeDemoExitBusy }}
                  disabled={switching || storeDemoExitBusy}
                  onPress={() => {
                    setFailure(null);
                    void exitStoreDemo().catch(() => setFailure(demoText('The demo could not close. Try again.')));
                  }}
                  style={({ pressed }) => [
                    styles.closeRow,
                    { borderTopColor: theme.border, backgroundColor: pressed ? theme.muted : 'transparent' },
                  ]}
                >
                  <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} style={[styles.closeLabel, { color: theme.destructive }]}>{demoText(storeDemoExitBusy ? 'Closing the demo…' : 'Exit demo')}</Text>
                </Pressable>
              ) : null}
              {/* Screen readers and switch users close the menu from inside it:
                  the scrim behind a modal view is out of their reach. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close role menu"
                accessibilityState={{ disabled: switching }}
                disabled={switching}
                onPress={closeMenu}
                style={({ pressed }) => [
                  styles.closeRow,
                  { borderTopColor: theme.border, backgroundColor: pressed ? theme.muted : 'transparent' },
                ]}
              >
                <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} style={[styles.closeLabel, { color: theme.foreground }]}>Close</Text>
              </Pressable>
            </Animated.View>
          </View>
        </View>
      ) : null}
    </>
  );
}

// A quiet line, not a control: it says roles are hidden above or below the
// list's edge and that the list scrolls. VoiceOver reaches every role by
// swiping, so the hint stays out of its way.
// It takes the touches that land on it, so a tap on the hint never selects the
// half-hidden role beneath it.
function FoldHint({ scale, color, background, border }: { scale: number; color: string; background: string; border: string }) {
  return (
    <View onStartShouldSetResponder={() => true} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.foldHint, { backgroundColor: background, borderTopColor: border }]}>
      <Ionicons name="chevron-down" size={Math.round(12 * scale)} color={color} />
      <Text maxFontSizeMultiplier={HAT_MENU_TEXT_CAP} style={[styles.foldHintLabel, { color }]}>Scroll for more roles</Text>
    </View>
  );
}

const HAT_MENU_TEXT_CAP = 2;
const ROW_TITLE_LINE_HEIGHT = 22;
const RADIO_SIZE = 20;

const styles = StyleSheet.create({
  // The anchor is the tap target's band: `top` is the capsule's own top edge
  // and `height` is floatingControlHitHeight (the 48pt touch minimum below the
  // safe-area line plus the lift), so the target never reaches up into the
  // status-bar frame. The Animated.View and the Pressable inherit this height
  // (iOS tree, October 19: Button 36pt tall when the band was 36pt).
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 30,
  },
  // The compact capsule keeps the right gutter of a pushed surface, beside the
  // floating back circle at the left gutter.
  anchorTrailing: {
    alignItems: 'flex-end',
    paddingRight: pinnedHeaderLayout.trailingInset,
  },
  // The pressable fills the band so the whole 48pt-wide column is live down
  // to the band's bottom edge, while the capsule paints only at the top.
  floatingTarget: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  compactTarget: { flex: 1, width: COMPACT_PILL_WIDTH, alignItems: 'center', justifyContent: 'flex-start' },
  pill: { height: PILL_HEIGHT, ...elevation.level2 },
  pillRing: { flex: 1, borderRadius: radii.pill },
  pillLabelled: { minWidth: 140 },
  pillCompact: { width: COMPACT_PILL_WIDTH },

  keyline: {
    position: 'absolute',
    top: 1.5,
    right: 1.5,
    bottom: 1.5,
    left: 1.5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
  },
  pillInner: {
    flex: 1,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  // One line, never the two-line stack the October 9 capture showed.
  pillInnerCompact: { paddingHorizontal: spacing.xs },
  compactMode: { fontSize: 10, lineHeight: 13, ...typeface.controlStrong },
  pillLabel: { flexShrink: 1, fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 0.25 },
  menuHost: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  menuHostTrailing: {
    alignItems: 'flex-end',
    paddingRight: pinnedHeaderLayout.hitInset,
  },
  menu: {
    // Level 3 (brief §A): the dropdown is the one elevated surface the
    // switcher owns; its rows stay flat on the menu canvas.
    width: HAT_MENU_WIDTH,
    maxWidth: '92%',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
    overflow: 'hidden',
    ...elevation.level3,
  },
  menuLargeText: { width: '92%', maxWidth: 520 },
  menuCaption: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    fontSize: 11,
    lineHeight: 15,
    ...typeface.controlStrong,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  listScroll: { flexGrow: 0 },
  list: {},
  row: {
    minHeight: HAT_MENU_ROW_HEIGHT,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  radio: { width: RADIO_SIZE, height: RADIO_SIZE, borderRadius: RADIO_SIZE / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioFill: { width: 10, height: 10, borderRadius: 5 },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, lineHeight: ROW_TITLE_LINE_HEIGHT, ...typeface.controlStrong },
  rowBody: { fontSize: 13, lineHeight: 18, ...typeface.bodyMedium },
  status: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  closeRow: {
    minHeight: minimumTouchTarget,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeLabel: { fontSize: 15, lineHeight: 20, ...typeface.control },
  captionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  moreAbove: { flexShrink: 1, marginLeft: spacing.sm, marginBottom: spacing.xs, fontSize: 11, lineHeight: 15 },
  listFrame: { flexShrink: 1 },
  foldHint: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth },
  foldHintLabel: { fontSize: 12, lineHeight: 16, ...typeface.control },
});
