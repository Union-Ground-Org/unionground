import { useEffect, useRef, useState, type PropsWithChildren, type Ref } from 'react';
import { Animated, Pressable, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';

import { useReduceMotion } from '../lib/reduceMotion';
import { elevation, pressedScale, type ElevationToken } from '../theme/elevation';

// The shared press response (the "Controls feel alive"; Codex
// thread 3). Every pressable surface compresses and softens its shadow through
// one spring, so no screen grows its own press constant or its own timing.
//
// The spring is deliberately calm: fast enough to feel attached to the finger,
// with zero bounciness so nothing overshoots. The contract forbids excessive
// bounce, and a button that wobbles on release reads as a toy.
export const PRESS_SPRING = { speed: 26, bounciness: 0 } as const;

// Elevation tokens are typed against ViewStyle, whose shadow values allow
// animated nodes; the ladder only ever ships plain numbers.
function numeric(value: ElevationToken['shadowOpacity' | 'shadowRadius']): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * Drives the compression for a surface whose pressed state is owned elsewhere
 * (the shared Card takes `pressed` as a prop).
 *
 * Reduce Motion keeps the previous behaviour exactly: values are applied
 * instantly and the scale is not driven at all, so nothing on screen moves.
 */
export function usePressSpring(pressed: boolean, resting: ElevationToken = elevation.level1) {
  const reduceMotion = useReduceMotion();
  const press = useRef(new Animated.Value(pressed ? 1 : 0)).current;
  // Lists mount many cards at rest; without this every one of them would start
  // a spring to the value it already holds.
  const settled = useRef(pressed ? 1 : 0);

  useEffect(() => {
    const toValue = pressed ? 1 : 0;
    if (settled.current === toValue) return;
    settled.current = toValue;
    if (reduceMotion) {
      press.setValue(toValue);
      return;
    }
    const animation = Animated.spring(press, { toValue, useNativeDriver: false, ...PRESS_SPRING });
    animation.start();
    return () => { animation.stop(); };
  }, [press, pressed, reduceMotion]);

  // Shadow and transform animate off one value, so they cannot drift apart.
  // The JS driver is required: shadowOpacity and shadowRadius have no native
  // animated equivalent, and splitting the two would need two springs.
  return {
    transform: [{
      scale: press.interpolate({
        inputRange: [0, 1],
        outputRange: [1, reduceMotion ? 1 : pressedScale],
      }),
    }],
    shadowOpacity: press.interpolate({
      inputRange: [0, 1],
      outputRange: [numeric(resting.shadowOpacity), numeric(elevation.pressedShadow.shadowOpacity)],
    }),
    shadowRadius: press.interpolate({
      inputRange: [0, 1],
      outputRange: [resting.shadowRadius ?? 0, elevation.pressedShadow.shadowRadius ?? 0],
    }),
  };
}

/**
 * A Pressable that owns its own press state and springs. The visual surface is
 * the inner animated view, so `style` carries the fill, radius and resting
 * elevation exactly as it did on the plain Pressable.
 */
export function PressableScale({
  style,
  resting = elevation.level1,
  pressedOpacity = 1,
  pressedFill,
  children,
  onPressIn,
  onPressOut,
  ref,
  ...pressableProps
}: PropsWithChildren<PressableProps & {
  /** The pressable host view, for a screen that moves accessibility focus to it. */
  ref?: Ref<View>;
  style?: StyleProp<ViewStyle>;
  /** Resting elevation the shadow springs back to. */
  resting?: ElevationToken;
  /** Optional dim on the way down, for fills that need more than compression. */
  pressedOpacity?: number;
  /**
   * Optional fill painted only while pressed. A level-0 row inside a flat
   * grouped block has no fill and no shadow of its own, so compression plus
   * the dim alone reads as nothing happening on a phone (
   * check 4); the fill is the visible pressed state for such rows.
   */
  pressedFill?: string;
}>) {
  const [pressed, setPressed] = useState(false);
  const animated = usePressSpring(pressed, resting);
  const active = pressed && !pressableProps.disabled;

  return (
    <Pressable
      {...pressableProps}
      ref={ref}
      onPressIn={(event) => { setPressed(true); onPressIn?.(event); }}
      onPressOut={(event) => { setPressed(false); onPressOut?.(event); }}
    >
      {/* The wrapper Pressable carries no style at all, so the surface keeps
          the sizing it had when the Pressable was the surface. */}
      <Animated.View style={[style, animated, active ? { opacity: pressedOpacity } : null, active && pressedFill ? { backgroundColor: pressedFill } : null]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
