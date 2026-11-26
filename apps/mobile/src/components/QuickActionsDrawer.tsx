import { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { Animated, BackHandler, Easing, Keyboard, PanResponder, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { contentStartInset, quickActionsGestureBandTop } from '../lib/chrome';
import { nativeTabPath, quickActionsPathEligible, quickCaptureScope } from '../lib/quickActions';
import { useReduceMotion } from '../lib/reduceMotion';
import { useHeldScreenScope } from '../lib/heldScreenScope';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { CompassPanel } from './CompassPanel';

const DRAWER_WIDTH_RATIO = 0.86;
const DRAWER_CARD_RADIUS = 28;
// p1-wave2a P2: this panel was the last shared surface still declaring a shadow
// by hand — `0 -8px 24px 18%` beside `shadowColor: theme.foreground` — which is
// the level-3 pass at three wrong numbers and a hue the ladder does not use.
// It takes the token instead, with the same rotation the Home carousel applies
// because this drawer also reveals from the side rather than rising upward.
const L3_EDGE_OFFSET = elevation.level3.shadowOffset?.height ?? 0;
// Android gesture navigation consumes horizontal drags that begin inside its
// ~28px system back band, so an arm zone of exactly that band left the drawer
// unreachable on the Pixel 10a. Android widens the zone past the system strip;
// iOS keeps the tight edge so content swipes stay unclaimed. Where the wider
// band crosses a native horizontal scroller (the Work case board, the
// Messages quick row), the scroller's native interception wins the race and
// the drawer simply stays edge-armed elsewhere on that screen — the same
// reach it had before, never less.
const EDGE_PAN_WIDTH = Platform.select({ android: 64, default: 28 });
const DIRECTION_LOCK = 10;

export function QuickActionsDrawer({ children }: PropsWithChildren) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const { mode, previewHat, locked, privacyCovered, session, chapterMemberships, organizationID } = useApp();
  const active = (mode === 'preview' || mode === 'authenticated')
    && !locked
    && !privacyCovered
    && quickActionsPathEligible(pathname);
  const drawerWidth = Math.min(width * DRAWER_WIDTH_RATIO, 400);
  // The one content start line, like every other surface: the drawer no longer
  // reserves a band for the hat pill, which floats free of it now.
  const topPad = contentStartInset(insets.top);
  const captureScope = quickCaptureScope(
      mode,
      previewHat,
      session?.user.id ?? null,
      chapterMemberships.find((entry) => entry.selected)?.chapterID ?? null,
    );
  const scope = useHeldScreenScope(mode === 'booting', [session?.user.id], [mode, organizationID, captureScope]);

  // 0 = closed, 1 = fully open; the panel and scrim interpolate from this.
  const openAmount = useRef(new Animated.Value(0)).current;
  const amountValue = useRef(0);
  const gestureStart = useRef(0);
  const [engaged, setEngaged] = useState(false);
  const [open, setOpen] = useState(false);
  const returnAfterCheck = useRef(false);
  const activeRef = useRef(active);
  const openRef = useRef(open);
  const drawerWidthRef = useRef(drawerWidth);
  const widthRef = useRef(width);
  // Bottom band reserved for the real platform tab bar, so an edge swipe never
  // steals native tab presses or keeps the removed capsule's dead zone alive.
  const tabBandTopRef = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  // The Android back handler and the pan responder both capture a `snapTo`
  // from the render that registered them, so the setting has to be read
  // through a ref for a mid-session change to reach those paths without a
  // remount. The hook republishes on `reduceMotionChanged`, and the ref is
  // assigned on every render beside the other live values below.
  const reduceMotion = useReduceMotion();
  const reduceMotionRef = useRef(reduceMotion);
  activeRef.current = active;
  openRef.current = open;
  drawerWidthRef.current = drawerWidth;
  widthRef.current = width;
  reduceMotionRef.current = reduceMotion;
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other';
  tabBandTopRef.current = quickActionsGestureBandTop(height, insets.bottom, platform, nativeTabPath(pathname));

  useEffect(() => {
    const listener = openAmount.addListener(({ value }) => {
      amountValue.current = value;
    });
    return () => openAmount.removeListener(listener);
  }, [openAmount]);

  useEffect(() => {
    if (active) {
      if (returnAfterCheck.current) {
        returnAfterCheck.current = false;
        openAmount.setValue(1); setEngaged(true); setOpen(true);
      }
      return;
    }
    if (!engaged && !returnAfterCheck.current) return;
    // Dismiss and disarm immediately, including its hardware-back handler.
    // Only a temporary session/privacy check keeps the concealed draft owner
    // mounted; lock, sign-out and leaving eligible routes retire it.
    returnAfterCheck.current = !locked && (mode === 'booting' || (mode === 'authenticated' && privacyCovered)) && quickActionsPathEligible(pathname);
    // The route or session left drawer territory (lock cover, sign-out,
    // navigation to Home): dismiss immediately rather than animating.
    animation.current?.stop();
    openAmount.setValue(0);
    setEngaged(false);
    setOpen(false);
  }, [active, engaged, locked, mode, openAmount, pathname, privacyCovered]);

  useEffect(() => {
    if (!engaged) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      snapTo(0);
      return true;
    });
    return () => subscription.remove();
  }, [engaged]);

  // The resting state every snap path lands on, animated or not.
  function settle(target: 0 | 1) {
    if (target === 0) {
      setEngaged(false);
      setOpen(false);
    } else {
      setOpen(true);
    }
  }

  function snapTo(target: 0 | 1) {
    animation.current?.stop();
    if (reduceMotionRef.current) {
      // Reduce Motion: the panel and scrim go straight to the resting value
      // instead of travelling for 360ms, and the same completion work runs so
      // gesture release, hardware back and programmatic open or close settle
      // exactly where the animated path leaves them.
      animation.current = null;
      openAmount.setValue(target);
      settle(target);
      return;
    }
    animation.current = Animated.timing(openAmount, {
      toValue: target,
      duration: 360,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
      useNativeDriver: true,
    });
    animation.current.start(({ finished }) => {
      if (!finished) return;
      settle(target);
    });
  }

  function close() {
    void haptics.select();
    snapTo(0);
  }

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (event, gesture) => {
      if (!activeRef.current) return false;
      if (Math.abs(gesture.dx) <= DIRECTION_LOCK) return false;
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * 1.15) return false;
      if (openRef.current) return true;
      const startX = event.nativeEvent.pageX - gesture.dx;
      const startY = event.nativeEvent.pageY - gesture.dy;
      if (startY >= tabBandTopRef.current) return false;
      return startX >= widthRef.current - EDGE_PAN_WIDTH && gesture.dx < 0;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      animation.current?.stop();
      gestureStart.current = amountValue.current;
      setEngaged(true);
      Keyboard.dismiss();
    },
    onPanResponderMove: (_, gesture) => {
      const next = gestureStart.current - gesture.dx / drawerWidthRef.current;
      openAmount.setValue(Math.max(0, Math.min(1, next)));
    },
    onPanResponderRelease: (_, gesture) => {
      const current = amountValue.current;
      const projected = current - (gesture.vx * 220) / drawerWidthRef.current;
      const target = projected > 0.35 || current > 0.5 ? 1 : 0;
      snapTo(target);
      if (target === 1 && !openRef.current) void haptics.select();
    },
    onPanResponderTerminate: () => {
      snapTo(amountValue.current > 0.5 ? 1 : 0);
    },
  }), [openAmount]);

  const translateX = openAmount.interpolate({ inputRange: [0, 1], outputRange: [drawerWidth, 0] });
  const scrimOpacity = openAmount.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <View style={styles.fill} {...pan.panHandlers}>
      <View
        style={styles.fill}
        accessibilityElementsHidden={engaged}
        importantForAccessibility={engaged ? 'no-hide-descendants' : 'auto'}
        accessibilityActions={active ? [{ name: 'magicTap', label: 'Open the Guide' }] : undefined}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName !== 'magicTap' || !activeRef.current) return;
          setEngaged(true);
          snapTo(1);
        }}
      >
        {children}
      </View>
      {engaged || returnAfterCheck.current ? (
        <View style={[StyleSheet.absoluteFill, !active || !engaged ? { display: 'none' } : null]} pointerEvents="box-none" accessibilityElementsHidden={!active || !engaged} importantForAccessibility={!active || !engaged ? 'no-hide-descendants' : 'auto'}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrimOpacity }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close the Guide"
              onPress={close}
              style={styles.fill}
            />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            style={[
              styles.panel,
              {
                width: drawerWidth,
                backgroundColor: theme.background,
                borderColor: theme.border,
                transform: [{ translateX }],
              },
            ]}
          >
            <View style={styles.fill}>
              <PanelClose label="Close the Guide" topPad={topPad} onPress={close} />
              <CompassPanel key={scope} bottomSafeArea={insets.bottom} onRouteOut={close} />
            </View>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

function PanelClose({ label, topPad, onPress }: { label: string; topPad: number; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.closeRow, { paddingTop: topPad }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.closeButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
      >
        <Ionicons name="chevron-forward" size={20} color={theme.secondaryForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { backgroundColor: 'rgba(20,17,22,0.4)' },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: DRAWER_CARD_RADIUS,
    borderBottomLeftRadius: DRAWER_CARD_RADIUS,
    borderLeftWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    ...elevation.level3,
    shadowOffset: { width: -L3_EDGE_OFFSET, height: 0 },
  },
  closeRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, alignItems: 'flex-start' },
  closeButton: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
