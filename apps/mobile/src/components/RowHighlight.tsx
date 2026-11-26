import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { Animated, Easing, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { useReduceMotion } from '../lib/reduceMotion';
import { createTouchGate, resolveGlow, ROW_GLOW_SURFACE, type GlowFrame, type RowFrame } from '../lib/rowHighlight';
import { radii } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

// The list-highlight primitive (owner request 2026-09-13, after 21st.dev
// hyperiux/interactive-list-preview, and the twin of the web's
// src/lib/rowHighlight.js). A long list draws ONE translucent bar that glides
// from row to row under the finger, instead of every row owning a block that
// snaps on and off. The rows keep their own Pressable for the tap; this is the
// tracking layer underneath them, and it replaces a row's own pressed fill so
// a row never carries two highlights.
//
// A view opts in by wrapping its row container in HighlightList and each
// tappable row in HighlightRow. Rows must be direct children of the list (a
// Fragment is fine): they report their frame relative to their parent, and the
// bar is positioned in the list's own coordinate space. A child that is not a
// HighlightRow — a section header, a non-interactive row — reports no frame,
// so the bar never lights something a touch cannot act on.
//
// The bar is decorative: hidden from VoiceOver, never a touch target, and the
// list only listens to touches (onTouchStart/Move/End never claim the
// responder), so a row's own press, the scroll gesture and swipe-back all work
// as before. Under Reduce Motion the bar lands on the row instead of gliding.

// The bar keeps 1pt off each edge of a row so it never covers the hairline
// separators lists draw between rows.
export const ROW_GLOW_INSET = 1;
// One glide, short enough to stay attached to the finger.
export const ROW_GLOW_MS = 190;
// The bar appears and leaves on its own fade so a first touch does not shoot
// it across the list.
export const ROW_GLOW_FADE_IN_MS = 90;
export const ROW_GLOW_FADE_OUT_MS = 160;
// The list's on-screen origin is re-read at most this often while a finger is
// moving; between reads the cached origin drives the bar.
const REMEASURE_MS = 150;

type Registry = {
  register: (id: string, frame: RowFrame) => void;
  release: (id: string) => void;
};

const HighlightContext = createContext<Registry | null>(null);

export function HighlightList({ children, style, radius = radii.rowRadius }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; radius?: number }>) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const listRef = useRef<View>(null);
  const frames = useRef(new Map<string, RowFrame>()).current;
  const [gate] = useState(createTouchGate);
  const top = useRef(new Animated.Value(0)).current;
  const height = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // Root-relative origin of the list, in the same space as a touch's pageY. It
  // is re-read on layout, at the start of every touch and while a finger moves:
  // the list rides a ScrollView, so its position changes under the touch.
  const pageTop = useRef(0);
  const measuredAt = useRef(0);
  // False from touch start until that touch's measurement lands, so moves that
  // arrive first are not resolved against an origin from an earlier scroll.
  const armed = useRef(false);
  const parked = useRef<GlowFrame | null>(null);

  const registry = useMemo<Registry>(() => ({
    register: (id, frame) => { frames.set(id, frame); },
    release: (id) => { frames.delete(id); },
  }), [frames]);

  useEffect(() => () => {
    gate.end();
    top.stopAnimation();
    height.stopAnimation();
    opacity.stopAnimation();
  }, [gate, height, opacity, top]);

  const measure = useCallback((then?: (origin: number) => void) => {
    measuredAt.current = Date.now();
    listRef.current?.measure((_x, _y, _width, _height, _pageX, pageY) => {
      if (typeof pageY === 'number') pageTop.current = pageY;
      then?.(pageTop.current);
    });
  }, []);

  const hide = useCallback(() => {
    if (!parked.current) return;
    parked.current = null;
    Animated.timing(opacity, { toValue: 0, duration: reduceMotion ? 0 : ROW_GLOW_FADE_OUT_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [opacity, reduceMotion]);

  const place = useCallback((offset: number) => {
    const step = resolveGlow([...frames.values()], offset, parked.current, ROW_GLOW_INSET);
    if (step.action === 'stay') return;
    if (step.action === 'hide') { hide(); return; }
    parked.current = step.frame;
    if (step.action === 'land' || reduceMotion) {
      top.setValue(step.frame.top);
      height.setValue(step.frame.height);
    } else {
      Animated.parallel([
        Animated.timing(top, { toValue: step.frame.top, duration: ROW_GLOW_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(height, { toValue: step.frame.height, duration: ROW_GLOW_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      ]).start();
    }
    if (step.action === 'land') {
      Animated.timing(opacity, { toValue: 1, duration: reduceMotion ? 0 : ROW_GLOW_FADE_IN_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }
  }, [frames, height, hide, opacity, reduceMotion, top]);

  const onTouchStart = useCallback((event: GestureResponderEvent) => {
    const { pageY } = event.nativeEvent;
    const token = gate.begin();
    armed.current = false;
    // Land on the measured origin rather than a cached one: the list may have
    // scrolled since the last touch. A tap can lift before this returns; the
    // gate drops the late callback so the bar cannot land after release.
    measure((origin) => {
      if (!gate.isLive(token)) return;
      armed.current = true;
      place(pageY - origin);
    });
  }, [gate, measure, place]);

  const onTouchMove = useCallback((event: GestureResponderEvent) => {
    if (!armed.current) return;
    place(event.nativeEvent.pageY - pageTop.current);
    if (Date.now() - measuredAt.current > REMEASURE_MS) measure();
  }, [measure, place]);

  const release = useCallback(() => {
    gate.end();
    armed.current = false;
    hide();
  }, [gate, hide]);

  return (
    <HighlightContext.Provider value={registry}>
      <View
        ref={listRef}
        style={style}
        onLayout={() => measure()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={release}
        onTouchCancel={release}
      >
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[styles.glow, { backgroundColor: theme[ROW_GLOW_SURFACE], borderColor: theme.border, borderRadius: radius, opacity, height, transform: [{ translateY: top }] }]}
        />
        {children}
      </View>
    </HighlightContext.Provider>
  );
}

/**
 * A row of a HighlightList. Reports its own frame; renders nothing of its own
 * beyond the wrapper, so the row's existing Pressable, copy and label are
 * untouched. Outside a HighlightList it is a plain View.
 */
export function HighlightRow({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const registry = useContext(HighlightContext);
  const id = useId();
  useEffect(() => () => registry?.release(id), [id, registry]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    registry?.register(id, { y, height });
  }, [id, registry]);
  return <View style={style} onLayout={registry ? onLayout : undefined}>{children}</View>;
}

const styles = StyleSheet.create({
  // The fill alone is near-invisible on the paler palettes, so the bar carries
  // the same hairline every grouped surface uses and reads as a frame that
  // glides.
  glow: { position: 'absolute', left: 0, right: 0, top: 0, borderWidth: StyleSheet.hairlineWidth },
});
