import { NavigationBar } from 'expo-navigation-bar';
import { router, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useId, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { SafeAreaView } from 'react-native-safe-area-context';

import { queueAccessibilityAnnouncement, useAccessibilityAnnouncementQueue } from '../lib/announce';
import { openSupportEmailWithFallback, supportEmail } from '../lib/supportContact';
import { reportNativeRenderError } from '../services/observability';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, resolveTheme, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
// Union Ground publishes no support mailbox yet (src/lib/publicContact.js on
// the web); the support line appears only once an owner-approved one exists.
export const SUPPORT_ADDRESS: string | null = null;
export const RECOVERY_ANNOUNCEMENT = 'Something went wrong. Try again, or go to Home.';

// BUG-UG-NATIVE-NO-ERROR-BOUNDARY-20261018: exported from
// app/_layout.tsx as ErrorBoundary, so Expo Router draws this in place of the
// root layout when any screen throws while rendering. It sits outside
// SafeAreaProvider, AppProvider and ThemeProvider (they are inside the layout
// that crashed), so it must not use the themed ui kit. It draws Union Ground,
// the only theme, in its light form whatever the device's appearance, like
// ThemeProvider (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105).
export function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RecoveryScreen error={error} retry={retry} />;
}

// The screen itself, drawn and audited without storage.
export function RecoveryScreen({ error, retry }: ErrorBoundaryProps) {
  const theme = resolveTheme(null);
  const systemBarStyle = theme.appearance === 'dark' ? 'light' : 'dark';
  const announcementAttempt = useRef(0);
  const [supportFailure, setSupportFailure] = useState('');
  const announceSupport = useAccessibilityAnnouncementQueue(useId());

  async function emailSupport() {
    setSupportFailure('');
    const language = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] === 'es' ? 'es' : 'en';
    const result = await openSupportEmailWithFallback((url) => Linking.openURL(url), language);
    if (!result.opened) {
      setSupportFailure(result.message);
      announceSupport(result.message);
    }
  }

  useEffect(() => {
    reportNativeRenderError(error);
    // The focused screen is gone and accessibilityLiveRegion is Android-only,
    // so tell VoiceOver and TalkBack what replaced it.
    return queueAccessibilityAnnouncement(
      RECOVERY_ANNOUNCEMENT,
      `root-error-boundary:${++announcementAttempt.current}`,
    );
  }, [error]);

  // The root Stack drops its navigation state when the crashed layout
  // unmounts, so retry remounts it at its initial index route rather than the
  // screen that threw. Replacing to the index route afterwards keeps Home the
  // destination either way; index redirects to Home or sign-in for the session.
  const goHome = () => retry().then(() => { router.replace('/'); });

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={systemBarStyle} />
      <NavigationBar style={systemBarStyle} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.foreground }]}>Something went wrong</Text>
          <Text style={[styles.body, { color: theme.mutedForeground }]}>
            Union Ground hit a problem showing this screen. Anything you saved is still there. Try again, or go back to Home.
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              onPress={() => { void retry(); }}
              style={({ pressed }) => [styles.button, elevation.level1, { backgroundColor: theme.primary }, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.buttonLabel, { color: theme.primaryForeground }]}>Try again</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to Home"
              onPress={() => { void goHome(); }}
              style={({ pressed }) => [styles.button, elevation.level1, { backgroundColor: theme.secondary, borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth }, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.buttonLabel, { color: theme.secondaryForeground }]}>Go to Home</Text>
            </Pressable>
          </View>
          {SUPPORT_ADDRESS ? <View style={styles.support}>
            <Text style={[styles.body, { color: theme.mutedForeground }]}>If this keeps happening, email support.</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Email ${SUPPORT_ADDRESS}`}
              onPress={() => { void emailSupport(); }}
              style={({ pressed }) => [styles.link, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.body, { color: theme.primary, textDecorationLine: 'underline' }]}>{SUPPORT_ADDRESS}</Text>
            </Pressable>
            {supportFailure ? <Text selectable style={[styles.body, { color: theme.foreground }]}>{supportFailure}</Text> : null}
          </View> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// Type, radius, padding and press response mirror the shared ui kit (pageTitle,
// body, button, buttonText and the 0.82 pressed dim) so the recovery screen
// reads as the same app without importing the kit's providers.
const styles = StyleSheet.create({
  root: { flex: 1 },
  // flexGrow keeps short content centred and lets large text scroll instead
  // of pushing the actions off screen.
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  // A readable measure in landscape and on wide screens; full width on phones.
  column: { width: '100%', maxWidth: 480, alignSelf: 'center', gap: spacing.lg },
  heading: { fontSize: 22, lineHeight: 28, ...typeface.heading, letterSpacing: -0.25 },
  body: { fontSize: 16, lineHeight: 23 },
  actions: { gap: spacing.md },
  button: { minHeight: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  buttonLabel: { fontSize: 16, lineHeight: 20, ...typeface.controlStrong, textAlign: 'center' },
  pressed: { opacity: 0.82 },
  support: { gap: spacing.xs },
  link: { minHeight: minimumTouchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
});
