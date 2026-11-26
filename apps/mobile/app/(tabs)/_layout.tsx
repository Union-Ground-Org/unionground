import { useNativeUi } from "../../src/lib/useNativeUi";
import { Ionicons } from '@expo/vector-icons';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { usePathname } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from '../../src/components/PressableScale';
import { useChannelStore } from '../../src/data/useChannels';
import { requestHomeScrollToTop, useDockSuppressed, useHomeAwayFromTop } from '../../src/lib/chrome';
import { conversationUnreadStore } from '../../src/lib/conversationUnread';
import { inboxUnreadBadgeSettles, nativeInboxUnreadItemCount, settleInboxUnreadBadge } from '../../src/lib/messageInbox';
import { rememberSettledBadge, settledBadgeFor } from '../../src/lib/tabBadgeSettled';
import { useScreenReader } from '../../src/lib/screenReader';
import { haptics } from '../../src/services/haptics';
import { useApp } from '../../src/state/AppProvider';
import { elevation } from '../../src/theme/elevation';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';

import { typeface } from '../../src/theme/typeface';
// System tab hosts on both platforms. iPhone receives UIKit's real tab bar;
// Android receives its platform-native tab treatment. The Union Ground dock
// is exactly Home, Work, Guide, Campaign, Account (the web shell and
// native mobile contract); Messages, Pulse and the other supporting
// destinations open from All tools without displacing these five.
//
// minimizeBehavior: scrolling Home down condenses the system bar to its active
// Home control for sighted iOS users; returning the feed to its top restores
// the full native set. iOS owns this motion and material. VoiceOver keeps the
// full five-tab bar: minimize is iOS Home only, and it stands down while a
// screen reader is running so destinations never leave the accessibility tree.
// UX-UG-NATIVE-ANDROID-TAB-BAR-OFF-PALETTE-AND-UNLABELED-TABS-20261109:
// Android labels all four tabs, as iPhone does, and marks the selected one
// with the palette's light green pill (dark green icon and label on it, a
// pair the theme contrast test holds to AA) instead of the platform's stock
// lavender, and a press ripples in the dark green focus color, which reads on
// both the pill and the canvas. The tab host paints the canvas behind the bar,
// so the band the hidden Android bar leaves while Home is scrolled matches
// the screen.
export default function TabLayout() {
  const { t } = useNativeUi();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const hidden = useDockSuppressed();
  const homeAwayFromTop = useHomeAwayFromTop();
  const screenReader = useScreenReader();
  const androidHomeOnly = Platform.OS === 'android' && pathname === '/home' && homeAwayFromTop && !hidden;
  // UIKit expands a minimized bar only on an upward scroll it sees, so Home
  // back at its top kept the lone Home control until it was tapped (#9607).
  // When Home returns to its top the behaviour is 'never' for a moment, which
  // brings the full bar back, then 'onScrollDown' again, so the next scroll
  // down still condenses it from its first swipe.
  const [seenAwayFromTop, setSeenAwayFromTop] = useState(homeAwayFromTop);
  const [restoringState, setRestoringTabBar] = useState(false);
  const awayChanged = seenAwayFromTop !== homeAwayFromTop;
  const restoringTabBar = awayChanged ? !homeAwayFromTop : restoringState;
  if (awayChanged) {
    setSeenAwayFromTop(homeAwayFromTop);
    setRestoringTabBar(restoringTabBar);
  }
  useEffect(() => {
    if (!restoringTabBar) return undefined;
    const timer = setTimeout(() => setRestoringTabBar(false), TAB_BAR_RESTORE_MS);
    return () => clearTimeout(timer);
  }, [restoringTabBar]);
  const { dashboard, mode, previewHat, session } = useApp();
  const store = useChannelStore();
  // BUG-UG-MOBILE-MESSAGES-TAB-BADGE-COUNTS-DIRECT-THREADS-ONLY-20260914:
  // the last badge count a completed channel load produced lives in
  // src/lib/tabBadgeSettled, keyed by the signed-in user so a former
  // account's count never survives into the next session and so a remount of
  // this host (deep link + back) keeps the settled count instead of the
  // direct-only sum. Read by settleInboxUnreadBadge while the store is
  // idle/loading.
  useSyncExternalStore(store.subscribe, store.getVersion);
  // The conversation half subscribes to its own versioned store exactly like
  // the channel half above, so a new committee reply re-renders the badge
  // without waiting for a manual dashboard refresh. Messages is not a dock
  // root, so the settled unread count rides on Home, whose stat band and
  // takeover cards lead to the inbox.
  useSyncExternalStore(conversationUnreadStore.subscribe, conversationUnreadStore.getVersion);
  const channels = store.channels().filter((channel) => (
    mode !== 'preview' || previewHat !== 'member' || !channel.locked
  ));
  // The module-global store is consulted only in authenticated mode: after
  // sign-out or on PREVIEW entry AppProvider resets it, but preferring the
  // dashboard here too guarantees the badge can never count a former live
  // account's conversations against the preview inbox.
  const conversations = (mode === 'authenticated'
    ? conversationUnreadStore.conversations()
    : null) ?? dashboard?.conversations ?? [];
  const authenticated = mode === 'authenticated';
  const settledKey = authenticated ? session?.user.id ?? null : null;
  const computedUnread = nativeInboxUnreadItemCount(conversations, channels);
  const storeStatus = store.status();
  if (authenticated && inboxUnreadBadgeSettles(storeStatus)) rememberSettledBadge(settledKey, computedUnread);
  // null = no settled count yet in this session: the badge stays hidden
  // rather than presenting the direct-only sum.
  const unreadMessages = settleInboxUnreadBadge({
    authenticated,
    status: storeStatus,
    channelCount: store.channels().length,
    computed: computedUnread,
    lastSettled: settledBadgeFor(settledKey),
  });
  return (
    <View style={[styles.host, { backgroundColor: theme.background }]}>
      <NativeTabs
        backgroundColor={theme.background}
        disableTransparentOnScrollEdge
        hidden={hidden || androidHomeOnly}
        iconColor={{ default: theme.mutedForeground, selected: theme.primary }}
        indicatorColor={theme.secondary}
        labelVisibilityMode="labeled"
        labelStyle={{
          default: { color: theme.mutedForeground, fontSize: 11, ...typeface.control },
          selected: { color: theme.primary, fontSize: 11, ...typeface.controlStrong },
        }}
        minimizeBehavior={screenReader || pathname !== '/home' || restoringTabBar ? 'never' : 'onScrollDown'}
        badgeBackgroundColor={theme.destructive}
        rippleColor={theme.ring}
        // No separator line along the tab bar's top edge: iOS draws its
        // default hairline when this is left unset
        // (UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118).
        shadowColor="transparent"
        tintColor={theme.primary}
      >
        {/* Home retains its native full-height scene/inset contract. Other iOS
            roots keep explicit Screen padding without UIKit adding it again. */}
        <NativeTabs.Trigger name="home" accessibilityLabel={t("Home, 1 of 5")} testID="native-tab-home" disableAutomaticContentInsets={Platform.OS === 'android'}>
          <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
          <NativeTabs.Trigger.Label>{t("Home")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Badge hidden={unreadMessages === null || unreadMessages === 0}>
            {unreadMessages !== null && unreadMessages > 99 ? '99+' : unreadMessages !== null && unreadMessages > 0 ? String(unreadMessages) : undefined}
          </NativeTabs.Trigger.Badge>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="work" accessibilityLabel={t("Work, 2 of 5")} disableAutomaticContentInsets={Platform.OS === 'ios'}>
          <NativeTabs.Trigger.Icon sf={{ default: 'briefcase', selected: 'briefcase.fill' }} md="work" />
          <NativeTabs.Trigger.Label>{t("Work")}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="compass" accessibilityLabel={t("Guide, 3 of 5")} disableAutomaticContentInsets={Platform.OS === 'ios'}>
          <NativeTabs.Trigger.Icon sf={{ default: 'location', selected: 'location.fill' }} md="explore" />
          <NativeTabs.Trigger.Label>{t("Guide")}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="campaign" accessibilityLabel={t("Campaign, 4 of 5")} disableAutomaticContentInsets={Platform.OS === 'ios'}>
          <NativeTabs.Trigger.Icon sf={{ default: 'flag', selected: 'flag.fill' }} md="flag" />
          <NativeTabs.Trigger.Label>{t("Campaign")}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="account" accessibilityLabel={t("Account, 5 of 5")} disableAutomaticContentInsets={Platform.OS === 'ios'}>
          <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} md="account_circle" />
          <NativeTabs.Trigger.Label>{t("Account")}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
      {androidHomeOnly ? (
        <View pointerEvents="box-none" style={[styles.androidHomeHost, { bottom: insets.bottom + spacing.xl }]}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t("Home, navigation minimized")}
            onPress={() => { void haptics.select(); requestHomeScrollToTop(); }}
            resting={elevation.level0}
            style={[styles.androidHome, { backgroundColor: theme.primary, borderRadius: radii.pill }]}
          >
            <Ionicons name="home" size={24} color={theme.primaryForeground} />
          </PressableScale>
        </View>
      ) : null}
    </View>
  );
}

// Long enough for UIKit to take the 'never' behaviour and expand the bar.
const TAB_BAR_RESTORE_MS = 300;

const styles = StyleSheet.create({
  host: { flex: 1 },
  androidHomeHost: {
    position: 'absolute',
    left: 0,
    width: '20%',
    alignItems: 'center',
  },
  androidHome: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    minHeight: minimumTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
