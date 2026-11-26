import { useNativeUi } from "../lib/useNativeUi";
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren, type ReactNode } from 'react';
import { Animated, BackHandler, Easing, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type TextProps } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { contentStartInset, homeScrollOffset, readHomeScrollPosition, nativeTabContentInset, setDockSuppressed, syncHomeDrawerReveal, useDockSuppressed, useHomeAwayFromTop, useHomeHandleRowTop } from '../lib/chrome';
import { androidMinimizedHomeReserve, HOME_HANDLE_FADE, homeHandleClipInset, homeHandleDrawn, homeHandleReach, homeHandleWholeFromOffset } from '../lib/chromeGeometry';
import { drawerFrame, interactiveDrawer, type OpenDrawer } from '../lib/drawerEdgeGeometry';
import { fontScaleLayoutKey } from '../lib/fontScaleRelayout';
import { featureGroupsForHat, featureGroupsForRoles, staffDeskHomeRole, withMyCampaignGroup, withoutDuesGroups, workItemsForHat, workItemsForRoles } from '../lib/hatFunctions';
import { canOpenFeature } from '../lib/featureCatalog';
import { useStaffDeskNumbers } from '../features/home/useStaffDeskNumbers';
import { GuidedListToggle } from '../features/onboardingGuide/OnboardingGuideCard';
import { useOnboardingGuide } from '../features/onboardingGuide/useOnboardingGuide';
import { guidedDestinationGroups, hiddenDestinationCount } from '../lib/onboardingGuide';
import { quickActionsScope } from '../lib/quickActions';
import { useReduceMotion } from '../lib/reduceMotion';
import { haptics } from '../services/haptics';
import { useChannelStore } from '../data/useChannels';
import { useApp } from '../state/AppProvider';
import { elevation, revealedShadow } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { FontScaleRelayout } from './FontScaleRelayout';
import { FunctionDeck } from './FunctionDeck';
import { Body, Button, Heading } from './ui';
import { WorkWidgets } from './WorkWidgets';

import { typeface } from '../theme/typeface';
const DRAWER_WIDTH_RATIO = 0.76;
// BUG-UG-NATIVE-HOME-DRAWER-FRAME-SEAMS-20261102 (owner ruling,
// November 3): the moving Home sheet is a rounded panel with a shadow, not a
// flat edge with a hairline. It is a level-3 surface, so it takes that rung of
// the radius ladder and the level-3 shadow (src/theme/elevation.ts).
const HOME_CARD_RADIUS = radii.sheetRadius;
const PEEK_THRESHOLD = 8;
const DIRECTION_LOCK = 10;
// While a drawer is revealed the moving Home sheet wears a light veil of its
// own canvas: the peek stays the close target and keeps its full size, but its
// half-clipped header, badges, and rows stop competing with the open drawer.
const HOME_VEIL_OPACITY = 0.55;
// Dynamic Type on the handle labels follows the floating hat pill: scale to
// 1.4x, then truncate with an ellipsis.
// BUG-UG-NATIVE-HOME-HANDLE-PILL-LABELS-MISSING-LARGEST-LIGHT-20261103:
// iOS's fit-to-width pass (adjustsFontSizeToFit) left both labels blank at
// the largest size, so a label that does not fit is now cut with an ellipsis,
// never shrunk.
const handleLabelText: Pick<TextProps, 'ellipsizeMode' | 'maxFontSizeMultiplier' | 'numberOfLines'> = { ellipsizeMode: 'tail', maxFontSizeMultiplier: 1.4, numberOfLines: 1 };
const MemoFunctionDeck = memo(FunctionDeck);
const MemoWorkWidgets = memo(WorkWidgets);

export function HomeCarousel({ children }: PropsWithChildren) {
  const { t, language } = useNativeUi();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  // `snapTo` is reached from the pan responder, and that responder is memoised
  // on the geometry alone — so a `snapTo` that read `reduceMotion` from the
  // closure would answer with whatever the setting was on the first render and
  // keep animating after a worker turned Reduce Motion on mid-session. The ref
  // is the live value at gesture time; the state above still drives renders.
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const { width, height, fontScale } = useWindowDimensions();
  // The handles sit outside Screen's FontScaleRelayout, so their labels take
  // the same key and are measured again at a text-size change, never drawn
  // inside a frame measured at the old size (#6928).
  const handleLabelKey = fontScaleLayoutKey(fontScale);
  const {
    dashboard,
    error,
    refreshing,
    refresh,
    authorizedRoles,
    chapterRoles,
    organizationRoles,
    mode,
    previewDesk,
    previewHat,
    previewWidgetLayout,
    setPreviewWidgetLayout,
    duesContext,
    sessionRestricted,
    chosenStaffRole,
  } = useApp();
  // Match Home's role and feature boundary before reusing its desk reader.
  const staffRole = staffDeskHomeRole({ mode, sessionRestricted, chosenStaffRole, authorizedRoles });
  const deskRole = staffRole && canOpenFeature(mode, staffRole, null, chapterRoles, organizationRoles) ? staffRole : null;
  const deskNumbers = useStaffDeskNumbers(deskRole);
  const channelStore = useChannelStore();
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);
  const inboxChannels = channelStore.channels().filter((channel) => (
    mode !== 'preview' || previewHat !== 'member' || !channel.locked
  ));
  const drawerWidth = width * DRAWER_WIDTH_RATIO;
  const homePeekWidth = width - drawerWidth;
  // The two labelled handles share one row budget: each may take at most half
  // of the row inside the feed's inset, less one gap, so at an accessibility
  // text size the Work pill cannot grow over the All features pill (Codex P2
  // on PR #4750). A label that still does not fit shrinks, then truncates;
  // its full name stays in the accessibility label.
  const handleBudget = Math.floor((width - spacing.lg * 2 - spacing.sm) / 2);
  // The one content start line, the same on the drawers as on every other
  // surface (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010).
  // No drawer draws a band at its top: scrolled rows pass behind the clock
  // (owner ruling, Nov 22-23, 2026; #9607).
  const topPad = contentStartInset(insets.top);
  // Home publishes the bottom of its stat band; the two open handles sit on
  // their own row below it rather than over its rounded corners (item 5).
  const handleRowTop = useHomeHandleRowTop();
  // PREVIEW Home reserves the row under its stat band and live Home under its
  // member summary (HomeHandleRow). A Home still loading, or the welcome-back
  // view, publishes nothing, so a zero row keeps the handles vertically
  // centred as before instead of parking both under the status bar.
  // The measured row lives in the feed, so it rides the feed's scroll the way
  // the PREVIEW hat pill does (gate round 2 on PR #4266). The handles stay in
  // the accessibility tree throughout: Home's 1pt away-from-top flag would hide
  // them while their row is still on screen (gate round 3).
  const handleTravel = useMemo(() => Animated.multiply(homeScrollOffset, -1), []);
  // BUG-UG-NATIVE-ANDROID-MINIMIZED-NAV-DEAD-BAND-OVER-HOME-HANDLES-20261109:
  // hiding the Android tab host does not take its hit target with it. Shorten
  // Home by the band that host can still cover. The handles stay on their
  // reserved row and Home clips them to its box, so a row below the box draws
  // nothing into that band and is never pinned over the desk card or desk
  // summary (BUG-UG-NATIVE-ANDROID-PINNED-HOME-HANDLES-COVER-DESK-CARDS-20261109).
  // The away-from-top flag must not remove the handles from the tree.
  const homeAwayFromTop = useHomeAwayFromTop();
  const dockSuppressed = useDockSuppressed();
  const handleClipInset = homeHandleClipInset(insets.bottom, Platform.OS, dockSuppressed);
  const minimizedReserve = Platform.OS === 'android' && homeAwayFromTop && !dockSuppressed
    ? androidMinimizedHomeReserve(insets.bottom, spacing.xl, minimumTouchTarget)
    : 0;
  // UX-UG-NATIVE-HOME-BOTTOM-BAND-CUT-PILLS-AND-TOP-EDGE-20261122:
  // the clip above the tab band cut the pills in half while their row crossed
  // it. A handle is now drawn only while it is whole inside the clip, and a
  // hidden one takes no tap.
  // The clip and the pills are mounted again only when the window or the text
  // size changes (#9630 final, r3s1): a new mount reports every size, so a
  // pill whose frame did not move is still measured. Each mount has its own
  // number, and a report from an older mount is dropped (#9630 split, Sol
  // answer 4). A drawer only moves the clip's bottom edge: the clip reports
  // its new size itself, the pills keep theirs, and the trigger stays the
  // same native view, focus included (Sol answer 5).
  const handleMountKey = `${width}x${height}@${fontScale}`;
  const handleMount = useRef({ key: handleMountKey, id: 0 });
  if (handleMount.current.key !== handleMountKey) handleMount.current = { key: handleMountKey, id: handleMount.current.id + 1 };
  const handleMountId = handleMount.current.id;
  // The clip runs from Home's top to its inset, so the height it reported
  // plus the inset it reported at is Home's own height. A drawer that changes
  // the inset gives the clip's new height at once, never a stale one
  // (#9630 final, r4g1), and the clip's next report confirms it.
  const [clipMeasure, setClipMeasure] = useState({ mount: -1, height: 0, inset: 0 });
  const handleClipHeight = clipMeasure.mount === handleMountId && clipMeasure.height > 0 ? clipMeasure.height + clipMeasure.inset - handleClipInset : 0;
  // Each pill's current height (#9630 round 1, r2g1): a pill that gets
  // shorter, after a text size change, is whole again as soon as it fits.
  const [pillMeasure, setPillMeasure] = useState({ mount: -1, features: 0, work: 0 });
  const pillHeights = pillMeasure.mount === handleMountId ? pillMeasure : { features: 0, work: 0 };
  // Each pill has its own threshold, so a short pill is not held hidden by a
  // taller one. A measured row waits for the clip and
  // that pill before the pill is drawn, so it is never shown cut on its first
  // layout. A pill whole at rest has no threshold and is drawn as on Main.
  const pillWholeFrom = (pillHeight: number) => handleRowTop > 0 && (handleClipHeight <= 0 || pillHeight <= 0)
    ? Number.POSITIVE_INFINITY
    : homeHandleWholeFromOffset(handleRowTop, homeHandleReach(minimumTouchTarget, pillHeight), handleClipHeight);
  const featuresWholeFrom = pillWholeFrom(pillHeights.features);
  const workWholeFrom = pillWholeFrom(pillHeights.work);
  // The scroll listener reads the latest values through refs and re-renders
  // only when a pill changes between drawn and hidden, never per frame.
  const handleOffset = useRef(readHomeScrollPosition());
  const handleWholeFromRef = useRef({ features: featuresWholeFrom, work: workWholeFrom });
  handleWholeFromRef.current = { features: featuresWholeFrom, work: workWholeFrom };
  // A pill acts and is announced only once its fade has ended and it is
  // fully drawn.
  const drawnNow = (offset: number) => ({
    features: homeHandleDrawn(offset, handleWholeFromRef.current.features),
    work: homeHandleDrawn(offset, handleWholeFromRef.current.work),
  });
  const handlesDrawn = drawnNow(handleOffset.current);
  const handlesDrawnRef = useRef(handlesDrawn);
  handlesDrawnRef.current = handlesDrawn;
  const [, redrawHandles] = useState(0);
  useEffect(() => {
    const follow = (offset: number) => {
      handleOffset.current = offset;
      const next = drawnNow(offset);
      if (next.features !== handlesDrawnRef.current.features || next.work !== handlesDrawnRef.current.work) redrawHandles((count) => count + 1);
    };
    const listener = homeScrollOffset.addListener(({ value }) => follow(value));
    // A scroll between the first read and this listener is not missed
    // (#9630 split, Sol answer 6).
    follow(readHomeScrollPosition());
    return () => homeScrollOffset.removeListener(listener);
  }, []); // follow and drawnNow read only refs.
  // The fade starts where the pill is already whole (#9630 round 1, r2s1),
  // so no partly drawn frame can show a cut sliver, and ends where it acts.
  const pillOpacity = (wholeFrom: number | null) => wholeFrom === null
    ? 1
    : wholeFrom === Number.POSITIVE_INFINITY
      ? 0
      : homeScrollOffset.interpolate({ inputRange: [wholeFrom, wholeFrom + HOME_HANDLE_FADE], outputRange: [0, 1], extrapolate: 'clamp' });
  const featuresOpacity = useMemo(() => pillOpacity(featuresWholeFrom), [featuresWholeFrom]);
  const workOpacity = useMemo(() => pillOpacity(workWholeFrom), [workWholeFrom]);
  const measurePill = useCallback((pill: 'features' | 'work', height: number) => {
    if (handleMount.current.id !== handleMountId) return;
    setPillMeasure((current) => {
      const base = current.mount === handleMountId ? current : { mount: handleMountId, features: 0, work: 0 };
      return base === current && current[pill] === height ? current : { ...base, [pill]: height };
    });
  }, [handleMountId]);
  const measureClip = useCallback((height: number) => {
    if (handleMount.current.id !== handleMountId) return;
    setClipMeasure((current) => current.mount === handleMountId && current.height === height && current.inset === handleClipInset ? current : { mount: handleMountId, height, inset: handleClipInset });
  }, [handleMountId, handleClipInset]);
  const handleRowMeasured = handleRowTop > 0;
  const handleRow = (handleOpacity: Animated.AnimatedInterpolation<number> | number) => handleRowMeasured
    ? { top: handleRowTop, opacity: handleOpacity, transform: [{ translateY: handleTravel }] }
    : styles.drawerOpenHandleCentred;
  // A hidden handle is also hidden from VoiceOver and TalkBack, and its press
  // does nothing (#9630 final, r3g2). The drawers stay reachable through the
  // "Home navigation" actions while it is hidden.
  const handleState = (drawn: boolean): { pointerEvents: 'box-none' | 'none'; accessibilityElementsHidden?: boolean; importantForAccessibility?: 'no-hide-descendants' } => drawn
    ? { pointerEvents: 'box-none' }
    : { pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };
  const bottomPad = nativeTabContentInset() + insets.bottom;
  const runsDues = duesContext?.runsDues ?? null;
  const allGroups = useMemo(() => withMyCampaignGroup(withoutDuesGroups(mode === 'preview' ? featureGroupsForHat(previewHat) : featureGroupsForRoles(chapterRoles, organizationRoles), runsDues)), [mode, previewHat, chapterRoles, organizationRoles, runsDues]);
  // REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: while a live
  // worker onboards, All tools holds only the core destinations; the
  // footer control below the groups is the visible way to everything.
  const onboarding = useOnboardingGuide();
  const guide = onboarding.guide;
  const guideShowAll = onboarding.showAll;
  const setGuideShowAll = onboarding.setShowAll;
  const groups = useMemo(() => guidedDestinationGroups(allGroups, guide, guideShowAll), [allGroups, guide, guideShowAll]);
  const guideFooter = guide.progressiveDisclosureActive ? (
    <GuidedListToggle
      guide={guide}
      showAll={guideShowAll}
      hiddenCount={hiddenDestinationCount(allGroups.flatMap((group) => group.items), guide)}
      onToggle={setGuideShowAll}
    />
  ) : null;
  const workItems = useMemo(() => mode === 'preview' ? workItemsForHat(previewHat) : workItemsForRoles(chapterRoles, organizationRoles), [mode, previewHat, chapterRoles, organizationRoles]);
  const widgetLayout = useMemo(() => previewHat ? previewWidgetLayout(previewHat) : null, [previewHat, previewWidgetLayout]);
  const changeWidgetLayout = useCallback((next: Parameters<typeof setPreviewWidgetLayout>[1]) => {
    if (previewHat) setPreviewWidgetLayout(previewHat, next);
  }, [previewHat, setPreviewWidgetLayout]);
  const translateX = useRef(new Animated.Value(0)).current;
  const translateValue = useRef(0);
  const gestureStart = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const [renderOffset, setRenderOffset] = useState(0);
  const [isMoving, setIsMoving] = useState(false);
  const [settledDrawer, setSettledDrawer] = useState<OpenDrawer>(null);
  const frame = drawerFrame(renderOffset, drawerWidth, HOME_CARD_RADIUS);
  const visibleDrawer = frame.side;
  const activeDrawer = interactiveDrawer(visibleDrawer, settledDrawer, isMoving);

  useLayoutEffect(() => {
    syncHomeDrawerReveal(frame.reveal);
    setDockSuppressed(visibleDrawer != null || isMoving);
  }, [frame.reveal, visibleDrawer, isMoving]);

  useEffect(() => {
    const listener = translateX.addListener(({ value }) => {
      translateValue.current = value;
      // No Animated view consumes translateX directly. Translation, underlay,
      // opacity, clip and SVG all paint this same immutable render sample.
      setRenderOffset(value);
    });
    return () => translateX.removeListener(listener);
  }, [drawerWidth, translateX]);

  const markSettled = useCallback((next: OpenDrawer) => {
    setSettledDrawer(next);
    setIsMoving(false);
    // The drawer is the top layer once settled, so the dock stands down.
    setDockSuppressed(next != null);
  }, []);

  useEffect(() => () => { setDockSuppressed(false); syncHomeDrawerReveal(0); }, []);

  useFocusEffect(useCallback(() => () => {
    // Drawer destinations may push a sibling tab directly. Reset the retained
    // Home scene as it loses focus so the destination receives native tabs and
    // returning to Home never reveals a stale underlay.
    animation.current?.stop();
    translateX.setValue(0);
    translateValue.current = 0;
    setRenderOffset(0);
    setIsMoving(false);
    setSettledDrawer(null);
    setDockSuppressed(false);
    syncHomeDrawerReveal(0);
  }, [translateX]));

  const snapTo = useCallback((target: number) => {
    const destination = Math.max(-drawerWidth, Math.min(drawerWidth, target));
    animation.current?.stop();
    setIsMoving(true);
    // Reduce Motion is the same instant swap every other motion primitive in
    // the app takes: the layer still changes, it simply does not travel.
    if (reduceMotionRef.current) {
      translateX.setValue(destination);
      markSettled(destination > PEEK_THRESHOLD ? 'features' : destination < -PEEK_THRESHOLD ? 'work' : null);
      return;
    }
    animation.current = Animated.timing(translateX, {
      toValue: destination,
      duration: 360,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
      // This value supplies a clock to one React render path, including SVG.
      useNativeDriver: false,
    });
    animation.current.start(({ finished }) => {
      if (!finished) return;
      markSettled(destination > PEEK_THRESHOLD ? 'features' : destination < -PEEK_THRESHOLD ? 'work' : null);
    });
  }, [drawerWidth, translateX, markSettled]);

  const returnHome = useCallback(() => {
    snapTo(0);
    void haptics.select();
  }, [snapTo]);

  // An open drawer is a level of Home, not a screen, so the stack has nothing
  // to pop: without this the Android Back press sent the whole app to the
  // background instead of closing the drawer (emulator acceptance, Nov 9,
  // 2026). Registered only while Home is focused and a drawer is open, so Back
  // on any other screen, or on Home at rest, keeps its normal meaning.
  useFocusEffect(useCallback(() => {
    if (activeDrawer == null) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      returnHome();
      return true;
    });
    return () => subscription.remove();
  }, [activeDrawer, returnHome]));

  const openFeatures = useCallback(() => {
    snapTo(drawerWidth);
    void haptics.select();
  }, [drawerWidth, snapTo]);

  const openWork = useCallback(() => {
    snapTo(-drawerWidth);
    void haptics.select();
  }, [drawerWidth, snapTo]);
  // A press acts only while its pill is fully drawn (#9630 final, r3g2), read
  // at the press from the live offset and the current thresholds (Sol answer 1).
  const openFeaturesHandle = useCallback(() => { if (homeHandleDrawn(handleOffset.current, handleWholeFromRef.current.features)) openFeatures(); }, [openFeatures]);
  const openWorkHandle = useCallback(() => { if (homeHandleDrawn(handleOffset.current, handleWholeFromRef.current.work)) openWork(); }, [openWork]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // Any decisively horizontal drag on the Home card arms the drawers. The
    // old edge-only strips sat exactly inside the band Android gesture
    // navigation reserves for system back, so on a Pixel the OS consumed the
    // swipe before the app ever saw it; the direction lock alone keeps the
    // vertical feed and taps unclaimed, and Home has no horizontal scrollers
    // to fight (the quick-actions drawer stands down on this route).
    onMoveShouldSetPanResponder: (_event, gesture) => {
      if (Math.abs(gesture.dx) <= DIRECTION_LOCK) return false;
      return Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      animation.current?.stop();
      setIsMoving(true);
      gestureStart.current = translateValue.current;
      Keyboard.dismiss();
    },
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-drawerWidth, Math.min(drawerWidth, gestureStart.current + gesture.dx)));
    },
    onPanResponderRelease: (_, gesture) => {
      const current = translateValue.current;
      const projected = current + gesture.vx * 220;
      let destination = 0;
      if (projected > drawerWidth * 0.35 || current > drawerWidth * 0.5) destination = drawerWidth;
      else if (projected < -drawerWidth * 0.35 || current < -drawerWidth * 0.5) destination = -drawerWidth;
      snapTo(destination);
      if (Math.sign(destination) !== Math.sign(gestureStart.current)) void haptics.select();
    },
    onPanResponderTerminate: () => {
      snapTo(translateValue.current > drawerWidth * 0.5
        ? drawerWidth
        : translateValue.current < -drawerWidth * 0.5
          ? -drawerWidth
          : 0);
    },
  }), [drawerWidth, translateX, snapTo]);

  const featureCornerRadius = frame.featureRadius;
  const workCornerRadius = frame.workRadius;
  // Only the revealed side rounds; the other edge stays flush with the screen.
  const edgeRadiusStyle = {
    borderTopLeftRadius: featureCornerRadius,
    borderBottomLeftRadius: featureCornerRadius,
    borderTopRightRadius: workCornerRadius,
    borderBottomRightRadius: workCornerRadius,
  };
  // The two progresses are mutually exclusive, so their sum is the reveal.
  const veilOpacity = frame.reveal * HOME_VEIL_OPACITY;

  return (
    <View style={[styles.homeBox, { backgroundColor: theme.muted, marginBottom: minimizedReserve }]}>
      {settledDrawer == null ? (
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={t("Home navigation")}
          accessibilityActions={[
            { name: 'openFeatures', label: t("Open All tools") },
            { name: 'openWork', label: t("Open Campaign work") },
          ]}
          importantForAccessibility="yes"
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'openFeatures') openFeatures();
            else if (event.nativeEvent.actionName === 'openWork') openWork();
          }}
          pointerEvents="none"
          style={styles.homeDrawerActions}
        />
      ) : null}
      <View
        accessibilityElementsHidden={activeDrawer !== 'features'}
        importantForAccessibility={activeDrawer === 'features' ? 'auto' : 'no-hide-descendants'}
        pointerEvents={activeDrawer === 'features' ? 'auto' : 'none'}
        style={[styles.drawer, styles.drawerLeft, {
          width: drawerWidth,
          zIndex: visibleDrawer === 'features' ? 1 : 0,
          // Only the revealed drawer paints. The other one used to sit beneath
          // the sheet at zIndex 0 and showed through the facing corners as a
          // white block of its own cards, with its row text bleeding past the
          // bottom curve — the third-page residue the owner correction bans.
          opacity: visibleDrawer === 'features' ? 1 : 0,
        }]}
      >
        <MemoFunctionDeck
          width={drawerWidth}
          height={height}
          topPad={topPad}
          bottomPad={bottomPad}
          groups={groups}
          footer={guideFooter}
          onHome={returnHome}
          shortcutScope={quickActionsScope(mode, previewHat, authorizedRoles)}
        />
      </View>

      <View
        accessibilityElementsHidden={activeDrawer !== 'work'}
        importantForAccessibility={activeDrawer === 'work' ? 'auto' : 'no-hide-descendants'}
        pointerEvents={activeDrawer === 'work' ? 'auto' : 'none'}
        style={[styles.drawer, styles.drawerRight, {
          // Under-layer canvas: unelevated and dimmer than the Home sheet
          // (brief §E), the same muted canvas the features deck already used.
          backgroundColor: theme.muted,
          width: drawerWidth,
          zIndex: visibleDrawer === 'work' ? 1 : 0,
          opacity: visibleDrawer === 'work' ? 1 : 0,
        }]}
      >
        {dashboard ? (
          <DrawerPage width={drawerWidth} height={height} topPad={topPad} bottomPad={bottomPad}>
            <Heading>{t("Campaign work")}</Heading>
            <MemoWorkWidgets
              dashboard={dashboard}
              desk={previewDesk}
              channels={inboxChannels}
              items={workItems}
              language={language}
              staffRole={deskRole}
              staffNumbers={deskNumbers?.status === 'ready' ? deskNumbers.numbers : []}
              customizable={mode === 'preview' && previewHat != null}
              layout={widgetLayout}
              onLayoutChange={changeWidgetLayout}
            />
          </DrawerPage>
        ) : (
          // The drawer is reachable before the dashboard resolves, so it states
          // the load and offers the same retry the Home card does. Not
          // StateMessage: that queues its own VoiceOver announcement, and the
          // Home card's copy is already mounted and announcing.
          <DrawerPage width={drawerWidth} height={height} topPad={topPad} bottomPad={bottomPad}>
            <Heading>{t("Campaign work")}</Heading>
            <View accessibilityLiveRegion="polite" style={styles.drawerState}>
              <Body muted>{error ?? t("Loading your home.")}</Body>
              {error ? <Button label={refreshing ? t("Retrying…") : t("Try again")} disabled={refreshing} onPress={() => { void refresh(); }} /> : null}
            </View>
          </DrawerPage>
        )}
      </View>

      {/* The sheet's outer view casts the panel shadow and must not clip, or
          iOS drops the shadow; the inner view clips the feed to the same
          corners. */}
      <View
        {...(settledDrawer ? {} : pan.panHandlers)}
        accessibilityElementsHidden={visibleDrawer != null || isMoving}
        importantForAccessibility={visibleDrawer != null || isMoving ? 'no-hide-descendants' : 'auto'}
        pointerEvents={settledDrawer ? 'none' : 'auto'}
        style={[
          styles.homeCard,
          revealedShadow(elevation.level3, frame.reveal, visibleDrawer === 'features' ? 'left' : 'right'),
          {
            backgroundColor: theme.background,
            transform: [{ translateX: frame.x }],
          },
          edgeRadiusStyle,
        ]}
      >
        <View style={[styles.homeCardClip, edgeRadiusStyle]}>
          <View style={styles.fill} pointerEvents={visibleDrawer != null || isMoving ? 'none' : 'auto'}>{children}</View>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={[styles.homeVeil, { backgroundColor: theme.background, opacity: veilOpacity }]}
          />
        </View>
      </View>

        <View
          {...pan.panHandlers}
          pointerEvents={settledDrawer ? 'auto' : 'none'}
          accessibilityElementsHidden={activeDrawer == null}
          importantForAccessibility={activeDrawer == null ? 'no-hide-descendants' : 'auto'}
          style={[
            styles.homePeek,
            visibleDrawer === 'features'
              ? { right: 0, width: homePeekWidth }
              : { left: 0, width: homePeekWidth },
          ]}
        >
          {/* Rendered only while a drawer is open: Android's accessibility
              tree still listed the disabled button over the closed Home, so
              TalkBack could announce a control that did nothing. */}
          {activeDrawer != null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Close drawer and return to Home")}
              onPress={returnHome}
              style={styles.homePeekTarget}
            />
          ) : null}
        </View>
      {settledDrawer == null ? (
        // Keyed by the mount: a window or text size change mounts the clip and
        // both pills again, and each reports its size. React Native calls
        // onLayout only on mount or when a frame moves.
        <View key={handleMountId} testID="home-drawer-handle-clip" pointerEvents="box-none" onLayout={(event) => measureClip(event.nativeEvent.layout.height)} style={[styles.drawerHandleClip, { bottom: handleClipInset }]}>
          {/* Preserve the handles' full-height coordinate plane (including the
              loading-state centre). Only this transparent sibling is clipped;
              the sheet and feed remain full-edge. */}
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { bottom: -handleClipInset }]}>
          <Animated.View
            {...handleState(handlesDrawn.features)}
            style={[styles.drawerOpenHandleColumn, styles.drawerOpenHandleLeft, handleRow(featuresOpacity)]}
          >
            {/* UX-UG-NATIVE-HOME-DRAWERS-UNLABELED-CHEVRONS-20261018:
                each handle names its drawer in visible text, not only for a
                screen reader. The onboarding audit (F9) read the bare
                left-pointing chevron on the root screen as navigation, not as
                "everything else in the app". The pill is the secondary-button
                recipe from ./ui (secondary fill, audited 4.5:1 label, the
                level-1 hairline edge) at the 48pt minimum. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Open All tools")}
              onLayout={(event) => measurePill('features', event.nativeEvent.layout.height)}
              onPress={openFeaturesHandle}
              style={[styles.drawerOpenHandle, { maxWidth: handleBudget, backgroundColor: theme.secondary, borderColor: theme.border }]}
            >
              <Ionicons name="chevron-back" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />
              <Text key={handleLabelKey} {...handleLabelText} style={[styles.drawerOpenHandleLabel, { color: theme.secondaryForeground }]}>{t("All tools")}</Text>
            </Pressable>
          </Animated.View>
          <Animated.View
            {...handleState(handlesDrawn.work)}
            style={[styles.drawerOpenHandleColumn, styles.drawerOpenHandleRight, handleRow(workOpacity)]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Open Campaign work")}
              onLayout={(event) => measurePill('work', event.nativeEvent.layout.height)}
              onPress={openWorkHandle}
              style={[styles.drawerOpenHandle, { maxWidth: handleBudget, backgroundColor: theme.secondary, borderColor: theme.border }]}
            >
              <Text {...handleLabelText} style={[styles.drawerOpenHandleLabel, { color: theme.secondaryForeground }]}>Campaign work</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />
            </Pressable>
          </Animated.View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function DrawerPage({ width, height, topPad, bottomPad, children }: {
  width: number;
  height: number;
  topPad: number;
  bottomPad: number;
  children: ReactNode;
}) {
  const { t } = useNativeUi();
  const theme = useTheme();
  return (
    <ScrollView
      accessibilityLabel={t("Work")}
      automaticallyAdjustContentInsets={false}
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.drawerPage,
        { minHeight: height - bottomPad, paddingTop: topPad, paddingBottom: bottomPad + spacing.lg },
      ]}
      directionalLockEnabled
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      style={{ width, backgroundColor: theme.muted }}
    >
      {/* The Work drawer sits outside Screen's relayout too: its '1 unread'
          badge and Messages card kept their launch-size frames after the text
          size was lowered (#6976), so its page mounts again at a size change. */}
      <FontScaleRelayout>{children}</FontScaleRelayout>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Home's own box clips the drawer handles that ride their row below it.
  homeBox: { flex: 1, overflow: 'hidden' },
  // Sibling VoiceOver host for drawer actions; keep it tiny so it cannot group
  // or overlay the Home feed.
  homeDrawerActions: { position: 'absolute', width: 1, height: 1 },
  drawer: { position: 'absolute', top: 0, bottom: 0, zIndex: 0 },
  drawerLeft: { left: 0 },
  drawerRight: { right: 0 },
  drawerPage: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  drawerState: { gap: spacing.md },
  // One transformed sheet: the outer view shadows, the inner view clips. No
  // edge is outlined; a hairline down the facing edge read as the frame of a
  // second phone screen inside the display (#6811).
  homeCard: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2 },
  homeCardClip: { flex: 1, overflow: 'hidden' },
  homeVeil: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },
  homePeek: { position: 'absolute', top: 0, bottom: 0, zIndex: 4 },
  homePeekTarget: { flex: 1, minHeight: minimumTouchTarget },
  // Its own row, placed at the measured bottom of Home's stat band, not a
  // full-height column centred wherever the feed happens to put that band.
  // Each column is as wide as its labelled pill; the row keeps the 48pt
  // minimum height, and the pills sit on the feed's own horizontal inset so
  // they line up with the stat band above instead of touching the screen edge.
  drawerHandleClip: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    overflow: 'hidden', zIndex: 3,
    elevation: (elevation.level3.elevation ?? 0) + 1,
  },
  drawerOpenHandleColumn: {
    position: 'absolute',
    height: minimumTouchTarget,
    zIndex: 3,
    // Android orders siblings by elevation before zIndex, so while the sheet
    // moves with its level-3 elevation the handles sit one step above it
    // instead of under the opaque sheet. The column
    // has no fill, so it casts no shadow of its own.
    elevation: (elevation.level3.elevation ?? 0) + 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  drawerOpenHandleCentred: { top: '50%', marginTop: -minimumTouchTarget / 2 },
  drawerOpenHandleLeft: { left: spacing.lg },
  drawerOpenHandleRight: { right: spacing.lg },
  drawerOpenHandle: {
    minHeight: minimumTouchTarget,
    minWidth: minimumTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  drawerOpenHandleLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong, flexShrink: 1 },
});
