import '../src/services/observabilityInit';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { Stack, useNavigationContainerRef, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../src/components/Text';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WindowBottomInsetPublisher } from '../src/lib/windowInsets';

import { NativeDeletionCompletion } from '../src/features/NativeDeletionCompletion';
import { HatSwitcher } from '../src/components/HatSwitcher';
import { StoreDemoExit } from '../src/components/StoreDemoExit';
import { storeDemoExitPlacement } from '../src/lib/storeDemo';
import { NativeDeepLinkProofGate } from '../src/components/NativeDeepLinkProofGate';
import { NavUsageRecorder } from '../src/features/home/NavUsage';
import { RootErrorBoundary } from '../src/components/RootErrorBoundary';
import { NativeQuickActionGate } from '../src/components/NativeQuickActionGate';
import { HomeWidgetGate } from '../src/components/HomeWidgetGate';
import { QuickActionsDrawer } from '../src/components/QuickActionsDrawer';
import { SecureShareIntakeGate } from '../src/components/SecureShareIntakeGate';
import { SwipeDownKeyboardDismiss } from '../src/components/SwipeDownKeyboardDismiss';
import { SessionCheckStatus } from '../src/components/SessionCheckStatus';
import { HeldWorkKeptPanel } from '../src/components/HeldWorkKeptPanel';
import { Body, Button, Heading } from '../src/components/ui';
import { PRIVACY_COVER_CHECKING_LABEL, PRIVACY_COVER_DEMO_LABEL, coverOpensDemo, privacyCoverContent } from '../src/lib/privacyCoverState';
import { rootNavigatorIsReady, useRootNavigatorReady, useRootSessionNavigation } from '../src/lib/rootLayoutNavigation';
import { isPublicAppRoute, routeFromNotification, routerPath, type AppRoute } from '../src/lib/routes';
import { recordLifecycleEvent } from '../src/services/lifecycleDiagnostics';
import { initializeHapticPreference } from '../src/services/hapticPreference';
import { configureNotificationCategories } from '../src/services/notifications';
import { startAuthenticatedScreenProtection } from '../src/services/screenProtection';
import { AppProvider, useApp } from '../src/state/AppProvider';
import { useAppActive } from '../src/state/useAppActive';
import { ThemeProvider, useTheme, useThemePreference } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../src/theme/tokens';

import { typeface } from '../src/theme/typeface';
import { useNativeUi } from '../src/lib/useNativeUi';
function NavigationRoot() {
  const { catalogLabel } = useNativeUi();
  const [hatMenuOpen, setHatMenuOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const navigationRef = useNavigationContainerRef();
  const navigatorReady = useRootNavigatorReady();
  const theme = useTheme();
  const { appearance } = useThemePreference();
  const { locked, privacyCovered, signOutError, mode, session, unlock, signOut, deletionOutcome, liveSampleBackend, retrySessionAuthentication, sessionRetryBusy, storeDemo, sampleHat } = useApp();
  // The store build's demo can always be left: in the covers, in the DEMO
  // pill's menu, on the sign-in screen, or floating where none of those is
  // drawn (session recovery, an unavailable session).
  const demoExit = storeDemoExitPlacement({ storeDemo, locked, privacyCovered, pathname, mode, sampleHat });
  const appActive = useAppActive();
  // The mode as the cover rose, held until it drops (privacyCoverState).
  const modeBeforeCover = useRef(mode);
  if (!privacyCovered) modeBeforeCover.current = mode;
  const coverLabel = coverOpensDemo({ covered: privacyCovered, liveSample: liveSampleBackend, modeBeforeCover: modeBeforeCover.current })
    ? PRIVACY_COVER_DEMO_LABEL
    : PRIVACY_COVER_CHECKING_LABEL;
  const sessionUserID = session?.user.id ?? null;
  const modeRef = useRef(mode);
  const pendingRoute = useRef<AppRoute | null>(null);
  const deferredNotification = useRef<AppRoute | null>(null);
  const navigateRef = useRef<(route: AppRoute | null) => void>(() => undefined);
  const handledNotificationResponses = useRef(new Set<string>());
  modeRef.current = mode;
  useRootSessionNavigation(pendingRoute, navigatorReady);

  useEffect(() => {
    if (!session) return;
    return startAuthenticatedScreenProtection();
  }, [sessionUserID]);

  useEffect(() => { void initializeHapticPreference(); }, []);

  // A seven-node chrome-only dump cannot say whether the root ever mounted, or
  // whether a gate above the Stack was covering the screen at capture time.
  // Both are enumerated or boolean, so neither reveals member data. See
  // BUG-UG-MOBILE-UNKNOWN-SCHEME-ROUTE-DEAD-END-20260905.
  useEffect(() => {
    recordLifecycleEvent({ scope: 'root-layout', step: 'mount' });
    return () => { recordLifecycleEvent({ scope: 'root-layout', step: 'unmount' }); };
  }, []);

  useEffect(() => {
    recordLifecycleEvent({
      scope: 'root-layout',
      step: 'render-gate',
      outcome: mode,
      detail: { locked, privacyCovered, signedIn: sessionUserID !== null },
    });
  }, [locked, mode, privacyCovered, sessionUserID]);

  useEffect(() => {
    const navigate = (route: AppRoute | null) => {
      if (!route) return;
      if (!rootNavigatorIsReady(navigationRef)) {
        deferredNotification.current = route;
        return;
      }
      deferredNotification.current = null;
      if (route.kind === 'authCallback') {
        router.push({ pathname: '/auth/callback', params: { code: route.code } });
        return;
      }
      const path = routerPath(route);
      if (!path) return;
      if (modeRef.current === 'booting' && !isPublicAppRoute(route)) {
        pendingRoute.current = route;
        return;
      }
      if (isPublicAppRoute(route) || modeRef.current === 'authenticated' || modeRef.current === 'preview') {
        router.push(path as never);
        return;
      }
      pendingRoute.current = route;
      router.replace(modeRef.current === 'mfaRequired' ? '/mfa-challenge' : '/sign-in');
    };

    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier;
      if (handledNotificationResponses.current.has(identifier)) return;
      handledNotificationResponses.current.add(identifier);
      navigate(routeFromNotification(response.notification.request.content.data ?? {}));
    };

    void configureNotificationCategories().catch(() => undefined);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleNotificationResponse(response);
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    });
    navigateRef.current = navigate;
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => {
      notificationSubscription.remove();
    };
  }, [navigationRef, router]);

  useEffect(() => {
    if (!navigatorReady || !deferredNotification.current) return;
    navigateRef.current(deferredNotification.current);
  }, [navigatorReady]);

  return (
    <SwipeDownKeyboardDismiss>
      <StatusBar style={appearance === 'dark' ? 'light' : 'dark'} />
      <NavigationBar style={appearance === 'dark' ? 'light' : 'dark'} />
      {/* BUG-UG-ANDROID-HAT-SWITCH-CRASHES-FABRIC-ADDVIEWAT-20261011:
          never flattened. These accessibility props alone decide whether
          Fabric gives this View a native view, so each hat menu open or close
          would move the whole Stack under a new parent. On Android that
          detaches and re-attaches the native tab host, which crashed a SAMPLE
          hat switch with "The specified child already has a parent". */}
      <View collapsable={false} style={{ flex: 1 }} accessibilityElementsHidden={hatMenuOpen} importantForAccessibility={hatMenuOpen ? 'no-hide-descendants' : 'auto'}>
      <QuickActionsDrawer>
        <NativeQuickActionGate />
        <HomeWidgetGate />
        <SecureShareIntakeGate />
        <Stack screenOptions={{
          headerTransparent: true,
          headerTitle: '',
          headerShadowVisible: false,
          headerTintColor: theme.foreground,
          contentStyle: { backgroundColor: theme.background },
          headerBackButtonDisplayMode: 'minimal',
        }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="offline" options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="mfa-challenge" options={{ headerShown: false }} />
        <Stack.Screen name="auth/callback" options={{ title: 'Secure sign in' }} />
        <Stack.Screen name="os-quick-action/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="swipe" options={{ headerShown: false }} />
        {/* Pushed surfaces draw their own PinnedHeader (porcelain backing,
            scroll hairline, 44pt chevron); the native bar would double it. */}
        <Stack.Screen name="issue/[id]" options={{ title: 'Issue details', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="notifications" options={{ title: 'Activity', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="messages" options={{ title: 'Messages', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="pulse" options={{ title: 'Campaign pulse', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="recognition" options={{ title: 'Recognition paths', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="channel/[id]" options={{ title: '', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="conversation/[id]" options={{ title: 'Conversation', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="peer-conversation/[id]" options={{ title: '', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="officer-contact" options={{ title: '', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="feature/[key]" options={{ title: '', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="legal/[page]" options={{ title: '', presentation: 'card', headerShown: false }} />
        <Stack.Screen name="public/unions" options={{ headerShown: false }} />
        <Stack.Screen name="public/unions/[key]" options={{ headerShown: false }} />
      </Stack>
      </QuickActionsDrawer>
      </View>
      <Modal visible={!deletionOutcome && (privacyCovered || locked) && pathname !== '/offline'} animationType="none" presentationStyle="fullScreen" statusBarTranslucent navigationBarTranslucent>
        <View style={[privacyCovered ? styles.privacyCover : styles.locked, { backgroundColor: theme.background }]}>
          {privacyCovered ? (privacyCoverContent(appActive) === 'checking' ? (
            <>
              <SessionCheckStatus label={coverLabel} onRetry={retrySessionAuthentication} busy={sessionRetryBusy} />
              {demoExit === 'cover' ? <StoreDemoExit placement="inline" /> : null}
            </>
          ) : null) : (
            <>
              <Ionicons name="lock-closed" size={42} color={theme.primary} accessibilityElementsHidden />
              <Heading>{catalogLabel("Union Ground is locked")}</Heading>
              <Body muted>Confirm it’s you to pick up where you left off.</Body>
              <Button label="Unlock" onPress={() => { void unlock(); }} />
              <Button label="Sign out" variant="secondary" onPress={() => { void signOut(); }} testID="native-locked-sign-out" />
              {signOutError ? <Body style={{ color: theme.destructive }}>{signOutError}</Body> : null}
              {demoExit === 'cover' ? <StoreDemoExit placement="inline" /> : null}
              {/* A secondary escape, so a text link under the actions, as on the
                  sign-in screen (#7309; critic P7 C6, Nov 6, 2026). */}
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Read public downloads"
                onPress={() => router.push('/offline' as never)}
                style={({ pressed }) => [styles.downloadsLink, { opacity: pressed ? 0.82 : 1 }]}
              >
                <Ionicons name="download-outline" size={18} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
                <Text maxFontSizeMultiplier={2} style={[styles.downloadsLabel, { color: theme.primary }]}>Read public downloads</Text>
              </Pressable>
            </>
          )}
        </View>
      </Modal>
      {/* Keep the router mounted while auth redirects underneath the result.
          Completion takes priority over a stale privacy/lock cover. */}
      <Modal visible={Boolean(deletionOutcome)} animationType="none" presentationStyle="fullScreen" onRequestClose={() => {}}>
        <NativeDeletionCompletion />
      </Modal>
      <NativeDeepLinkProofGate />
      {/* REQ-UG-USAGE-BASED-NAVIGATION-20261001: device-only counts. */}
      <NavUsageRecorder />
      {pathname !== '/offline' && !locked && !privacyCovered ? <HatSwitcher scrollsWithHome={pathname === '/home'} onMenuVisibilityChange={setHatMenuOpen} /> : null}
      {pathname !== '/offline' ? <HeldWorkKeptPanel /> : null}
      {demoExit === 'floating' ? <StoreDemoExit placement="floating" /> : null}
    </SwipeDownKeyboardDismiss>
  );
}

// Expo Router wraps this layout in the exported boundary, so a render error in
// any screen draws a recovery screen instead of a blank or closed app.
export { RootErrorBoundary as ErrorBoundary };

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <WindowBottomInsetPublisher />
      <AppProvider>
        <ThemeProvider>
          <NavigationRoot />
        </ThemeProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  locked: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  privacyCover: { flex: 1 },
  downloadsLink: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: spacing.sm },
  downloadsLabel: { fontSize: 15, lineHeight: 20, ...typeface.control, textDecorationLine: 'underline', flexShrink: 1 },
});
