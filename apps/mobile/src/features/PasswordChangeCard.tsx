import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import { NEW_PASSWORD_MIN, NEW_PASSWORD_MAX, NEW_PASSWORD_RULE, NEW_PASSWORD_TOO_LONG, NEW_PASSWORD_TOO_SHORT,
  newPasswordLengthIssue } from '../../../../src/lib/passwordPolicy.js';
import { Body, Button, Card, Heading } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function PasswordChangeCard() {
  const { updatePassword, mode, sessionRestricted } = useApp();
  const { t, language, catalogLabel } = useNativeUi();
  const passwordRule = NEW_PASSWORD_RULE[language];
  const theme = useTheme();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ failed: boolean; text: string } | null>(null);
  const requestState = useRef<'idle' | 'busy' | 'success'>('idle');
  const locked = busy || outcome?.failed === false;
  // #9458 (M2-1), the phone twin of #9448: the new-password field says as it is
  // typed when the length rule is missed, in the web's words, and a press on the
  // unavailable Change password names the first unmet rule, in field order.
  const lengthIssue = newPasswordLengthIssue(newPassword);
  const lengthReason = lengthIssue ? (lengthIssue === 'short' ? NEW_PASSWORD_TOO_SHORT : NEW_PASSWORD_TOO_LONG)[language]
    .replace('{count}', String(newPassword.length)) : '';
  const changeReason = !currentPassword ? t('Enter your current password to change it.')
    : !newPassword ? passwordRule : lengthReason || (confirmPassword !== newPassword ? t('The passwords do not match.') : '');

  async function submit() {
    if (requestState.current !== 'idle') return;
    if (newPassword !== confirmPassword) {
      setOutcome({ failed: true, text: t('The passwords do not match.') });
      return;
    }
    requestState.current = 'busy';
    setBusy(true);
    setOutcome(null);
    try {
      await updatePassword(newPassword, currentPassword);
      setNewPassword(''); setConfirmPassword('');
      requestState.current = 'success';
      setOutcome({ failed: false, text: t('Your password was changed.') });
    } catch (error) {
      requestState.current = 'idle';
      // The helper throws app-owned English sentences; show them in the
      // member's language. The length rule is thrown in English too.
      const text = !(error instanceof Error) ? t('Your password change could not be confirmed. Try again.')
        : error.message === NEW_PASSWORD_RULE.en ? passwordRule : catalogLabel(error.message);
      setOutcome({ failed: true, text });
    } finally {
      setCurrentPassword('');
      setBusy(false);
    }
  }

  // USER_UPDATED revalidates the same account through mode=booting. Hide the
  // protected controls without unmounting their request guard or outcome.
  if (mode !== 'authenticated' || sessionRestricted) return null;

  return <Card>
    <Heading level={3}>{t("Change password")}</Heading>
    <Body muted>{passwordRule} {t("Union Ground never sends this value to analytics or application logs.")}</Body>
    {[
      { label: t('Current password'), value: currentPassword, change: setCurrentPassword, current: true },
      { label: t('New password'), value: newPassword, change: setNewPassword, current: false, reason: lengthReason },
      { label: t('Confirm new password'), value: confirmPassword, change: setConfirmPassword, current: false },
    ].map(field => <View key={field.label} style={styles.field}>
      <Text style={[styles.label, { color: theme.foreground }]}>{field.label}</Text>
      <TextInput accessibilityLabel={field.label} accessibilityHint={field.current ? undefined : field.reason ? `${field.reason} ${passwordRule}` : passwordRule}
        autoCapitalize="none" autoComplete={field.current ? 'current-password' : 'new-password'} autoCorrect={false}
        secureTextEntry editable={!locked} maxLength={field.current ? undefined : NEW_PASSWORD_MAX}
        keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={field.value} onChangeText={field.change}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]} />
      {field.reason ? <Body style={{ color: theme.destructive }}>{field.reason}</Body> : null}
      {!field.current && <Body muted>{passwordRule}</Body>}
    </View>)}
    <Button label={busy ? t('Changing…') : t('Change password')}
      disabled={locked || !currentPassword || newPassword.length < NEW_PASSWORD_MIN || confirmPassword.length < NEW_PASSWORD_MIN}
      disabledReason={locked ? undefined : changeReason}
      onPress={() => { void submit(); }} />
    {outcome && <View accessibilityLiveRegion="polite">
      <Body style={outcome.failed ? { color: theme.destructive } : undefined}>{outcome.text}</Body>
      {!outcome.failed && <Button label={t("Dismiss")} variant="secondary" onPress={() => { requestState.current = 'idle'; setOutcome(null); }} />}
    </View>}
  </Card>;
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
});
