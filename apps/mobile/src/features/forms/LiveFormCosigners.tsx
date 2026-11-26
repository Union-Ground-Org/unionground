import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '../../components/Text';

import { Body, Button, Heading } from '../../components/ui';
import type { NativeUiKey } from '../../lib/nativeUiCopy';
import { useNativeUi } from '../../lib/useNativeUi';
import { CosignRefusal, inviteCosigner, normalCosignerEmail, type CosignerStatus, type FormCosigner } from '../../services/formCosigners';
import { haptics } from '../../services/haptics';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): the filer's co-signers on an alliance grievance, as the website's
// CosignerPanel shows them. invite_cosigner answers the same way whether or
// not the email is a member's, so every invitation shows simply as Invited.
export const COSIGNER_STATUS_TEXT: Record<CosignerStatus, NativeUiKey> = {
  invited: 'Invited',
  accepted: 'Accepted',
  declined: 'Declined',
  reaffirm_needed: 'Needs re-affirm',
  withdrawn: 'Withdrawn',
};

// The server's refusals of invite_cosigner, never worded as a connection
// problem (gate stage 169).
const INVITE_REFUSAL_TEXT: Record<CosignRefusal['reason'], NativeUiKey> = {
  self: 'You can’t invite yourself to co-sign.',
  answered: 'This worker answered already. You can ask them again later.',
  limit: 'This issue report already has 10 co-signers.',
  'not-eligible': 'This issue report can’t take co-signers right now.',
  'not-open': 'This issue report can’t take co-signers right now.',
  'not-withdrawable': 'This issue report can’t take co-signers right now.',
  refused: 'The invitation was not sent for this issue report.',
};

export function LiveFormCosigners({ formID, ownerID, cosigners, busy, onChanged }: {
  // Null until the draft has been saved and has an id.
  formID: string | null;
  ownerID: string;
  cosigners: FormCosigner[];
  busy: boolean;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<NativeUiKey | null>(null);

  async function invite() {
    if (!formID || sending || busy) return;
    if (!normalCosignerEmail(email)) {
      setProblem('Enter a valid email address.');
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      await inviteCosigner(formID, email, ownerID);
      void haptics.success();
      setEmail('');
      onChanged();
    } catch (error) {
      setProblem(error instanceof CosignRefusal ? INVITE_REFUSAL_TEXT[error.reason] : 'The invitation was not sent. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={styles.section}>
      <Heading level={2}>{t('Co-signers')}</Heading>
      <Body muted>{t('Invite other workers to co-sign. They see the full issue report only after they accept, and can withdraw anytime.')}</Body>
      {!formID ? <Body muted>{t('Save a draft first, then invite co-signers.')}</Body> : null}
      {formID && cosigners.length === 0 ? <Body muted>{t('No co-signers yet.')}</Body> : null}
      {cosigners.map((cosigner) => <Body key={cosigner.id}>{`${cosigner.email} · ${t(COSIGNER_STATUS_TEXT[cosigner.status])}`}</Body>)}
      {formID ? (
        <>
          <TextInput
            accessibilityLabel={t('Worker email')}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            maxLength={320}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={email}
            onChangeText={setEmail}
            placeholder={t('name@email.org')}
            placeholderTextColor={theme.quietForeground}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Button label={sending ? t('Sending…') : t('Send invite')} variant="secondary" disabled={busy || sending || !email.trim()} onPress={() => { void invite(); }} />
        </>
      ) : null}
      {problem ? (
        <View accessibilityLiveRegion="polite" accessibilityRole="alert">
          <Body>{t(problem)}</Body>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
});
