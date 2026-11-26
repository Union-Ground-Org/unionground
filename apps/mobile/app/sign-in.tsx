import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text, TextInput } from '../src/components/Text';

import { Body, Button } from '../src/components/ui';
import { PasswordResetRequest } from '../src/components/PasswordResetRequest';
import { BrandMark } from '../src/components/BrandMark';
import { FontScaleRelayout } from '../src/components/FontScaleRelayout';
import { announceForAccessibility } from '../src/lib/announce';
import { OFFICIAL_SERVICE_LABEL, phoneBrand, showsOfficialServiceMark } from '../src/lib/brand';
import { mobileConfig } from '../src/lib/config';
import { PASSWORD_RESUME_PARAM, PASSWORD_RESUME_VALUE } from '../src/lib/emailAuth';
import { loadPendingReset } from '../src/lib/pendingPasswordReset';
import { passwordResetRequestAvailable } from '../src/services/emailAuth';
import { nativeQuickActionDestinationPath } from '../src/services/nativeQuickActionRoutes';
import { isLiveSampleBackend } from '../src/services/sampleSession';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';
import { typeface } from '../src/theme/typeface';

export default function SignInScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { quickAction, reset } = useLocalSearchParams<{ quickAction?: string | string[]; reset?: string | string[] }>();
  const { fontScale } = useWindowDimensions();
  const { mode, error, signOutError, signInWithPassword, enterSample, sampleEntryBusy, enterPreview, previewAllowed } = useApp();
  const liveSample = isLiveSampleBackend(mobileConfig);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Self-service reset (UG f0133fe484): offered only where the reset email
  // can be sent, never on SAMPLE or the preview.
  const resetOffered = passwordResetRequestAvailable();
  // `reset=1` arrives from a failed reset link in the auth callback
  // (UX-UG-NATIVE-LINK-FAILURE-ASK-ADMINISTRATOR-20261018).
  const [resetOpen, setResetOpen] = useState(resetOffered && reset === '1');
  // A begun reset remains resumable for its 15-minute lifetime.
  const [resetResumable, setResetResumable] = useState(false);
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || sampleEntryBusy;
  const [message, setMessage] = useState<{ failed: boolean; text: string } | null>(null);
  const usesAccessibilityType = fontScale >= 2;
  const quickActionDestination = nativeQuickActionDestinationPath(
    Array.isArray(quickAction) ? null : quickAction,
  );

  useEffect(() => {
    if (error && !message && Platform.OS === 'ios') announceForAccessibility(error);
  }, [error, message]);

  useFocusEffect(useCallback(() => {
    if (!resetOffered) return undefined;
    let active = true;
    void loadPendingReset().then((pending) => { if (active) setResetResumable(pending !== null); });
    return () => { active = false; };
  }, [resetOffered]));

  async function submit() {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setMessage(null);
    try {
      await signInWithPassword(email, password);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not sign in. Check the email and password.';
      setMessage({ failed: true, text });
      if (Platform.OS === 'ios') announceForAccessibility(text);
    } finally {
      setBusy(false);
    }
  }

  async function openSample() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await enterSample();
    } catch {
      const text = 'SAMPLE is unavailable. Try again.';
      setMessage({ failed: true, text });
      if (Platform.OS === 'ios') announceForAccessibility(text);
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'authenticated' || mode === 'preview') {
    return <Redirect href={(quickActionDestination ?? '/(tabs)/home') as never} />;
  }
  if (mode === 'mfaRequired') {
    return quickActionDestination
      ? <Redirect href={{ pathname: '/mfa-challenge', params: { quickAction } }} />
      : <Redirect href="/mfa-challenge" />;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.page, { backgroundColor: theme.background }]}>
      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        contentContainerStyle={[styles.content, usesAccessibilityType ? styles.accessibilityTypeContent : null]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        <FontScaleRelayout>
        <View style={styles.brand}>
          <View style={styles.mark}>
            <BrandMark size={56} />
          </View>
          {/* The product wordmark is a visual anchor rather than reading copy.
              Keep it at a full 200% maximum so Accessibility XXXL does not
              split individual glyphs across the viewport; the explanatory
              text below remains uncapped and scrollable. */}
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={2}
            style={[styles.brandTitle, { color: theme.foreground }]}
          >
            Union Ground
          </Text>
          {/* Official Union Ground LLC build on the official backend only. */}
          {showsOfficialServiceMark(phoneBrand, mobileConfig) ? <Body>{OFFICIAL_SERVICE_LABEL.en}</Body> : null}
          <Body muted>{liveSample ? 'Explore the demo as a fictional worker. No password is needed.' : 'A private workspace for coworkers organizing together. Use the email and temporary password from your invitation.'}</Body>
        </View>
        {signOutError ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{signOutError}</Body> : null}
        {!liveSample && previewAllowed ? (
          <View style={styles.demoActions}>
            <Button label="Try the demo" variant="secondary" disabled={busy} onPress={() => enterPreview({ hat: 'member', shell: 'tabs' })} />
            {/* b01-3: the caveat named the wrong drawer (Compass is the member
                right pane, not a Home drawer) and taught a gesture instead of
                the map. It now states where each drawer lives and stops
                describing swipes. */}
            <Body muted>Starts as Darnell Foster, a fictional worker at a fictional employer. All tools sit under Home on the left, and Campaign work sits under Home on the right. Switch hats from the compact pill at the top. Nothing here is a real coworker or record.</Body>
          </View>
        ) : null}
        {resetOffered && resetOpen ? <PasswordResetRequest initialEmail={email} onBack={(typed) => { setEmail(typed); setResetOpen(false); }} /> : (
        <View style={styles.form}>
          {resetResumable ? (
            <>
              <Body>You started resetting your password. Continue where you left off.</Body>
              <Button label="Continue resetting your password" disabled={busy} onPress={() => { router.push({ pathname: '/auth/callback', params: { [PASSWORD_RESUME_PARAM]: PASSWORD_RESUME_VALUE } }); }} />
            </>
          ) : null}
          {liveSample ? (
            <Button label={busy ? 'Opening the demo…' : 'Open the demo'} busy={busy} disabled={busy || mode !== 'signedOut'} onPress={() => { void openSample(); }} />
          ) : null}
          <Text maxFontSizeMultiplier={2} style={[styles.label, { color: theme.foreground }]}>Email address</Text>
          <TextInput
            accessibilityLabel="Email address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            spellCheck={false}
            keyboardType="email-address"
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            returnKeyType="next"
            placeholder="you@example.org"
            placeholderTextColor={theme.mutedForeground}
            value={email}
            onChangeText={setEmail}
            maxFontSizeMultiplier={2}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Text maxFontSizeMultiplier={2} style={[styles.label, { color: theme.foreground }]}>Password</Text>
          <TextInput
            accessibilityLabel="Password"
            autoCapitalize="none"
            autoComplete="password"
            secureTextEntry
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            returnKeyType="go"
            placeholder="Your password"
            placeholderTextColor={theme.mutedForeground}
            value={password}
            onChangeText={setPassword}
            maxFontSizeMultiplier={2}
            onSubmitEditing={() => { void submit(); }}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !email.trim() || !password || !mobileConfig.backendConfigured} onPress={() => { void submit(); }} />
          {resetOffered ? <Button label="Forgot your password?" variant="secondary" disabled={busy} onPress={() => { setMessage(null); setPassword(''); setResetOpen(true); }} /> : null}
          {!mobileConfig.backendConfigured ? <Body muted>Live sign-in stays closed until a dedicated Union Ground provider is configured. The preview above works without an account.</Body> : null}
          {error && !message ? (
            <View accessibilityLiveRegion="polite">
              <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{error}</Body>
            </View>
          ) : null}
          {message ? (
            <View accessibilityLiveRegion="polite">
              <Body accessibilityRole="alert" style={message.failed ? { color: theme.destructive } : undefined}>{message.text}</Body>
            </View>
          ) : null}
        </View>
        )}
        <View style={[styles.legalRow, usesAccessibilityType ? styles.accessibilityTypeStack : null]}>
          <View style={[styles.legalButton, usesAccessibilityType ? styles.accessibilityTypeLegalButton : null]}><Button label="Privacy policy" variant="secondary" onPress={() => router.push('/legal/privacy' as never)} /></View>
          <View style={[styles.legalButton, usesAccessibilityType ? styles.accessibilityTypeLegalButton : null]}><Button label="Terms of use" variant="secondary" onPress={() => router.push('/legal/terms' as never)} /></View>
        </View>
        <Body muted style={styles.privacy}>Your session is stored in the device Keychain or Android Keystore. Sensitive details are hidden from notification previews.</Body>
        <Button label="Read public downloads" variant="secondary" onPress={() => router.push('/offline' as never)} />
        </FontScaleRelayout>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
  accessibilityTypeContent: { justifyContent: 'flex-start' },
  brand: { gap: spacing.sm },
  mark: { marginBottom: spacing.sm },
  brandTitle: { fontSize: 33, lineHeight: 38, fontWeight: '600', letterSpacing: -0.4, fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }) },
  form: { gap: spacing.md },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, fontSize: 17 },
  privacy: { fontSize: 13, lineHeight: 18 },
  demoActions: { gap: spacing.sm },
  legalRow: { flexDirection: 'row', gap: spacing.sm },
  legalButton: { flex: 1 },
  accessibilityTypeStack: { flexDirection: 'column' },
  accessibilityTypeLegalButton: { flex: 0, width: '100%' },
});
