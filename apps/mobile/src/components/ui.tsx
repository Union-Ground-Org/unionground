import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type PropsWithChildren, type ReactNode, type Ref, type RefObject } from 'react';
import { ActivityIndicator, Animated, Platform, RefreshControl, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Text, TextInput } from './Text';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollViewMarker } from 'react-native-screens/experimental';

import { queueAccessibilityAnnouncement, useAccessibilityAnnouncementQueue } from '../lib/announce';
import { contentStartInset, homeScrollOffset, nativeHeaderContentInset, resetHomeScrollOffset, screenBottomInset, syncHomeAwayFromTop, syncHomeScrollBounds, useHomeScrollToTopRequests } from '../lib/chrome';
import { arrivalLength, columnProgress, growStyle } from '../lib/chartArrival';
import { useReduceMotion } from '../lib/reduceMotion';
import { useChartArrival } from '../lib/useChartArrival';
import { FontScaleRelayout } from './FontScaleRelayout';
import { ScreenKeyboardReveal, useRevealAboveKeyboard } from './ScreenKeyboardReveal';
import { useWordFit } from './useWordFit';
import { usePinnedHeaderChrome, useScreenNameAlreadySpoken } from './PinnedHeader';
import { NumberFlow } from './NumberFlow';
import { PressableScale, usePressSpring } from './PressableScale';
import { HighlightList, HighlightRow } from './RowHighlight';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { keyboardDismissModeFor } from './keyboardDismissGesture';

import { typeface } from '../theme/typeface';
/* Screens omit the top and bottom bands on iPhone and Android.
   The top ramp is gone, and UIKit's bottom scroll-edge effect is
   turned off under the tab bar: content stays sharp to the bottom edge and
   the tab bar sits directly on it. */

const TAB_BAR_EDGE_EFFECTS: ComponentProps<typeof ScrollViewMarker>['scrollEdgeEffects'] = { bottom: 'hidden' };

export function Screen({ children, refreshing, onRefresh, bottomInset, tabRoot = false, bottomClearance = 0, scrollRef, scrollsTopChrome = false, onScrollProgress, onScrollOffset, onContentHeight, nativeHeaderHeight, scrollEnabled = true }: PropsWithChildren<{
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Tab roots pass the page gap retained above the platform tab bar. */
  bottomInset?: number;
  /** A native tab root (Home, Messages, Pulse, Work), never a pushed screen. */
  tabRoot?: boolean;
  /** Keep a form's scroll viewport above overlaid navigation, not just its footer. */
  bottomClearance?: number;
  /**
   * Opt-in handle on the page's own scroll view, for in-page jump targets
   * (b01-22 "In this document"). Screen still owns the surface and both
   * insets; a caller may only scroll it, never restyle it.
   */
  scrollRef?: RefObject<ScrollView | null>;
  /** Home lets all app-owned top chrome travel with its finite feed. */
  scrollsTopChrome?: boolean;
  /**
   * Reading screens (REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001)
   * learn how far down the worker has scrolled, 0..100.
   */
  onScrollProgress?: (percent: number) => void;
  /**
   * A screen that keeps the reader in place while it adds rows above them
   * (earlier history, prependAnchor) learns the scroll position and the
   * content height.
   */
  onScrollOffset?: (y: number) => void;
  onContentHeight?: (height: number) => void;
  /**
   * A route that keeps its native stack header passes the header's measured
   * height (HeaderHeightContext), so the first line clears the native back
   * control that the transparent header draws over the scene.
   */
  nativeHeaderHeight?: number;
  /** A drawing surface (the form signature pad) stops the page scrolling while a finger is down. */
  scrollEnabled?: boolean;
}>) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const pinned = usePinnedHeaderChrome();
  const ownedScrollRef = useRef<ScrollView | null>(null);
  const scrollOffsetRef = useRef(0);
  // The keyboard reveal's retry after Android lays out its keyboard spacer.
  const contentSizeListenerRef = useRef<((contentHeight: number) => void) | null>(null);
  const scrollListenerRef = useRef<((offset: number) => void) | null>(null);
  const scrollOffsetListener = useRef(onScrollOffset);
  scrollOffsetListener.current = onScrollOffset;
  const contentHeightListener = useRef(onContentHeight);
  contentHeightListener.current = onContentHeight;
  const scrollToTopRequests = useHomeScrollToTopRequests();
  const seenScrollToTopRequests = useRef(scrollToTopRequests);
  // One content start line on every surface, whatever chrome floats over it:
  // safe-area top + CONTENT_START_OFFSET. The seven competing formulas this
  // replaced are listed in docs/mobile/top-chrome-progressive-blur-spec-20261010.md
  // section 3. Screen supplies both paddings on every path, so iOS automatic
  // content-inset adjustment is never relied on and can never disagree with the
  // chrome (delta-review finding on a6c0da00d5b).
  const startLine = pinned?.contentInset ?? contentStartInset(insets.top);
  const topPadding = nativeHeaderHeight === undefined ? startLine : nativeHeaderContentInset(startLine, nativeHeaderHeight);
  // Tab roots pass the native-tab inset. Every other surface owes the home indicator
  // its clearance, regardless of which chrome host owns it: the old fallback
  // ran only under a pinned header or preview chrome, and it collapsed onto the
  // page's own padding on a device reporting no bottom inset (pass-4).
  const bottomPadding = bottomInset ?? screenBottomInset(insets.bottom);

  const attachScroll = useCallback((node: ScrollView | null) => {
    ownedScrollRef.current = node;
    if (scrollRef) scrollRef.current = node;
  }, [scrollRef]);

  useEffect(() => {
    if (!scrollsTopChrome) return;
    resetHomeScrollOffset();
    return () => { resetHomeScrollOffset(); };
  }, [scrollsTopChrome]);

  useEffect(() => {
    if (!scrollsTopChrome || scrollToTopRequests === seenScrollToTopRequests.current) return;
    seenScrollToTopRequests.current = scrollToTopRequests;
    ownedScrollRef.current?.scrollTo({ y: 0, animated: !reduceMotion });
  }, [reduceMotion, scrollToTopRequests, scrollsTopChrome]);

  const publishScrollState = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    scrollListenerRef.current?.(event.nativeEvent.contentOffset.y);
    scrollOffsetListener.current?.(event.nativeEvent.contentOffset.y);
    if (scrollsTopChrome) syncHomeAwayFromTop(event.nativeEvent.contentOffset.y);
    if (onScrollProgress) {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const scrollable = contentSize.height - layoutMeasurement.height;
      onScrollProgress(scrollable > 0 ? Math.max(0, Math.min(100, Math.round((Math.max(0, contentOffset.y) / scrollable) * 100))) : 0);
    }
  }, [onScrollProgress, scrollsTopChrome]);

  const handleScroll = useMemo(() => scrollsTopChrome
    ? Animated.event(
        [{ nativeEvent: { contentOffset: { y: homeScrollOffset } } }],
        { useNativeDriver: true, listener: publishScrollState },
      )
    : publishScrollState,
  [publishScrollState, scrollsTopChrome]);

  const scrollSurface = (
    <Animated.ScrollView
        ref={attachScroll}
        scrollEnabled={scrollEnabled}
        style={{ marginBottom: bottomClearance }}
        contentContainerStyle={[styles.screen, { paddingTop: topPadding, paddingBottom: bottomPadding }]}
        automaticallyAdjustContentInsets={false}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode={keyboardDismissModeFor(Platform.OS)}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        onLayout={scrollsTopChrome ? (event) => syncHomeScrollBounds({ viewportHeight: event.nativeEvent.layout.height }) : undefined}
        onContentSizeChange={(_width, height) => {
          if (scrollsTopChrome) syncHomeScrollBounds({ contentHeight: height });
          contentSizeListenerRef.current?.(height);
          contentHeightListener.current?.(height);
        }}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
        refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={theme.primary} colors={[theme.primary]} /> : undefined}
      >
        {refreshing && !onRefresh ? <ActivityIndicator color={theme.primary} accessibilityLabel="Refreshing" /> : null}
        {/* BUG-UG-NATIVE-HOME-ACCESSIBILITY-TEXT-CLIPPED-20261103: a
            text size change while the app is open remounts the page, so no
            text keeps the frame it measured at the old size. */}
        <FontScaleRelayout>
          {/* BUG-UG-NATIVE-QUICK-NOTE-HIDDEN-BY-KEYBOARD-20261103: a
              focused field can ask the page to lift it and its button above
              the keyboard. */}
          <ScreenKeyboardReveal scrollRef={ownedScrollRef} scrollOffsetRef={scrollOffsetRef} contentSizeListenerRef={contentSizeListenerRef} scrollListenerRef={scrollListenerRef} minTop={topPadding} animated={!reduceMotion}>
            {children}
          </ScreenKeyboardReveal>
        </FontScaleRelayout>
    </Animated.ScrollView>
  );

  const scene = (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]} edges={['left', 'right']} testID={tabRoot ? 'native-tab-content' : undefined}>
      {/* NativeTabs cannot infer Home's scroll surface through the over/under
          drawer hierarchy. Register the direct ScrollView explicitly so the
          real iOS 26 tab bar owns its on-scroll minimization. Every tab root
          route (never a pushed screen) turns UIKit's bottom scroll-edge effect
          off, so no frosted band sits above the tab bar (#9607). */}
      {(scrollsTopChrome || tabRoot) && Platform.OS === 'ios' ? (
        <ScrollViewMarker style={styles.safe} scrollEdgeEffects={TAB_BAR_EDGE_EFFECTS}>{scrollSurface}</ScrollViewMarker>
      ) : scrollSurface}
    </SafeAreaView>
  );

  return scene;
}

export function Card({ children, style, hero = false, pressed = false, testID }: PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  hero?: boolean;
  pressed?: boolean;
  /** Test and automation hook only; nothing a person sees or hears changes. */
  testID?: string;
}>) {
  const theme = useTheme();
  // The hero role takes the lifted pass (p1-wave2a P2): same briefed offset and
  // opacity, one blur step, so a surface's single hero finally separates from
  // the contact rows under it. Every other card stays on the contact shadow.
  const resting = hero ? elevation.level1HeroLift : elevation.level1;
  // Pressed state is owned by the caller here, so the card takes the spring
  // rather than the whole PressableScale.
  const press = usePressSpring(pressed, resting);
  return (
    <Animated.View
      testID={testID}
      style={[
        styles.card,
        resting,
        { backgroundColor: theme.card, borderColor: theme.border },
        press,
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

export function Heading({ children, level = 1, fitWords = false, testID }: PropsWithChildren<{
  level?: 1 | 2 | 3;
  /** Grow with the text size only while the longest word fits its line . */
  fitWords?: boolean;
  /** Test and automation hook only; nothing a person sees or hears changes. */
  testID?: string;
}>) {
  const theme = useTheme();
  const fit = useWordFit(fitWords, children, styles[`heading${level}`], 'heading');
  // A pushed screen's title row paints and announces its name beside the back
  // control (UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115). A
  // heading with those same words is not drawn again, so the title shows once
  // and the rotor lists one heading for it.
  const echo = useScreenNameAlreadySpoken(children);
  if (echo.duplicate) return null;
  return (
    <Text
      testID={testID}
      accessibilityRole="header"
      // Level 1 is the page-title scale, and the owner's October 10 decision
      // caps a page title at two lines; the 33pt serif used to wrap to three
      // at 320pt.
      numberOfLines={level === 1 ? 2 : undefined}
      onLayout={fit.onLayout}
      allowFontScaling={fit.allowFontScaling}
      style={[styles[`heading${level}`], { color: theme.foreground }, fit.style]}
    >
      {children}
    </Text>
  );
}

// A stat's number, rolling its digits (NumberFlow, owner request 2026-09-13).
// It deliberately carries no header role: a bare count is a value, and a
// heading outline made of numbers is noise in VoiceOver's rotor.
export function StatValue({ value, level = 3 }: { value: string; level?: 2 | 3 }) {
  const theme = useTheme();
  return <NumberFlow value={value} style={[styles[`heading${level}`], { color: theme.foreground }]} />;
}

export function Body({ children, muted = false, style, accessibilityRole, accessible, accessibilityElementsHidden, importantForAccessibility, numberOfLines, adjustsFontSizeToFit, maxFontSizeMultiplier, fitWords = false, testID }: PropsWithChildren<{
  testID?: string;
  muted?: boolean;
  style?: ComponentProps<typeof Text>['style'];
  accessibilityRole?: ComponentProps<typeof Text>['accessibilityRole'];
  // So a caller can spread `useScreenNameAlreadySpoken(...).hiddenProps` onto a
  // line that repeats the words the pinned bar is already announcing.
  accessible?: ComponentProps<typeof Text>['accessible'];
  accessibilityElementsHidden?: ComponentProps<typeof Text>['accessibilityElementsHidden'];
  importantForAccessibility?: ComponentProps<typeof Text>['importantForAccessibility'];
  // So a line whose words arrive late can hold one line box at every text size.
  numberOfLines?: ComponentProps<typeof Text>['numberOfLines'];
  adjustsFontSizeToFit?: ComponentProps<typeof Text>['adjustsFontSizeToFit'];
  /** So a screen that caps its controls' text size can cap its reading text with them. */
  maxFontSizeMultiplier?: ComponentProps<typeof Text>['maxFontSizeMultiplier'];
  /** Grow with the text size only while the longest word fits its line . */
  fitWords?: boolean;
}>) {
  const theme = useTheme();
  const fit = useWordFit(fitWords, children, styles.body);
  return (
    <Text
      onLayout={fit.onLayout}
      allowFontScaling={fit.allowFontScaling}
      accessibilityRole={accessibilityRole}
      accessible={accessible}
      accessibilityElementsHidden={accessibilityElementsHidden}
      importantForAccessibility={importantForAccessibility}
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit={adjustsFontSizeToFit}
      testID={testID}
      // Set only when given: the vote card measures its text with no cap
      // property at all (WhatMattersVoteCardFit).
      {...(maxFontSizeMultiplier === undefined ? {} : { maxFontSizeMultiplier })}
      style={[styles.body, { color: muted ? theme.mutedForeground : theme.foreground }, style, fit.style]}
    >
      {children}
    </Text>
  );
}

export function Button({ label, accessibilityLabel, onPress, variant = 'primary', disabled = false, disabledReason, busy = false, icon, selected, focusRef, testID, maxFontSizeMultiplier, fitWords = false }: {
  label: string;
  testID?: string;
  /** Caps the label's growth with the system text size, as a form that caps its other controls does. */
  maxFontSizeMultiplier?: number;
  /** Grow with the text size only while the longest word fits its line. */
  fitWords?: boolean;
  /** Adds target context for screen readers while keeping the visible label. */
  accessibilityLabel?: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'compass' | 'danger';
  disabled?: boolean;
  /**
   * Why a disabled button is unavailable: a greyed-out button that
   * cannot say why reads as a broken screen. With a reason, a disabled button
   * that is not busy stays reachable and pressable: screen readers speak it as
   * dimmed with the reason as its hint, and a press refuses the action, shows
   * the reason under the button and announces it. Presses in quick succession
   * share one announcement of the current reason (the queue keeps the newest).
   */
  disabledReason?: string;
  /**
   * Loading feedback lives in the owning control (brief §G; triage P1-5): the
   * spinner takes the icon slot, the label stays put so the button neither
   * resizes nor loses its name, and the press is refused while it spins.
   */
  busy?: boolean;
  icon?: ReactNode;
  /**
   * Set only for an option inside a single-choice group (a radiogroup
   * container): the button is then a radio and VoiceOver speaks the active one
   * as selected instead of relying on its fill colour.
   */
  selected?: boolean;
  /** The button's host view, so a screen can return accessibility focus to it. */
  focusRef?: Ref<View>;
}) {
  const theme = useTheme();
  const fit = useWordFit(fitWords, label, styles.buttonText);
  const [wrapped, setWrapped] = useState(false);
  const inert = disabled || busy;
  const reason = disabled && !busy ? disabledReason ?? '' : '';
  const announce = useAccessibilityAnnouncementQueue(useId());
  const [explained, setExplained] = useState(false);
  // A button that becomes available forgets the press, so a later block waits
  // for its own press before it shows a reason again.
  if (explained && !reason) setExplained(false);
  // IA-wave-A review (shared MAJOR): the secondary fill measures 1.08:1
  // against the porcelain canvas, so a link button, a legal button, or a gate's
  // Switch-hat action had no visible edge at all — the label floated on the
  // page and the control's frame had to be guessed. Repaired exactly as the
  // w2b-9 confirmation field was: the shared level-1 hairline
  // (StyleSheet.hairlineWidth + theme.border, audited at 3:1 against the
  // canvas), fill unchanged and no promotion to primary. It rides the variant,
  // not the disabled state, so a disabled secondary keeps its edge too.
  const outlined = variant === 'secondary';
  const colors = variant === 'secondary'
    ? { background: theme.secondary, foreground: theme.secondaryForeground }
    : variant === 'compass'
      ? { background: theme.compass, foreground: theme.compassForeground }
      : variant === 'danger'
        ? { background: theme.destructive, foreground: theme.destructiveForeground }
        : { background: theme.primary, foreground: theme.primaryForeground };
  const control = (
    <PressableScale
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={accessibilityLabel ?? label}
      {...(reason ? { accessibilityHint: reason } : {})}
      accessibilityState={selected === undefined ? { disabled: inert, busy } : { disabled: inert, busy, selected }}
      // React Native's Pressable lets any explicit `disabled` replace
      // accessibilityState.disabled, so a button with a reason passes none:
      // it stays announced as dimmed while a press still reaches the
      // explanation (Pressability refuses only `disabled === true`).
      {...(reason ? {} : { disabled: inert })}
      onPress={reason ? () => { setExplained(true); announce(reason); } : onPress}
      ref={focusRef}
      testID={testID}
      // Pressed = compress, with the shadow softening on the way down; the
      // spring and the Reduce Motion path both live in PressableScale.
      resting={inert ? elevation.level0 : elevation.level1}
      pressedOpacity={0.82}
      style={[
        styles.button,
        fitWords && wrapped ? styles.wrappedButton : null,
        inert ? elevation.level0 : elevation.level1,
        // Disabled swaps to muted tokens at full opacity so the label stays
        // readable (subtree opacity drops every variant below 4.5:1). A busy
        // button keeps its own fill: it is still the live control.
        { backgroundColor: disabled ? theme.muted : colors.background },
        outlined ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border } : null,
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color={disabled ? theme.mutedForeground : colors.foreground} accessibilityElementsHidden />
        : icon}
      <Text {...(maxFontSizeMultiplier === undefined ? {} : { maxFontSizeMultiplier })} style={[styles.buttonText, { color: disabled ? theme.mutedForeground : colors.foreground }, fit.style]}
        onLayout={fit.onLayout} allowFontScaling={fit.allowFontScaling}
        onTextLayout={fitWords ? (event) => setWrapped(event.nativeEvent.lines.length > 1) : undefined}>{label}</Text>
    </PressableScale>
  );
  return explained && reason ? <>{control}<Body style={{ color: theme.destructive }}>{reason}</Body></> : control;
}

export { OptionPicker } from './optionPicker';

export function PreviewBanner() {
  const theme = useTheme();
  return (
    <View accessibilityRole="summary" style={[styles.banner, { backgroundColor: theme.accent }]}>
      <Text style={[styles.bannerTitle, { color: theme.accentForeground }]}>Unlocked demo account</Text>
      <Text style={[styles.bannerBody, { color: theme.accentForeground }]}>Fictional Harborview Care United workspace. Switch roles to tour every desk. Nothing here is a live worker record.</Text>
    </View>
  );
}

export function Notice({ children, fitWords = false }: { children: string; fitWords?: boolean }) {
  const theme = useTheme();
  const announcementOwner = useId();
  const announcementAttempt = useRef(0);
  useEffect(() => {
    if (Platform.OS === 'ios') {
      return queueAccessibilityAnnouncement(
        children,
        `${announcementOwner}:${++announcementAttempt.current}`,
      );
    }
    return undefined;
  }, [announcementOwner, children]);
  return (
    <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: theme.card, borderColor: theme.destructive }]}>
      <Ionicons name="alert-circle" size={18} color={theme.destructive} accessibilityElementsHidden />
      <Body style={styles.noticeBody} fitWords={fitWords}>{children}</Body>
    </View>
  );
}

export function StateMessage({ title, body, action, compact = false, fitWords = false }: {
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
  fitWords?: boolean;
}) {
  const theme = useTheme();
  const announcementOwner = useId();
  const announcementAttempt = useRef(0);
  const announcement = `${title}. ${body}`;
  useEffect(() => {
    if (Platform.OS === 'ios') {
      return queueAccessibilityAnnouncement(
        announcement,
        `${announcementOwner}:${++announcementAttempt.current}`,
      );
    }
    return undefined;
  }, [announcement, announcementOwner]);
  return (
    <View
      style={compact
        ? [styles.stateCompact, elevation.level1, { backgroundColor: theme.card, borderColor: theme.border }]
        : styles.state}
      accessibilityLiveRegion="polite"
    >
      <Heading level={2} fitWords={fitWords}>{title}</Heading>
      <Body muted fitWords={fitWords}>{body}</Body>
      {action}
    </View>
  );
}

export function Avatar({ initials, size = 44, square = false }: { initials: string; size?: number; square?: boolean }) {
  const theme = useTheme();
  // Slack-style rounded squares for conversation surfaces; circles elsewhere.
  return (
    <View
      accessible
      accessibilityLabel={initials}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: square ? Math.round(size * 0.27) : size / 2, backgroundColor: theme.primary },
      ]}
    >
      <Text style={[styles.avatarText, { color: theme.primaryForeground, fontSize: size < 40 ? 13 : 16 }]}>{initials}</Text>
    </View>
  );
}

// The status pill moved to its own module when it grew the state ramp and the
// leading dot (brief §C). It is re-exported here so every existing call site
// keeps importing it from the shared ui module.
export { StatusPill } from './StatusPill';

export function SparkBars({ values, color, height = 64, track, arrivalKey }: { values: number[]; color: string; height?: number; track?: string; arrivalKey?: string }) {
  const theme = useTheme();
  // Arrives once, the first time it is seen ( lib/chartArrival.ts).
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ columns: values.length }));
  const max = Math.max(1, ...values);
  return (
    <View ref={ref} style={[styles.spark, { height }]} accessibilityElementsHidden>
      {values.map((value, index) => (
        <View
          key={index}
          style={[
            styles.sparkBar,
            {
              height: Math.max(6, (height * value) / max),
              backgroundColor: index === values.length - 1 ? color : (track ?? theme.secondary),
            },
            growStyle(columnProgress(elapsed, index, values.length), 'y'),
          ]}
        />
      ))}
    </View>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  // BUG-UG-NATIVE-MESSAGES-SEARCH-HIDDEN-BY-KEYBOARD-ANDROID-20261103:
  // a focused search lifts its whole row above the keyboard; Messages' field
  // sat behind Gboard with nothing scrolling it into view. Outside a Screen
  // the reveal does nothing.
  const keyboardReveal = useRevealAboveKeyboard();
  const rowRef = useRef<View>(null);
  return (
    <View ref={rowRef} style={[styles.search, { backgroundColor: theme.secondary, borderColor: theme.border }]}>
      <Ionicons name="search" size={18} color={theme.mutedForeground} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        onFocus={() => keyboardReveal.reveal(rowRef.current)}
        onBlur={() => keyboardReveal.release(rowRef.current)}
        keyboardAppearance={theme.appearance}
        placeholder={placeholder}
        placeholderTextColor={theme.quietForeground}
        value={value}
        onChangeText={onChangeText}
        style={[styles.searchInput, { color: theme.foreground }]}
      />
    </View>
  );
}

// The shared inset list. Its rows carry the gliding highlight (RowHighlight,
// owner request 2026-09-13) so every Group list tracks the finger the same way
// rather than each screen growing its own press fill.
export function Group({ children }: PropsWithChildren) {
  const theme = useTheme();
  return <HighlightList style={[styles.group, { backgroundColor: theme.card, borderColor: theme.border }]}>{children}</HighlightList>;
}

// `highlight={false}` for a row a touch cannot act on: the bar promises a
// tappable row, so a read-only row stays out of it.
export function GroupRow({ children, last = false, highlight = true }: PropsWithChildren<{ last?: boolean; highlight?: boolean }>) {
  const theme = useTheme();
  const rowStyle = [styles.groupRow, last ? null : { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth }];
  if (!highlight) return <View style={rowStyle}>{children}</View>;
  return <HighlightRow style={rowStyle}>{children}</HighlightRow>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  screen: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  card: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.lg, gap: spacing.sm },
  // One title scale (owner decision, October 10, 2026): 22/28, two lines at
  // most. The 33/38 Georgia serif left page titles; Home's greeting keeps it in
  // app/(tabs)/home.tsx `styles.greeting`.
  // Every heading is Archivo 800 and running text Public Sans (theme rule 8,
  // UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115); the
  // family and weight come from the typography tokens, never a screen.
  heading1: { ...typeface.heading, fontSize: 22, lineHeight: 28, letterSpacing: -0.25 },
  heading2: { ...typeface.heading, fontSize: 22, lineHeight: 28, letterSpacing: -0.25 },
  heading3: { ...typeface.heading, fontSize: 17, lineHeight: 23 },
  body: { ...typeface.body, fontSize: 16, lineHeight: 23 },
  button: { minHeight: minimumTouchTarget, borderRadius: radii.pill, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  // A control's label: Public Sans 600, the theme's control weight.
  // A pill clips the corners of a large, multiline label.
  wrappedButton: { borderRadius: radii.lg },
  buttonText: { ...typeface.control, fontSize: 16, lineHeight: 20 },
  banner: { borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.md },
  noticeBody: { flex: 1 },
  bannerTitle: { fontSize: 15, lineHeight: 20, ...typeface.heading },
  bannerBody: { fontSize: 14, lineHeight: 20, ...typeface.bodyMedium },
  state: { flex: 1, minHeight: 320, justifyContent: 'center', alignItems: 'center', padding: spacing.xl, gap: spacing.md },
  stateCompact: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.lg, gap: spacing.sm },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...typeface.controlStrong },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 64 },
  sparkBar: { flex: 1, borderRadius: 6 },
  search: {
    minHeight: minimumTouchTarget,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchInput: { flex: 1, minHeight: minimumTouchTarget, fontSize: 16, paddingVertical: spacing.sm },
  group: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  groupRow: { minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, justifyContent: 'center' },
});

export const uiStyles = styles;
