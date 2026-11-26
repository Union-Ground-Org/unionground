import { Redirect, useNavigationContainerRef } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { Text } from '../src/components/Text';

import { rootNavigatorIsReady, useRootNavigatorReady } from '../src/lib/rootLayoutNavigation';
import { indexRedirectPath } from '../src/lib/routes';
import { BrandMark } from '../src/components/BrandMark';
import { launchMarkSize } from '../src/lib/launchMark';
import { recordLifecycleEvent } from '../src/services/lifecycleDiagnostics';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';

export default function IndexScreen() {
  const { mode } = useApp();
  const theme = useTheme();
  const navigationRef = useNavigationContainerRef();
  const navigatorReady = useRootNavigatorReady();
  // A blank screen after an unknown intent could be this redirect still waiting
  // on boot, or the redirect target rendering nothing. The mode that decided is
  // an enumerated value and carries no worker data.
  useEffect(() => {
    recordLifecycleEvent({ scope: 'boot', step: 'index-redirect', outcome: mode });
  }, [mode]);
  const destination = indexRedirectPath(mode);
  const markSize = launchMarkSize(Platform.OS);
  // While booting, or while a font-scale relaunch has not mounted the navigator:
  // the splash mark at the splash's size and place (180 pt on iOS, 144 dp on
  // Android: src/lib/launchMark.ts, pinned to app.config.ts), so launch does not
  // jump to a bare spinner or a larger mark; the spinner and its line sit below
  // the mark. Redirect queues router.replace, which throws
  // if it runs before the root navigator is ready.
  if (destination === null || !navigatorReady || !rootNavigatorIsReady(navigationRef)) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]} accessible accessibilityRole="progressbar" accessibilityLabel="Opening Union Ground…">
        <ActivityIndicator color={theme.primary} style={[styles.spinner, { marginTop: markSize / 2 + 24 }]} />
        <BrandMark size={markSize} />
        <Text style={[styles.caption, { color: theme.mutedForeground, marginTop: markSize / 2 + 24 + 20 + 12 }]}>Opening Union Ground…</Text>
      </View>
    );
  }
  return <Redirect href={destination} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Below the centred mark without moving it off the splash's centre; the
  // offsets follow the mark's size (set inline).
  spinner: { position: 'absolute', top: '50%' },
  caption: { position: 'absolute', top: '50%' },
});
