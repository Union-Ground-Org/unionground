import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { SignaturePad } from '../../components/SignaturePad';
import { Body, Button, Heading } from '../../components/ui';
import { signatureIsSendable, type SignatureStrokes } from '../../lib/signatureStrokes';
import { useNativeUi } from '../../lib/useNativeUi';
import type { FormFile, FormFileTarget } from '../../services/formFiles';
import { haptics } from '../../services/haptics';
import type { FormAnswerValue, FormAnswers, FormField, FormTemplate } from '../../services/memberForms';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import { LiveFormAttachments } from './LiveFormAttachments';

import { typeface } from '../../theme/typeface';
// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699):
// the editor's last step, as on the web's "Review & submit": the answers and
// attachments to check, the filer's drawn signature with explicit consent (sign_member_form),
// and Submit (submit_form), which the server allows only with a signature for
// the form's current content and every required answer given.
export function answerText(field: FormField, value: FormAnswerValue | undefined, checked: string, unchecked: string): string {
  const label = (item: string) => field.options.find((option) => option.value === item)?.label ?? item;
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? checked : unchecked;
  return typeof value === 'string' ? label(value) : '';
}

export function LiveFormFiling({ template, answers, missing, unsaved, attachments, signatureCurrent, signatureStale, busy, submitting, onSign, onSubmit, onDrawingChange }: {
  template: FormTemplate;
  answers: FormAnswers;
  missing: string[];
  // Answers left out of the save because they do not parse; named here so the
  // member fixes them before signing.
  unsaved: string[];
  // The form's attachments, which the signature covers too (part 2 of #8699).
  attachments: { target: FormFileTarget | null; files: FormFile[] | null; onFiles: (files: FormFile[]) => void };
  signatureCurrent: boolean;
  signatureStale: boolean;
  busy: boolean;
  submitting: boolean;
  onSign: (strokes: SignatureStrokes) => Promise<boolean>;
  onSubmit: () => void;
  onDrawingChange: (drawing: boolean) => void;
}) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const [strokes, setStrokes] = useState<SignatureStrokes>([]);
  const [consent, setConsent] = useState(false);
  const answered = template.steps.flatMap((step) => step.fields).flatMap((field) => {
    const text = answerText(field, answers[field.key], t('Checked'), t('Not checked'));
    return text ? [{ field, text }] : [];
  });
  const drawn = signatureIsSendable(strokes);
  const canSign = !busy && consent && drawn;
  // #9460: why Save signature is unavailable, said on press (the shared Button's
  // reason), naming only what is missing. Drawing or clearing never changes the
  // tick, so a ticked box with a blank pad asks for the drawing alone.
  const signReason = busy || canSign ? undefined
    : !drawn && !consent ? t('Draw your signature in the box above, then tick the box to confirm it.')
      : !drawn ? t('Draw your signature in the box above.')
        : t('Tick the box above to confirm this drawing is your signature.');
  // The server refuses a submission while any upload or its check is unfinished.
  // A confirmed file whose safety verdict lapsed must be checked again first.
  const filesPending = attachments.files === null || attachments.files.some((file) => !file.confirmed || !file.scanCurrent);
  const canSubmit = !busy && missing.length === 0 && unsaved.length === 0 && signatureCurrent && !filesPending;

  return (
    <View style={styles.section}>
      <Heading level={2}>{t('Review & submit')}</Heading>
      <Body muted>{t('Check your answers before sending them to the committee.')}</Body>
      {answered.map(({ field, text }) => <Body key={field.key}>{`${field.label}: ${text}`}</Body>)}
      {unsaved.length ? <Body>{t('These answers are not in a form that can be saved. Go back and correct them: {fields}.', { fields: unsaved.join(', ') })}</Body> : null}
      {missing.length
        ? <Body muted>{t('Still needed before you can submit: {fields}.', { fields: missing.join(', ') })}</Body>
        : <Body muted>{t('Every required answer is filled in.')}</Body>}

      <LiveFormAttachments target={attachments.target} files={attachments.files} busy={busy} onFiles={attachments.onFiles} />
      {attachments.files?.some((file) => !file.confirmed || !file.scanCurrent) ? <Body muted>{t('Wait until every attachment has finished uploading and its safety check, then submit again.')}</Body> : null}

      <Heading level={2}>{t('Signature')}</Heading>
      {signatureCurrent ? <Body>{t('Filer signature saved')}</Body> : null}
      {!signatureCurrent && signatureStale ? <Body>{t('Answers or attachments changed. Draw and save your signature again.')}</Body> : null}
      <SignaturePad
        value={strokes}
        onChange={setStrokes}
        onDrawingChange={onDrawingChange}
        disabled={busy}
        label={t('Draw your signature')}
        instructions={t('Draw with one finger inside the box. With VoiceOver or TalkBack on, double-tap and hold, then draw.')}
        clearLabel={t('Clear signature')}
        capLabel={t('This signature cannot accept any more strokes or points.')}
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={t('I intend this drawing to be my signature on this version of the form.')}
        accessibilityState={{ checked: consent, disabled: busy }}
        disabled={busy}
        onPress={() => { void haptics.select(); setConsent(!consent); }}
        style={({ pressed }) => [styles.checkRow, { opacity: pressed ? 0.82 : 1 }]}
      >
        <View style={[styles.checkBox, { borderColor: consent ? theme.primary : theme.mutedForeground, backgroundColor: consent ? theme.primary : 'transparent' }]}>
          {consent ? <Text style={[styles.checkMark, { color: theme.primaryForeground }]}>✓</Text> : null}
        </View>
        <Text style={[styles.checkLabel, { color: theme.foreground }]}>{t('I intend this drawing to be my signature on this version of the form.')}</Text>
      </Pressable>
      <Button
        label={t('Save signature')}
        variant="secondary"
        disabled={!canSign}
        disabledReason={signReason}
        onPress={() => {
          void onSign(strokes).then((saved) => {
            if (!saved) return;
            setStrokes([]);
            setConsent(false);
          });
        }}
      />

      {!signatureCurrent ? <Body muted>{t('Draw and save your signature before submitting.')}</Body> : null}
      <Button label={submitting ? t('Submitting…') : t('Submit for committee member review')} disabled={!canSubmit} onPress={onSubmit} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  checkRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkBox: { width: 24, height: 24, borderWidth: 2, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 15, lineHeight: 18, ...typeface.controlStrong },
  checkLabel: { flex: 1, fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
});
