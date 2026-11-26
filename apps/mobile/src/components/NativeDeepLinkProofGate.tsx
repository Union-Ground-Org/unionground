import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';

import {
  isNativeDeepLinkProofEnabled,
  measureNativeDeepLinkProbe,
  nativeDeepLinkProofLabel,
  type NativeDeepLinkProofState,
} from '../lib/nativeDeepLinkProof';
import { useTheme } from '../theme/ThemeProvider';

import { typeface } from '../theme/typeface';
const proofEnabled = isNativeDeepLinkProofEnabled();

/** Development-build-only device evidence surface. Never enabled in store builds. */
export function NativeDeepLinkProofGate() {
  const theme = useTheme();
  const [state, setState] = useState<NativeDeepLinkProofState>({ status: 'ready' });

  useEffect(() => {
    if (!proofEnabled) return undefined;

    let mounted = true;
    const measure = (url: string) => {
      try {
        const measurement = measureNativeDeepLinkProbe({
          url,
          parse: Linking.parse,
          now: () => performance.now(),
        });
        if (!measurement || !mounted) return;
        setState({ status: 'passed', measurement, responsive: false });
        requestAnimationFrame(() => {
          if (mounted) setState({ status: 'passed', measurement, responsive: true });
        });
      } catch {
        if (mounted) setState({ status: 'failed' });
      }
    };

    void Linking.getInitialURL().then((url) => {
      if (url) measure(url);
    }).catch(() => {
      if (mounted) setState({ status: 'failed' });
    });
    const subscription = Linking.addEventListener('url', ({ url }) => measure(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  if (!proofEnabled) return null;
  const label = nativeDeepLinkProofLabel(state);
  return (
    <View
      accessibilityLabel={label}
      accessibilityLiveRegion="assertive"
      accessible
      style={[styles.surface, { backgroundColor: theme.primary }]}
      testID="native-deep-link-proof-result"
    >
      <Text style={[styles.text, { color: theme.primaryForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    position: 'absolute',
    top: 48,
    left: 12,
    right: 12,
    zIndex: 10000,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  text: {
    fontSize: 14,
    ...typeface.controlStrong,
    textAlign: 'center',
  },
});
