import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, G, LinearGradient, Mask, Rect, Stop } from 'react-native-svg';

import { useReduceMotion } from '../lib/reduceMotion';
import {
  SHINE_BORDER_COLORS,
  SHINE_BORDER_DURATION_MS,
  SHINE_BORDER_WIDTH,
  SHINE_GRADIENT_PERIODS,
  shineGradientStops,
} from '../theme/shineBorder';

// Port of the 21st.dev / Magic UI "shine border" (dillionverma): a rounded
// border whose stroke is a multi-stop gradient that travels around the ring
// (CSS: background-size 300%, animated background-position, masked to the
// border box). React Native has no border-image or mask-composite, so the ring
// is an SVG: a luminance mask cuts the ring out of a rounded rect, and a
// gradient rect three times the control's width slides one period behind it.
// The interior stays fully transparent, so whatever the wrapped control draws
// (ink only, for the hat pill) reads on the canvas underneath.
//
// The ring is decorative: it is removed from the accessibility tree, takes no
// touches, and holds still (frame zero of the loop) under Reduce Motion or
// while `paused`. The palette lives in ../theme/shineBorder.
//
// `fillOpacity` extends the same travelling gradient to the control's interior
// as one faint pass, and `drift` eases it in and out and reverses each cycle:
// the hat pill's slow sheen
// (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010) rides
// the mechanism already here rather than adding a second one.

const AnimatedRect = Animated.createAnimatedComponent(Rect);

let instance = 0;

export function ShineBorder({
  children,
  color = SHINE_BORDER_COLORS,
  borderWidth = SHINE_BORDER_WIDTH,
  borderRadius,
  duration = SHINE_BORDER_DURATION_MS,
  fillOpacity = 0,
  drift = false,
  paused = false,
  style,
}: {
  children?: ReactNode;
  /** One color for a monotone ring, or a list that flows around the border. */
  color?: string | readonly string[];
  borderWidth?: number;
  /** Defaults to a full pill (half the measured height). */
  borderRadius?: number;
  duration?: number;
  /** Paints the same travelling gradient across the interior at this opacity. */
  fillOpacity?: number;
  /** Eases the travel in and out and reverses it each cycle, instead of one linear loop. */
  drift?: boolean;
  /** Holds the ring still, e.g. while the control's menu is open or it is off screen. */
  paused?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  // Measured once per layout change; the travelling gradient animates on the
  // SVG rect's own prop, so frames never re-render the host.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const travel = useRef(new Animated.Value(0)).current;
  // SVG paint-server ids are document-global, so each ring takes its own pair.
  const ringId = useRef(0);
  if (ringId.current === 0) {
    instance += 1;
    ringId.current = instance;
  }
  const gradientId = `shine-gradient-${ringId.current}`;
  const maskId = `shine-mask-${ringId.current}`;

  useEffect(() => {
    if (reduceMotion) {
      // Reduce Motion is a static ring on frame zero, not a frozen mid-slide.
      travel.stopAnimation();
      travel.setValue(0);
      return;
    }
    if (paused) {
      travel.stopAnimation();
      return;
    }
    const loop = drift
      ? Animated.loop(Animated.sequence([
        Animated.timing(travel, { toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(travel, { toValue: 0, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ]))
      : Animated.loop(
        Animated.timing(travel, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: false }),
      );
    loop.start();
    return () => { loop.stop(); };
  }, [drift, duration, paused, reduceMotion, travel]);

  const colors = typeof color === 'string' ? [color] : color;
  const stops = shineGradientStops(colors);
  const { width, height } = size;
  const radius = borderRadius ?? height / 2;
  const inner = Math.max(0, radius - borderWidth);
  // Slides left by one control width: the palette repeats once per width.
  const x = travel.interpolate({ inputRange: [0, 1], outputRange: [0, -width] });

  return (
    <View
      style={[styles.host, style]}
      onLayout={(event: LayoutChangeEvent) => {
        const layout = event.nativeEvent.layout;
        setSize((prev) => (prev.width === layout.width && prev.height === layout.height
          ? prev
          : { width: layout.width, height: layout.height }));
      }}
    >
      {width > 0 && height > 0 ? (
        <Svg
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
          width={width}
          height={height}
        >
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
              {stops.map((stop, index) => (
                <Stop key={`${stop}-${index}`} offset={index / (stops.length - 1)} stopColor={stop} />
              ))}
            </LinearGradient>
            <Mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
              <Rect x={0} y={0} width={width} height={height} rx={radius} ry={radius} fill="#fff" />
              <Rect
                x={borderWidth}
                y={borderWidth}
                width={Math.max(0, width - borderWidth * 2)}
                height={Math.max(0, height - borderWidth * 2)}
                rx={inner}
                ry={inner}
                fill="#000"
              />
            </Mask>
          </Defs>
          {fillOpacity > 0 ? (
            <AnimatedRect
              x={x}
              y={0}
              width={width * SHINE_GRADIENT_PERIODS}
              height={height}
              fill={`url(#${gradientId})`}
              opacity={fillOpacity}
            />
          ) : null}
          <G mask={`url(#${maskId})`}>
            <AnimatedRect x={x} y={0} width={width * SHINE_GRADIENT_PERIODS} height={height} fill={`url(#${gradientId})`} />
          </G>
        </Svg>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'relative', overflow: 'hidden' },
});
