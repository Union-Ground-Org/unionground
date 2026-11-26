import { BlurView } from 'expo-blur';
import { type PropsWithChildren } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { FROSTED_BACKING_BLUR, FROSTED_BACKING_OPACITY } from '../lib/chrome';
import { useReduceTransparency } from '../lib/reduceTransparency';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';

// The frosted capsule behind every floating control (the DEMO pill, the back
// circle). No screen draws a band at its top or bottom edge any more: the top
// ramp is omitted on iPhone and Android.
//
// This is the only module in the app that imports expo-blur, so the native
// boundary a test has to mock stays at one file.

/** `rgba()` form of a theme hex, so a tint can fade. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * True where the blur may be drawn: iOS with Reduce Transparency off. Android
 * and Reduce Transparency take the plain gradient and opaque capsules instead
 * (the record's platform scope).
 */
export function useBlurAllowed(): boolean {
  const reduceTransparency = useReduceTransparency();
  return Platform.OS === 'ios' && !reduceTransparency;
}

/**
 * The shared backing for every floating control: the theme background at
 * FROSTED_BACKING_OPACITY over a FROSTED_BACKING_BLUR blur, so content can pass
 * under the control and the ink still reads. Opaque where the blur is not
 * allowed.
 */
export function FrostedCapsule({ children, style, borderRadius = radii.pill }: PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  borderRadius?: number;
}>) {
  const theme = useTheme();
  const blurAllowed = useBlurAllowed();
  if (!blurAllowed) {
    return <View style={[{ borderRadius, backgroundColor: theme.card, overflow: 'hidden' }, style]}>{children}</View>;
  }
  return (
    <View style={[{ borderRadius, overflow: 'hidden' }, style]}>
      <BlurView intensity={FROSTED_BACKING_BLUR} tint="default" style={StyleSheet.absoluteFill} />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(theme.background, FROSTED_BACKING_OPACITY) }]}
      />
      {children}
    </View>
  );
}
