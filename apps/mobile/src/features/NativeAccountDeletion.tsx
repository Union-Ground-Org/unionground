import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '../components/Text';
import { SupportLink } from '../components/SupportLink';
import { Body, Button, Card, Heading } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

export function NativeAccountDeletion() {
  const { mode, sampleHat, session, deleteAccount, signOut, signOutBusy } = useApp();
  // The saved member language (#8303). The phrase to type stays DELETE MY ACCOUNT.
  const { t, language, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const [issue, setIssue] = useState<DeletionIssue | null>(null);
  if (mode !== 'authenticated' || sampleHat) return null;
  // BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: without a
  // TOTP factor (the one type the app can challenge) the member confirms with
  // their password instead.
  const passwordReauth = !(session?.user?.factors ?? []).some((factor) => factor.status === 'verified' && factor.factor_type === 'totp');

  async function submit() {
    if (submitted.current || confirmation !== 'DELETE MY ACCOUNT' || signOutBusy) return;
    submitted.current = true;
    setBusy(true);
    setIssue(null);
    try { await deleteAccount(confirmation, passwordReauth && password ? password : undefined); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      setIssue(code === 'account-delete-indeterminate' ? 'indeterminate'
        : code === 'not-permitted' || code === 'reauth-failed' || code === 'try-later' ? code : 'failed');
      if (code === 'reauth-failed') setPassword('');
      // An uncertain outcome must never be submitted a second time.
      submitted.current = code === 'account-delete-indeterminate';
    } finally { setBusy(false); }
  }
  return <Card>
    <Heading level={2}>{t("Delete your account")}</Heading>
    <Body>{t("This permanently removes your account, profile and private account data. Campaign records that must be retained are kept without your account access.")}</Body>
    <Body muted>{passwordReauth ? t("For security, enter your password to confirm it's you. This cannot be undone.") : t('Recent two-step verification is required. This cannot be undone.')}</Body>
    {!confirming ? <Button label={t("Delete my account")} variant="danger" disabled={signOutBusy} onPress={() => setConfirming(true)} /> : <View style={styles.confirmation}>
      {passwordReauth ? <TextInput accessibilityLabel={t("Your password")} placeholder={t("Your password")} value={password} onChangeText={setPassword}
        secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoComplete="current-password"
        editable={!busy && issue !== 'indeterminate'} maxLength={256} selectionColor={theme.primary} keyboardAppearance={theme.appearance}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /> : null}
      <Body>{t("Type DELETE MY ACCOUNT to confirm.")}</Body>
      <TextInput accessibilityLabel={t("Type DELETE MY ACCOUNT to confirm")} value={confirmation} onChangeText={setConfirmation}
        autoCapitalize="characters" autoCorrect={false} editable={!busy && issue !== 'indeterminate'}
        maxLength={32} selectionColor={theme.primary} keyboardAppearance={theme.appearance}
        style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
      {issue ? <Body accessibilityRole="alert">{issue === 'indeterminate'
        ? t('We could not confirm whether deletion finished. Do not submit it again. Sign out, then try signing in to check your account, or use Help and support below.')
        : catalogLabel(deletionIssueCopy(issue, passwordReauth))}</Body> : null}
      {issue === 'indeterminate' ? <SupportLink language={language} /> : null}
      <Button label={busy ? t('Deleting account…') : t('Permanently delete my account')} variant="danger"
        disabled={busy || signOutBusy || issue === 'indeterminate' || confirmation !== 'DELETE MY ACCOUNT'} onPress={() => { void submit(); }}
        // #9458 (M2-4): a press with any other text names the exact phrase.
        disabledReason={busy || signOutBusy || issue === 'indeterminate' || confirmation === 'DELETE MY ACCOUNT' ? undefined : t('Type DELETE MY ACCOUNT to confirm.')} />
      {issue === 'indeterminate' ? <Button label={t("Sign out to check account")} variant="secondary" disabled={signOutBusy} onPress={() => { void signOut(); }} />
        : <Button label={t("Cancel")} variant="secondary" disabled={busy} onPress={() => { setConfirming(false); setConfirmation(''); setIssue(null); }} />}
    </View>}
  </Card>;
}

type DeletionIssue = 'failed' | 'indeterminate' | 'not-permitted' | 'reauth-failed' | 'try-later';

export function deletionIssueCopy(issue: Exclude<DeletionIssue, 'indeterminate'>, passwordReauth: boolean): string {
  if (issue === 'reauth-failed') return 'That password didn\'t match. Check it and try again.';
  if (issue === 'try-later') return 'Too many password attempts. Wait up to an hour and try again.';
  if (issue === 'not-permitted') return passwordReauth
    ? 'We couldn\'t confirm it\'s you. Enter your password and try again.'
    : 'We couldn\'t confirm a recent two-step verification. Sign out, sign in again with your two-step code, then delete your account within 10 minutes.';
  return 'Your account was not deleted. Try again when your connection is available.';
}

const styles = StyleSheet.create({
  confirmation: { gap: spacing.md },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16 },
});
