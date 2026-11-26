import { useNativeUi } from "../../src/lib/useNativeUi";
import { BUSINESS_SAVED_STALE } from '../../src/lib/businessWriteContinuation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBusinessOperation } from '../../src/lib/useBusinessWriter';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '../../src/components/Text';

import { Body, Button, Card, Heading, Notice, Screen } from '../../src/components/ui';
import { AccountUnavailable } from '../../src/components/AccountUnavailable';
import { LanguageSettingsCard } from '../../src/components/LanguageSettingsCard';
import { CustomNavLinksCard } from '../../src/components/CustomNavLinksCard';
import { DisabledStateBoundary } from '../../src/components/DisabledStateBoundary';
import { MessageWorkflowPicker } from '../../src/components/MessageWorkflowPicker';
import { SupportLink } from '../../src/components/SupportLink';
import { NativePlatformAnnouncements } from '../../src/features/NativePlatformAnnouncements';
import { NativeLearningPeriodCard } from '../../src/features/NativeLearningPeriod';
import { DataSettingsCard } from '../../src/features/DataSettingsCard';
import { NativeAccountDeletion } from '../../src/features/NativeAccountDeletion';
import { PasswordChangeCard } from '../../src/features/PasswordChangeCard';
import { ProfilePhoneCard } from '../../src/features/ProfilePhoneCard';
import { NativeShortcutsGuideCard } from '../../src/features/NativeShortcutsGuideCard';
import { PendingPasswordResetCard } from '../../src/features/PendingPasswordResetCard';
import { NativeSessionsCard } from '../../src/features/NativeSessionsCard';
import { NativeSignOut } from '../../src/features/NativeSignOut';
import { LearningContentManager } from '../../src/features/learning/LearningContentManager';
import { useLearningAdministration, useLearningCopy } from '../../src/features/learning/useLearningContent';
import { NotificationPreferencesCard } from '../../src/features/NotificationPreferencesCard';
import { HapticPreferencesCard } from '../../src/features/HapticPreferencesCard';
import { HomeWidgetSharingCard } from '../../src/features/HomeWidgetSharingCard';
import { PulseScorePrivacyCard } from '../../src/features/PulseScorePrivacyCard';
import { requestHatSwitcher } from '../../src/lib/hatSwitcher';
import { messageWorkflowCopy, messageWorkflowDefault, type MessageWorkflow } from '../../src/lib/messageWorkflow';
import { notificationCopyFor } from '../../src/lib/notificationCopy';
import { ServiceIdentityCard } from '../../src/components/ServiceIdentityCard';
import { useNativeTabContentInset } from '../../src/lib/chrome';
import {
  openPrivacyPolicyWithFallback,
  privacyPolicyLinkHint,
  privacyPolicyLinkLabel,
  privacyPolicyUrl,
} from '../../src/lib/privacyPolicy';
import {
  disableNativePushNotifications,
  enableNativePushNotifications,
  readLocalNotificationState,
  readNativePushState,
  sendTestNotification,
  setLocalNotificationsEnabled,
  type NativePushState,
} from '../../src/services/notifications';
import { captureSessionWriter, loadMobileSmsPreference, normalizeMobileSmsPhone, setMobileSmsConsent, type MobileSmsPreference } from '../../src/services/supabase';
import { readMessageWorkflowPreference, saveMessageWorkflowPreference } from '../../src/services/messageWorkflowPreference';
import { setProductAnalyticsEnabled, useProductAnalyticsEnabled } from '../../src/services/analyticsPreference';
import { supportAccountBody } from '../../src/lib/supportContact';
import { haptics } from '../../src/services/haptics';
import { NavUsageResetCard } from '../../src/features/home/NavUsage';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { PulseOpeningPreferenceCard } from '../../src/features/PulseOpeningPreference';
import { HomeGuidePreference } from '../../src/features/HomeGuidePreference';
import { defaultThemeKey, minimumTouchTarget, radii, resolveTheme, spacing, themeOptions } from '../../src/theme/tokens';
import { NativeFeatureGuide } from '../../src/features/guideLayers/GuideLayers';

import { typeface } from '../../src/theme/typeface';
// Account is a dock root, so it offers no Back control.
export default function AccountScreen() {
  const { session } = useApp();
  const { t } = useNativeUi();
  return <PinnedHeaderScreen screenName={t("Account")} onBack={null}><AccountScreenContent key={session?.user.id ?? 'signed-out'} /></PinnedHeaderScreen>;
}

function AccountScreenContent() {
  const { t, language, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const router = useRouter();
  const { dashboard, memberLanguage, mode, session, previewHat, sampleHat, biometricAvailable, refreshBiometricAvailability, biometricLockEnabled, setBiometricLock, saveProfile, captureAccountSessionGuard, refresh, refreshing, storeDemo, exitStoreDemo, storeDemoExitBusy } = useApp();
  // The floating pill is the quick path; this row is the stable one, so the
  // demo hat is always reachable from a settings list. It mirrors the pill's own
  // gate: a live account has no preview or sample hat and gets no row.
  const demoHat = mode === 'preview' ? previewHat : sampleHat;
  const bottomInset = useNativeTabContentInset();
  const [nativePush, setNativePush] = useState<NativePushState>({ enabled: false, registered: false, provider: null });
  const [busy, setBusy] = useState(false);
  // In-app status text instead of Alert.alert: OS alert chrome ignores the
  // forced-light theme and renders dark on OS-dark devices.
  const [settingsNotice, setSettingsNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const productAnalytics = useProductAnalyticsEnabled();
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [fullName, setFullName] = useState('');
  const [smsPreference, setSmsPreference] = useState<MobileSmsPreference | null>(null);
  const [smsPhone, setSmsPhone] = useState('');
  const normalizedSmsPhone = normalizeMobileSmsPhone(smsPhone);
  const [smsOperation, setSmsOperation] = useState<string | null>(null);
  const smsBusy = smsOperation !== null;
  const [runOperation] = useBusinessOperation<string | null>(setSmsOperation, null);
  const [smsNeedsRefresh, setSmsNeedsRefresh] = useState(true);
  const [smsRefreshRequested, setSmsRefreshRequested] = useState(true);
  const smsReadGeneration = useRef(0);
  const smsMounted = useRef(true);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [messageWorkflow, setMessageWorkflow] = useState<MessageWorkflow>(messageWorkflowDefault);
  const [privacyLinkBusy, setPrivacyLinkBusy] = useState(false);
  const [privacyLinkError, setPrivacyLinkError] = useState<string | null>(null);
  // REQ-UG-QUOTES-MINI-LESSONS-20260928: one policy-only read decides
  // whether this account manages learning content; nothing else is fetched.
  const learningAdministration = useLearningAdministration();
  const learningCopy = useLearningCopy();
  const [managingLearning, setManagingLearning] = useState(false);
  const notificationLanguage = dashboard?.member.language ?? memberLanguage;
  const notificationCopy = notificationLanguage ? notificationCopyFor(notificationLanguage) : null;
  const workflowLanguage = notificationLanguage ?? 'en';
  const workflowCopy = messageWorkflowCopy[workflowLanguage];
  const notificationAction = !notificationCopy
    ? ''
    : busy
    ? notificationCopy.working
    : mode === 'preview'
      ? (nativePush.enabled ? notificationCopy.disable : notificationCopy.enable)
      : nativePush.registered
        ? notificationCopy.disable
        : nativePush.enabled
          ? notificationCopy.reconnect
          : notificationCopy.enable;
  const notificationDisabled = busy;
  const notificationsOn = mode === 'preview' ? nativePush.enabled : nativePush.registered;

  // The biometric row tracks the device, not the restored session: re-read
  // enrollment every time Account mounts
  // (BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918).
  useEffect(() => {
    void refreshBiometricAvailability().catch(() => undefined);
  }, [refreshBiometricAvailability]);

  useEffect(() => {
    let active = true;
    setMessageWorkflow(messageWorkflowDefault);
    void readMessageWorkflowPreference(session?.user.id)
      .then((value) => { if (active) setMessageWorkflow(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [session?.user.id]);

  useEffect(() => {
    if (mode !== 'authenticated' && mode !== 'preview') {
      setNativePush({ enabled: false, registered: false, provider: null });
      return;
    }
    let active = true;
    // Preview has no backend registration; it tracks the OS permission and
    // the local preference so the flow is still fully testable on device.
    const load = mode === 'preview' ? readLocalNotificationState() : readNativePushState();
    void load
      .then((state) => { if (active) setNativePush(state); })
      .catch(() => { if (active) setNativePush({ enabled: false, registered: false, provider: null }); });
    return () => { active = false; };
  }, [mode]);

  const loadSmsStatus = useCallback(async (writer: ReturnType<typeof captureSessionWriter>) => {
    const generation = ++smsReadGeneration.current;
    const current = () => smsMounted.current && generation === smsReadGeneration.current;
    setSmsError(null);
    try {
      if (await writer.check() !== 'current') throw new Error('unavailable');
      if (!current()) return;
      const next = await loadMobileSmsPreference();
      const proof = await writer.check();
      if (!current()) return;
      if (proof !== 'current') throw new Error('unavailable');
      setSmsPreference(next);
      setSmsNeedsRefresh(false);
    } catch {
      if (current()) { setSmsNeedsRefresh(true); setSmsError(t('SMS status could not be refreshed.')); }
    }
  }, [t]);
  async function refreshSms() {
    await runOperation('refresh', async () => loadSmsStatus(captureSessionWriter(session)));
  }
  useEffect(() => {
    if (mode === 'authenticated') setSmsRefreshRequested(true);
    else setSmsPreference(null);
  }, [mode, session?.access_token]);
  useEffect(() => {
    if (mode !== 'authenticated' || !smsRefreshRequested || smsBusy) return;
    setSmsRefreshRequested(false);
    void refreshSms();
  }, [mode, smsBusy, smsRefreshRequested]);
  useEffect(() => { smsMounted.current = true; return () => { smsMounted.current = false; smsReadGeneration.current += 1; }; }, []);

  // A lost or changed authorization closes the manager rather than keeping it
  // open on an answer that belongs to an earlier scope.
  useEffect(() => {
    if (!learningAdministration.allowed) setManagingLearning(false);
  }, [learningAdministration.allowed]);

  useEffect(() => {
    if (!dashboard || editingProfile) return;
    setFirstName(dashboard.member.firstName);
    setFullName(dashboard.member.fullName);
  }, [dashboard, editingProfile]);

  async function toggleProductAnalytics(enabled: boolean) {
    setSettingsNotice(null);
    if (!(await setProductAnalyticsEnabled(enabled))) {
      setSettingsNotice({ tone: 'error', text: enabled ? t('Product analytics is on until the app closes, but this phone could not save the choice.') : t('Product analytics is off until the app closes, but this phone could not save the choice.') });
    }
  }

  async function toggleBiometrics(enabled: boolean) {
    setSettingsNotice(null);
    const updated = await setBiometricLock(enabled);
    if (updated) return;
    void haptics.warning();
    // SEC-UG-MOBILE-BIOMETRIC-LOCK-DISABLE-REAUTH-20260920: a refused
    // weakening used to return false in silence, so the worker saw the switch
    // snap back with no reason. Turning the lock off now needs the same
    // confirmation as turning it on, and says so when it is not given.
    setSettingsNotice(enabled
      ? { tone: 'error', text: t('Biometrics unavailable, or the confirmation was cancelled. Set up Face ID, Touch ID, or device biometrics in system settings first.') }
      : { tone: 'error', text: t('Biometric re-lock is still on. Confirm with Face ID, Touch ID, or your device passcode to turn it off.') });
  }

  async function enableNotifications() {
    if (!notificationCopy) return;
    setBusy(true);
    setSettingsNotice(null);
    try {
      const state = mode === 'preview' ? await setLocalNotificationsEnabled(true) : await enableNativePushNotifications();
      setNativePush(state);
      setSettingsNotice({ tone: 'info', text: `${notificationCopy.enabledTitle}. ${notificationCopy.enabledBody}` });
    } catch {
      setSettingsNotice({ tone: 'error', text: `${notificationCopy.unavailableTitle}. ${notificationCopy.unavailableBody}` });
    } finally {
      setBusy(false);
    }
  }

  async function disableNotifications() {
    if (!notificationCopy) return;
    setBusy(true);
    setSettingsNotice(null);
    try {
      setNativePush(mode === 'preview' ? await setLocalNotificationsEnabled(false) : await disableNativePushNotifications());
      setSettingsNotice({ tone: 'info', text: `${notificationCopy.disabledTitle}. ${notificationCopy.disabledBody}` });
    } catch {
      setSettingsNotice({ tone: 'error', text: `${notificationCopy.disableFailedTitle}. ${notificationCopy.disableFailedBody}` });
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    setBusy(true);
    setSettingsNotice(null);
    try {
      const sent = await sendTestNotification();
      setSettingsNotice(sent
        ? { tone: 'info', text: t('Test notification scheduled. It arrives in about two seconds — background the app to see the banner on the lock screen.') }
        : { tone: 'error', text: t('Notification permission was not granted. Enable notifications for Union Ground in system settings first.') });
    } catch {
      setSettingsNotice({ tone: 'error', text: t('The test notification could not be scheduled on this device.') });
    } finally {
      setBusy(false);
    }
  }

  // A11Y-UG-MOBILE-VOICEOVER-ACCOUNT-PRIVACY-POLICY-LINK-20260913 (Q19
  // defect 11). The approved public policy URL opens in one step from here, so
  // the failure has to surface on this screen: openPrivacyPolicyWithFallback
  // never throws, and the message renders as in-app text rather than
  // Alert.alert, whose OS chrome ignores the forced-light theme.
  async function openApprovedPrivacyPolicy() {
    setPrivacyLinkBusy(true);
    setPrivacyLinkError(null);
    try {
      const result = await openPrivacyPolicyWithFallback((url) => Linking.openURL(url));
      setPrivacyLinkError(result.opened ? null : result.message);
    } finally {
      setPrivacyLinkBusy(false);
    }
  }

  async function submitProfile() {
    if (profileBusy || languageBusy) return;
    setProfileBusy(true);
    setProfileError(null);
    const current = captureAccountSessionGuard(session?.user.id ?? null);
    try {
      // An accepted language whose refresh was unavailable
      // lives in memberLanguage while the dashboard keeps the older one, so a
      // name save sends the accepted language (as useNativeUi shows it).
      const proof = await saveProfile({ firstName, fullName, language: memberLanguage ?? dashboard?.member.language ?? 'en' });
      if (!current()) return;
      if (proof !== 'current') { setProfileError(BUSINESS_SAVED_STALE); return; }
      setEditingProfile(false);
    } catch {
      if (current()) setProfileError(t("Your profile changes were not confirmed. Check the names and try again."));
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateSmsConsent(consented: boolean) {
    const writer = captureSessionWriter(session);
    await runOperation('save', async () => {
    setSmsError(null);
    setSettingsNotice(null);
    try {
      const phone = consented ? normalizedSmsPhone : null;
      const saved = await setMobileSmsConsent(phone, consented, writer);
      setSmsPhone('');
      setSmsNeedsRefresh(true);
      const proof = await writer.check();
      if (proof === 'changed') return;
      if (proof === 'unavailable') {
        setSettingsNotice({ tone: 'info', text: `${t('SMS consent was changed.')} ${t('Refresh your account when your connection returns.')}` });
        return;
      }
      setSmsPreference(saved);
      setSmsNeedsRefresh(false);
    } catch {
      if (await writer.check() === 'changed') return;
      // The writer's message is English-only; the person
      // sees the translated line in their own language.
      setSmsError(t("SMS consent was not changed."));
    }
    });
  }

  async function chooseMessageWorkflow(value: MessageWorkflow) {
    setMessageWorkflow(value);
    setSettingsNotice(null);
    try {
      await saveMessageWorkflowPreference(value, session?.user.id);
      setSettingsNotice({ tone: 'info', text: workflowCopy.saved });
    } catch {
      setSettingsNotice({ tone: 'error', text: workflowLanguage === 'es' ? 'No se pudo guardar el flujo de mensajes en este dispositivo.' : 'The messaging workflow could not be saved on this device.' });
    }
  }

  // Organizing rights is a worker route, so the editorial entrance for
  // authorized staff, administrators and platform owners also lives here. The
  // manager opens as an Account level under the same hat and identity; the
  // server still decides every scope and write.
  if (managingLearning && learningAdministration.allowed) {
    return <LearningContentManager origin="account" bottomInset={bottomInset} onClose={() => setManagingLearning(false)} />;
  }

  return (
    <Screen bottomInset={bottomInset}>
      <NativeFeatureGuide feature="settings" />
      <Heading>{t("Account")}</Heading>
      {dashboard ? (
        <Card style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: theme.primary }]}><Text style={[styles.initials, { color: theme.primaryForeground }]}>{dashboard.member.initials}</Text></View>
          <View style={styles.flex}><Heading level={3}>{dashboard.member.fullName}</Heading><Body muted>{dashboard.member.roleLine}</Body>{dashboard.member.memberSince ? <Body muted>{t('Worker since {year}', { year: dashboard.member.memberSince })}</Body> : null}</View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editingProfile ? t("Cancel profile editing") : t("Edit profile")}
            onPress={() => { setProfileError(null); setEditingProfile((value) => !value); }}
            style={({ pressed }) => [styles.iconButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Ionicons name={editingProfile ? 'close' : 'create-outline'} size={21} color={theme.secondaryForeground} />
          </Pressable>
        </Card>
      ) : (
        <AccountUnavailable refreshing={refreshing} onRetry={() => { void refresh('user-refresh'); }} />
      )}
      <LanguageSettingsCard key={`language:${session?.user.id ?? mode}`} disabled={profileBusy} onBusyChange={setLanguageBusy} />
      {/*: the member's own phone number and who sees it, saved to the profile row the website edits. */}
      <ProfilePhoneCard key={`phone:${session?.user.id ?? mode}`} />
      <NativeSignOut key={`sign-out:${session?.user.id ?? mode}`} />
      <ThemeSection />
      <DataSettingsCard />
      <NativeLearningPeriodCard />
      <NativePlatformAnnouncements settings />
      <HapticPreferencesCard />
      <HomeWidgetSharingCard />
      <PulseScorePrivacyCard />
      {learningAdministration.allowed ? (
        <>
          <Heading level={2}>{learningCopy.accountHeading}</Heading>
          <SettingRow icon="library-outline" title={learningCopy.accountEntryTitle} body={learningCopy.accountEntryBody}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={learningCopy.accountEntryLabel}
              onPress={() => setManagingLearning(true)}
              style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
            >
              <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{learningCopy.accountEntryAction}</Text>
            </Pressable>
          </SettingRow>
        </>
      ) : null}
      {editingProfile && dashboard ? (
        <Card>
          <Heading level={2}>{t("Profile")}</Heading>
          <Body muted>{t('These names are saved to your worker profile. Your role, campaign and campaign membership history can’t be changed here.')}</Body>
          <Field label={t("Preferred first name")} value={firstName} onChangeText={setFirstName} maxLength={80} />
          <Field label={t("Full name")} value={fullName} onChangeText={setFullName} maxLength={160} />
          <Button label={profileBusy ? t("Saving…") : t("Save profile")} disabled={profileBusy || languageBusy} onPress={() => { void submitProfile(); }} />
          {profileError ? <View accessibilityLiveRegion="polite"><Body style={profileError === BUSINESS_SAVED_STALE ? undefined : { color: theme.destructive }}>{profileError === BUSINESS_SAVED_STALE ? t(profileError) : profileError}</Body></View> : null}
        </Card>
      ) : null}
      <Heading level={2}>{workflowCopy.settingsTitle}</Heading>
      <Card>
        <Body muted>{workflowCopy.settingsBody}</Body>
        <MessageWorkflowPicker language={workflowLanguage} value={messageWorkflow} onChange={(value) => { void chooseMessageWorkflow(value); }} compact />
      </Card>
      {/* REQ-UG-USAGE-BASED-NAVIGATION-20261001: worker-level reset. */}
      <NavUsageResetCard />
      <Heading level={2}>{t("Privacy and security")}</Heading>
      {/* BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021 */}
      {mode === 'authenticated' ? <PendingPasswordResetCard /> : null}
      {/* REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the server's own
          session list and the confirmed account-wide revoke. The card renders
          nothing for a preview session, which cannot read it. */}
      <NativeSessionsCard />
      {/* Keep the state owner mounted through USER_UPDATED's temporary booting
          mode. The card gates its visible controls; a different account resets it. */}
      <PasswordChangeCard key={session?.user.id ?? 'signed-out'} />
      <SettingRow icon="finger-print-outline" title={t("Biometric re-lock")} body={biometricAvailable ? t("Lock after the app has been backgrounded.") : t("Unavailable: this phone has no Face ID, Touch ID or fingerprint set up.")}>
        {/* BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918: a
            disabled RN Switch reports enabled=true on the UISwitch VoiceOver
            focuses. While biometrics are unavailable the boundary owns the
            switch role, the on/off state and the disabled state, and hides
            the native Switch from the tree; with biometrics enrolled the
            Switch renders bare and stays an operable switch. */}
        <DisabledStateBoundary
          disabled={!biometricAvailable}
          accessibilityRole="switch"
          accessibilityLabel={t("Biometric re-lock, Unavailable: this phone has no Face ID, Touch ID or fingerprint set up.")}
          checked={biometricLockEnabled}
        >
          <Switch
            accessibilityLabel={biometricAvailable ? t("Biometric re-lock") : t("Biometric re-lock, Unavailable: this phone has no Face ID, Touch ID or fingerprint set up.")}
            style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }}
            accessibilityState={{ disabled: !biometricAvailable }}
            disabled={!biometricAvailable}
            value={biometricLockEnabled}
            onValueChange={(value) => { void toggleBiometrics(value); }}
            trackColor={{ false: theme.muted, true: theme.primary }}
            thumbColor={biometricLockEnabled ? theme.primaryForeground : theme.mutedForeground}
          />
        </DisabledStateBoundary>
      </SettingRow>
      {mode === 'authenticated' ? (
        <SettingRow icon="stats-chart-outline" title={t("Product analytics")} body={t("Counts the feature screens you open toward your organization's usage figures. Turning it off stops that on this phone at once, and the choice stays saved here.")}>
          <Switch
            accessibilityLabel={t("Product analytics")}
            style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }}
            value={productAnalytics === true}
            onValueChange={(value) => { void toggleProductAnalytics(value); }}
            trackColor={{ false: theme.muted, true: theme.primary }}
            thumbColor={productAnalytics ? theme.primaryForeground : theme.mutedForeground}
          />
        </SettingRow>
      ) : null}
      {notificationCopy ? (
        <SettingRow
          icon="notifications-outline"
          title={notificationCopy.title}
          body={nativePush.registered
            ? (nativePush.provider === 'apns' ? notificationCopy.registeredApple : notificationCopy.registeredAndroid)
            : nativePush.enabled
              ? notificationCopy.reconnectBody
              : notificationCopy.privateBody}
        >
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel={notificationCopy.title}
            accessibilityState={{ checked: notificationsOn, busy, disabled: notificationDisabled }}
            disabled={notificationDisabled}
            onPress={() => { void (nativePush.registered ? disableNotifications() : enableNotifications()); }}
            style={({ pressed }) => [styles.smallButton, {
              backgroundColor: notificationDisabled ? theme.muted : theme.secondary,
              opacity: pressed ? 0.82 : 1,
            }]}
          >
            <Text style={[styles.smallButtonText, {
              color: notificationDisabled ? theme.mutedForeground : theme.secondaryForeground,
            }]}>
              {notificationAction}
            </Text>
          </Pressable>
        </SettingRow>
      ) : null}
      <NotificationPreferencesCard />
      {mode === 'authenticated' ? (
        <SettingRow
          icon="chatbubble-ellipses-outline"
          title={t("SMS updates")}
          body={smsNeedsRefresh ? t('SMS status could not be refreshed.') : smsPreference?.activationStatus === 'active'
            ? smsPreference.consented
              ? `Consented number ending ${smsPreference.phoneLast4 ?? '••••'}. Reply STOP to opt out or HELP for support.`
              : t("Optional and off. Add a mobile number only if you want campaign SMS updates.")
            : smsPreference?.publicMessage || t("Text message updates are not set up for this campaign.")}
        >
          {!smsNeedsRefresh && smsPreference?.activationStatus === 'active' && smsPreference.consented ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Turn off SMS consent")}
              disabled={smsBusy}
              onPress={() => { void updateSmsConsent(false); }}
              style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
            ><Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{smsOperation === 'save' ? t("Saving…") : t("Turn off")}</Text></Pressable>
          ) : null}
        </SettingRow>
      ) : null}
      {mode === 'authenticated' && !smsNeedsRefresh && smsPreference?.activationStatus === 'active' && !smsPreference.consented ? (
        <Card>
          <Heading level={3}>{t("Consent to SMS")}</Heading>
          <Body muted>{t("Enter your mobile number with its country code, for example +1 508 555 0123. This phone shows only the last four digits. Message and data rates may apply.")}</Body>
          <Field label={t("Mobile number")} value={smsPhone} onChangeText={setSmsPhone} maxLength={64} />
          <Button label={smsOperation === 'save' ? t("Saving…") : t("Turn on SMS")} disabled={smsBusy || normalizedSmsPhone === null} onPress={() => { void updateSmsConsent(true); }} />
        </Card>
      ) : null}
      {smsError ? <Notice>{smsError}</Notice> : null}
      {mode === 'authenticated' ? <Button label={smsOperation === 'refresh' ? t('Refreshing account…') : t('Refresh SMS settings')} variant="secondary" disabled={smsBusy} onPress={() => { void refreshSms(); }} /> : null}
      {demoHat ? (
        <SettingRow icon="swap-horizontal-outline" title={mode === 'preview' ? t("Preview role") : t("Demo role")} body={t("Choose which demo role this device is looking through. Demo roles share one fictional campaign.")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Switch demo role")}
            accessibilityHint={t("Opens the demo role menu")}
            onPress={requestHatSwitcher}
            style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Switch")}</Text>
          </Pressable>
        </SettingRow>
      ) : null}
      {/* The store build's demo can be
          left from Account as well as from the DEMO pill's menu. */}
      {storeDemo ? (
        <SettingRow icon="exit-outline" title={t("Exit demo")} body={t("You are in the demo: a fictional union on a separate server.")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Exit demo")}
            accessibilityHint={t("Returns to the Union Ground sign-in.")}
            accessibilityState={{ disabled: storeDemoExitBusy, busy: storeDemoExitBusy }}
            disabled={storeDemoExitBusy}
            onPress={() => { void exitStoreDemo().catch(() => undefined); }}
            style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t(storeDemoExitBusy ? "Closing the demo…" : "Exit demo")}</Text>
          </Pressable>
        </SettingRow>
      ) : null}
      <SettingRow icon="paper-plane-outline" title={t("Test notification")} body={t("Send a test notification to this phone to check that alerts arrive. It includes no worker details.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Send test notification")}
          accessibilityState={{ busy, disabled: busy || !nativePush.enabled }}
          disabled={busy || !nativePush.enabled}
          onPress={() => { void testNotification(); }}
          style={({ pressed }) => [styles.smallButton, {
            backgroundColor: busy || !nativePush.enabled ? theme.muted : theme.secondary,
            opacity: pressed ? 0.82 : 1,
          }]}
        >
          <Text style={[styles.smallButtonText, { color: busy || !nativePush.enabled ? theme.mutedForeground : theme.secondaryForeground }]}>{t("Send")}</Text>
        </Pressable>
      </SettingRow>
      {settingsNotice ? (
        settingsNotice.tone === 'error'
          ? <Notice>{settingsNotice.text}</Notice>
          : <View accessibilityLiveRegion="polite"><Body>{settingsNotice.text}</Body></View>
      ) : null}
      {/* REQ-UG-NATIVE-HELP-AND-SUPPORT-ENTRY-20261018: the signed-in
          app's one Help entry, at the top of the privacy block. Shaped like the
          privacy-policy row below it: the title is the link, so VoiceOver reads
          "Help and support, link" once, and the address stays visible in the
          body for a phone with no mail app. */}
      <HomeGuidePreference />
      <PulseOpeningPreferenceCard />
      <View style={[styles.setting, { borderColor: theme.border }]}>
        <Ionicons name="help-circle-outline" size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <View style={styles.flex}>
          <SupportLink language={language} description={catalogLabel(supportAccountBody)} />
        </View>
      </View>
      {/* Q19 defect 11: this
          row used to be "Read privacy policy, button" into the in-app reader,
          which left the approved public URL a second navigation away. The row
          title is now itself the link, so VoiceOver reads "Privacy policy,
          link" exactly once — putting the same words on a trailing control
          instead would duplicate the label inside one row. The in-app reader
          survives as the clearly secondary "Read" button. */}
      <View style={[styles.setting, { borderColor: theme.border }]}>
        <Ionicons name="document-text-outline" size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <View style={styles.flex}>
          {privacyPolicyUrl ? (
            <>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={privacyPolicyLinkLabel}
                accessibilityHint={privacyPolicyLinkHint}
                accessibilityState={{ busy: privacyLinkBusy, disabled: privacyLinkBusy }}
                disabled={privacyLinkBusy}
                onPress={() => { void openApprovedPrivacyPolicy(); }}
                style={({ pressed }) => [styles.settingLink, { opacity: pressed ? 0.82 : 1 }]}
              >
                <Text style={[styles.settingTitle, styles.settingLinkText, { color: privacyLinkBusy ? theme.mutedForeground : theme.primary }]}>
                  {privacyPolicyLinkLabel}
                </Text>
                <Ionicons name="open-outline" size={18} color={privacyLinkBusy ? theme.mutedForeground : theme.primary} />
              </Pressable>
              <Body muted>
                {privacyLinkBusy
                  ? `Opening ${privacyPolicyUrl}…`
                  : `Opens the approved policy at ${privacyPolicyUrl} in your browser. Read keeps the same text in the app.`}
              </Body>
            </>
          ) : (
            <>
              <Text style={[styles.settingTitle, { color: theme.foreground }]}>{privacyPolicyLinkLabel}</Text>
              <Body muted>{t("No public copy is published yet. Read opens the policy inside the app.")}</Body>
            </>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Read the privacy policy inside the app")}
          onPress={() => router.push('/legal/privacy' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Read")}</Text>
        </Pressable>
      </View>
      {privacyLinkError ? <Notice>{privacyLinkError}</Notice> : null}
      <NativeAccountDeletion />
      <CustomNavLinksCard />
      <ServiceIdentityCard />
      <SettingRow icon="reader-outline" title={t("Terms of use")} body={t("Worker responsibility, campaign records, and support.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Read terms of use")}
          onPress={() => router.push('/legal/terms' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Read")}</Text>
        </Pressable>
      </SettingRow>
      <SettingRow icon="accessibility-outline" title={t("Accessibility")} body={t("How to report a barrier without leaving the app.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Read accessibility")}
          onPress={() => router.push('/legal/accessibility' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Read")}</Text>
        </Pressable>
      </SettingRow>
      <SettingRow icon="sparkles-outline" title={t("Guide AI disclosure")} body={t("What the Guide sends, what it keeps, and how a campaign turns it off.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Read Guide AI disclosure")}
          onPress={() => router.push('/legal/ai-disclosure' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Read")}</Text>
        </Pressable>
      </SettingRow>
      <SettingRow icon="time-outline" title={t("Data retention")} body={t("What is removed when an account is deleted.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Read data retention")}
          onPress={() => router.push('/legal/retention' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Read")}</Text>
        </Pressable>
      </SettingRow>
      <SettingRow icon="notifications-outline" title={t("In-app updates")} body={t("Open the notification center. Push previews never include worker details.")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open updates")}
          onPress={() => router.push('/notifications' as never)}
          style={({ pressed }) => [styles.smallButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
        >
          <Text style={[styles.smallButtonText, { color: theme.secondaryForeground }]}>{t("Open")}</Text>
        </Pressable>
      </SettingRow>
      <NativeShortcutsGuideCard />
      <Body muted>{t("Your phone stores sign-in details securely. Private records refresh only while the app is open and after your access is checked again.")}</Body>
    </Screen>
  );
}

function Field({ label, value, onChangeText, maxLength }: { label: string; value: string; onChangeText: (value: string) => void; maxLength: number }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={maxLength}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={value}
        onChangeText={onChangeText}
        style={[styles.textInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
    </View>
  );
}

// Union Ground is the only theme (owner ruling, Nov 3, 2026,
// REQ-UG-THEMES-UNION-GREEN-ONLY-MOBILE-20261103): there is nothing
// to pick, so the section states the theme. The app is light only
// (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105), so it shows one swatch.
function ThemeSection() {
  const { t, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const option = themeOptions[0]!;
  const light = resolveTheme(option.key);
  return (
    <Card>
      <Heading level={2}>{t("App theme")}</Heading>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={`${catalogLabel(option.label)}. ${catalogLabel(option.description)}`}
        style={[styles.themeOption, { backgroundColor: theme.card, borderColor: theme.primary }]}
      >
        {[light].map((swatch) => (
          <View key={swatch.appearance} style={[styles.themeSwatch, { backgroundColor: swatch.background, borderColor: swatch.border }]}>
            <View style={[styles.themeSwatchPrimary, { backgroundColor: swatch.primary }]} />
            <View style={[styles.themeSwatchAccent, { backgroundColor: swatch.accent }]} />
          </View>
        ))}
        <View style={styles.flex}>
          <Text style={[styles.themeTitle, { color: theme.foreground }]}>{catalogLabel(option.label)}</Text>
          <Body muted>{t('Union Ground is the theme on every desk you can open on this phone.')} {catalogLabel(option.description)}</Body>
        </View>
      </View>
    </Card>
  );
}

function SettingRow({ icon, title, body, children }: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.setting, { borderColor: theme.border }]}>
      <Ionicons name={icon} size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <View style={styles.flex}><Text style={[styles.settingTitle, { color: theme.foreground }]}>{title}</Text><Body muted>{body}</Body></View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  identity: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 58, height: 58, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 18, ...typeface.controlStrong },
  iconButton: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  textInput: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
  themeOption: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  themeSwatch: { width: minimumTouchTarget, height: minimumTouchTarget, borderWidth: 1, borderRadius: radii.sm, overflow: 'hidden', padding: 5, justifyContent: 'flex-end', gap: 3 },
  themeSwatchPrimary: { height: 13, borderRadius: 4 },
  themeSwatchAccent: { width: 16, height: 5, borderRadius: radii.pill, alignSelf: 'flex-end' },
  themeTitle: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  setting: { minHeight: 86, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.md },
  settingLink: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  settingLinkText: { textDecorationLine: 'underline' },
  settingTitle: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  smallButton: { minHeight: minimumTouchTarget, minWidth: 78, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  smallButtonText: { fontSize: 14, ...typeface.controlStrong },
});
