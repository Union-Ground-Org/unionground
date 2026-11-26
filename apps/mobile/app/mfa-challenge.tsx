import { Ionicons } from '@expo/vector-icons';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../src/components/Text';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Body, Button, Heading } from '../src/components/ui';
import { announceForAccessibility } from '../src/lib/announce';
import { cleanAuthenticatorCode, isAuthenticatorCode } from '../src/lib/authenticatorCode';
import { mfaChallengeKey } from '../src/lib/mfaChallengeKey';
import { resolveMfaRecoveryApiOrigin } from '../src/lib/portalApiOrigin';
import { mfaRecoveryCodeAccepted, mfaRecoveryMessage, redeemMfaRecoveryCode, type MfaRecoveryOutcome } from '../src/lib/mfaRecovery';
import { sessionUnavailableCopy } from '../src/lib/sessionUnavailableCopy';
import { staffTwoStepSettings } from '../src/lib/staffTwoStepNotice';
import { nativeQuickActionDestinationPath } from '../src/services/nativeQuickActionRoutes';
import { getSupabaseClient } from '../src/services/supabase';
import { useApp, type MfaRecoveryAttempt } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';

import { typeface } from '../src/theme/typeface';
import { useBusinessOperation } from '../src/lib/useBusinessWriter';
import { useNativeUi } from '../src/lib/useNativeUi';
const twoStep = staffTwoStepSettings();

// Keyed by the challenge identity so sign-out and every new sign-in start from
// an empty screen (BUG-UG-MOBILE-MFA-CHALLENGE-STALE-STATE-20261001).
export default function MfaChallengeScreen() {
  const { session } = useApp();
  return <MfaChallengeForm key={mfaChallengeKey(session)} />;
}

function MfaChallengeForm() {
  const { catalogLabel } = useNativeUi();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scrollContentStyle = [styles.scrollContent, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }];
  const router = useRouter();
  const { forceReverify, quickAction, resume } = useLocalSearchParams<{
    forceReverify?: string | string[];
    quickAction?: string | string[];
    resume?: string | string[];
  }>();
  const {
    mode, assuranceUnavailable, assuranceUnavailableReason, signOutError, verifyMfa, beginMfaRecovery, finishMfaRecovery, confirmMfaRecoveryGlobalSignOut,
    retrySessionAuthentication, signOut,
  } = useApp();
  const [code, setCode] = useState('');
  const [operationKind, setOperationKind] = useState<string | null>(null);
  const busy = operationKind !== null;
  const [runOperation] = useBusinessOperation<string | null>(setOperationKind, null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recovering, setRecovering] = useState(false);
  const recoveryCleanup = useRef<MfaRecoveryAttempt | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const working = busy || recovering;
  const quickActionDestination = nativeQuickActionDestinationPath(
    Array.isArray(quickAction) ? null : quickAction,
  );
  const forceReverificationRequested = (Array.isArray(forceReverify) ? null : forceReverify) === '1';
  const resumeToShareIntake = (Array.isArray(resume) ? null : resume) === 'share-intake';
  const returnDestination = (Array.isArray(resume) ? null : resume) === 'share-intake'
    ? '/share-intake'
    : quickActionDestination ?? '/(tabs)/home';

  function report(text: string, failed = true) {
    const translated = catalogLabel(text);
    setMessage({ text: translated, failed });
    if (Platform.OS === 'ios') announceForAccessibility(translated);
  }

  async function submit() {
    if (!isAuthenticatorCode(code)) return;
    await runOperation('verify', async () => {
    setMessage(null);
    try {
      await verifyMfa(code);
      if (!mounted.current) return;
      if (forceReverificationRequested) {
        if (resumeToShareIntake) router.dismissTo('/share-intake');
        else router.replace(returnDestination as never);
      }
    } catch {
      if (mounted.current) report('That code could not be verified. Try the current code from your authenticator app.');
    }
    });
  }

  // A worker who lost the authenticator redeems a saved one-time code here. The
  // server removes the factor and revokes every session; the local session is
  // then cleared, which returns this screen to sign-in through the usual
  // signed-out path. The recovery is bound to the account at this challenge:
  // its token must be that account's, and only a server-confirmed global
  // logout for it lifts an earlier incomplete Sign out everywhere warning
  // before the local sign-out
  // (SEC-UG-MFA-RECOVERY-GLOBAL-LOGOUT-CLEARS-INCOMPLETE-WARNING-20261020).
  async function recover() {
    if (!mounted.current) return;
    await runOperation('recover', async () => {
    const client = getSupabaseClient();
    if (!client) {
      report(mfaRecoveryMessage('unavailable'));
      return;
    }
    const attempt = recoveryCleanup.current ?? beginMfaRecovery();
    if (!attempt) { report(mfaRecoveryMessage('unavailable')); return; }
    setRecovering(true);
    setMessage(null);
    try {
      const finishLocalRecovery = async () => {
        recoveryCleanup.current = attempt;
        if (mounted.current) setRecoveryCode('');
        return finishMfaRecovery(attempt);
      };
      const outcome = recoveryCleanup.current
        ? await finishLocalRecovery().then<MfaRecoveryOutcome, MfaRecoveryOutcome>((cleared) => cleared ? 'recovered' : 'cleanup-required', () => 'cleanup-required')
        : await redeemMfaRecoveryCode(recoveryCode, {
        apiOrigin: () => resolveMfaRecoveryApiOrigin(),
        accessToken: async () => {
          const current = (await client.auth.getSession()).data.session;
          if (!current || (attempt && current.user.id !== attempt.userID)) return null;
          return current.access_token;
        },
        confirmGlobalSignOut: () => { if (attempt) confirmMfaRecoveryGlobalSignOut(attempt); },
        // The server already revoked the account. Local teardown quarantines
        // unresolved shares without an authenticated recovery request.
        signOutLocally: finishLocalRecovery,
      });
      if (outcome === 'recovered') { recoveryCleanup.current = null; setRecoveryCode(''); }
      if (!mounted.current) return;
      report(mfaRecoveryMessage(outcome), outcome !== 'recovered');
    } finally {
      if (mounted.current) setRecovering(false);
    }
    });
  }

  if (mode === 'authenticated' && !forceReverificationRequested) {
    return <Redirect href={(quickActionDestination ?? '/(tabs)/home') as never} />;
  }
  if (mode === 'signedOut') {
    return quickActionDestination
      ? <Redirect href={{ pathname: '/sign-in', params: { quickAction } }} />
      : <Redirect href="/sign-in" />;
  }

  if (assuranceUnavailable) {
    // Offline says so in plain words; every other reason keeps the security
    // wording. Same controls and the same locked data either way
    // (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018).
    const copy = sessionUnavailableCopy(assuranceUnavailableReason);
    return (
      <ScrollView style={[styles.page, { backgroundColor: theme.background }]} contentContainerStyle={scrollContentStyle}>
        <View style={styles.content}>
          <Heading>{catalogLabel(copy.title)}</Heading>
          <Body muted>{copy.body}</Body>
          <Button label={operationKind === 'refresh' ? 'Checking…' : 'Try again'} disabled={busy} onPress={() => {
            void runOperation('refresh', async () => { await retrySessionAuthentication(); });
          }} />
          <Button label="Read public downloads" variant="secondary" onPress={() => router.push('/offline' as never)} />
          <Button label={twoStep.action} variant="secondary" onPress={() => {
            void Linking.openURL(twoStep.url).catch(() => report(twoStep.openFailed));
          }} />
          {message ? <Body accessibilityRole="alert">{message.text}</Body> : null}
          <Button label="Sign out instead" variant="secondary" disabled={busy} onPress={() => { void signOut(); }} testID="native-security-sign-out" />
          {signOutError ? <Body style={{ color: theme.destructive }}>{signOutError}</Body> : null}
        </View>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.page, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={scrollContentStyle} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <View style={styles.content}>
        <Heading>{catalogLabel("Enter your authenticator code")}</Heading>
        <Body muted>Open your authenticator app and enter the six-digit code for Union Ground. Private campaign details open after the code is accepted.</Body>
        <Text style={[styles.label, { color: theme.foreground }]}>Authenticator code</Text>
        <TextInput
          accessibilityLabel="Authenticator code"
          autoComplete="one-time-code"
          autoFocus
          editable={!working && !recoveryCleanup.current}
          inputMode="numeric"
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={code}
          onChangeText={(value) => setCode(cleanAuthenticatorCode(value))}
          onSubmitEditing={() => { void submit(); }}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Button label={operationKind === 'verify' ? 'Verifying…' : 'Verify code'} disabled={working || Boolean(recoveryCleanup.current) || !isAuthenticatorCode(code)} onPress={() => { void submit(); }} />
        {message ? (
          <View accessibilityLiveRegion="polite">
            <Body accessibilityRole="alert" style={{ color: message.failed ? theme.destructive : theme.foreground }}>{message.text}</Body>
          </View>
        ) : null}
        {/* The code field follows the heading directly; setting up two-step
            is the less common path and sits below the Verify button
            (PRES-P5, Nov 6, 2026). */}
        <Body muted>If your organization requires two-step and you have not set it up yet, set it up on the website, then sign in here again.</Body>
        <Button label={twoStep.action} variant="secondary" onPress={() => {
          void Linking.openURL(twoStep.url).catch(() => report(twoStep.openFailed));
        }} />
        <View style={[styles.recovery, { borderTopColor: theme.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use a recovery code"
            accessibilityState={{ expanded: recoveryOpen }}
            disabled={working || Boolean(recoveryCleanup.current)}
            onPress={() => setRecoveryOpen((open) => !open)}
            style={styles.recoveryToggle}
          >
            <Text style={[styles.label, { color: theme.foreground }]}>Use a recovery code</Text>
            <Ionicons name={recoveryOpen ? 'remove' : 'add'} size={24} color={theme.foreground} />
          </Pressable>
          {recoveryOpen ? (
            <View style={styles.recoveryBody}>
              <Body muted>A saved one-time code removes the lost authenticator and signs out every session. You sign in again and set up a new one.</Body>
              <TextInput
                accessibilityLabel="One-time recovery code"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                autoCorrect={false}
                editable={!working && !recoveryCleanup.current}
                keyboardAppearance={theme.appearance}
                selectionColor={theme.primary}
                maxLength={32}
                value={recoveryCode}
                onChangeText={(value) => setRecoveryCode(value.replace(/[^A-Za-z0-9- ]/g, ''))}
                onSubmitEditing={() => { void recover(); }}
                style={[styles.recoveryInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
              />
              <Button
                label={recovering ? 'Recovering…' : recoveryCleanup.current ? catalogLabel('Finish signing out') : 'Recover account'}
                disabled={working || (!recoveryCleanup.current && !mfaRecoveryCodeAccepted(recoveryCode))}
                onPress={() => { void recover(); }}
              />
            </View>
          ) : null}
        </View>
        <Body muted>Lost your phone and your backup codes? Your campaign administrator can reset your two-step sign-in. Ask them directly.</Body>
        <Button label="Read public downloads" variant="secondary" onPress={() => router.push('/offline' as never)} />
        <Button label="Sign out instead" variant="secondary" disabled={working || Boolean(recoveryCleanup.current)} onPress={() => { void signOut(); }} testID="native-security-sign-out" />
        {signOutError ? <Body style={{ color: theme.destructive }}>{signOutError}</Body> : null}
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  content: { gap: spacing.lg },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, fontSize: 22, letterSpacing: 4, textAlign: 'center' },
  recovery: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm },
  recoveryToggle: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  recoveryBody: { gap: spacing.lg, paddingBottom: spacing.sm },
  recoveryInput: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, fontSize: 17, letterSpacing: 1 },
});
