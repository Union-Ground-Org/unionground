import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { SignaturePad } from '../../components/SignaturePad';
import { Body, Button, Card, Heading } from '../../components/ui';
import type { NativeUiKey } from '../../lib/nativeUiCopy';
import { signatureIsSendable, type SignatureStrokes } from '../../lib/signatureStrokes';
import { useNativeUi } from '../../lib/useNativeUi';
import { CosignChangedSincePreview, CosignRefusal, respondToCosign, withdrawCosign, type CosignRequest } from '../../services/formCosigners';
import { haptics } from '../../services/haptics';
import type { FormTemplate } from '../../services/memberForms';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import { answerText } from './LiveFormFiling';

import { typeface } from '../../theme/typeface';
// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): the member's invitations to co-sign, as the website's
// CosignRequestsSection shows them. Before accepting, only the preview's
// summary and the filer's name; accepting needs the member's own drawn
// signature and consent; an accepted co-signature can be withdrawn.
const LEAD: Record<CosignRequest['status'], NativeUiKey> = {
  invited: '{name} invited you to co-sign an alliance grievance.',
  reaffirm_needed: '{name} edited a grievance you co-signed. Re-affirm to keep your name on it.',
  accepted: 'You co-signed {name}’s alliance grievance.',
};

export function LiveCosignRequests({ requests, templateFor, ownerID, drawingChange, onChanged }: {
  requests: CosignRequest[];
  templateFor: (request: CosignRequest) => FormTemplate | null;
  ownerID: string;
  drawingChange: (drawing: boolean) => void;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<SignatureStrokes>([]);
  const [consent, setConsent] = useState(false);
  const [problem, setProblem] = useState<NativeUiKey | null>(null);
  // Requests whose accept the server refused because the filer changed the
  // grievance after the preview (#8730); the row says so over the re-read
  // preview until the member answers it.
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());
  const markChanged = (formID: string, isChanged: boolean) => setChanged((previous) => {
    if (previous.has(formID) === isChanged) return previous;
    const next = new Set(previous);
    if (isChanged) next.add(formID);
    else next.delete(formID);
    return next;
  });
  // A request whose preview became unavailable, or that left the list, ends
  // its signing: the drawn signature and the consent tick are cleared, so a
  // retry that loads the preview again starts the sheet empty (ledger 224).
  const signingAnswerable = signing !== null
    && requests.some((request) => request.formID === signing && !(request.status !== 'accepted' && request.previewUnavailable));
  useEffect(() => {
    if (signing === null || signingAnswerable) return;
    setSigning(null);
    setStrokes([]);
    setConsent(false);
  }, [signing, signingAnswerable]);
  if (requests.length === 0) return null;

  async function act(request: CosignRequest, action: () => Promise<void>) {
    if (busy) return;
    setBusy(request.formID);
    setProblem(null);
    try {
      await action();
      void haptics.success();
      markChanged(request.formID, false);
      setSigning(null);
      setStrokes([]);
      setConsent(false);
      onChanged();
    } catch (error) {
      // The filer changed the grievance after this preview; nothing was
      // co-signed. Nothing is sent again: the sheet closes, the signature and
      // consent clear, and the requests are read again so the current
      // preview shows.
      if (error instanceof CosignChangedSincePreview) {
        markChanged(request.formID, true);
        setSigning(null);
        setStrokes([]);
        setConsent(false);
        onChanged();
        return;
      }
      // A refusal is the server's answer: the invitation or co-signature is no
      // longer open (an approved grievance, a withdrawn invitation), so the
      // list is read again; only an unanswered request asks for a retry.
      if (error instanceof CosignRefusal) {
        setProblem(error.reason === 'not-withdrawable' ? 'This co-signature can no longer be withdrawn, so nothing changed.' : 'This invitation is no longer open, so nothing changed.');
        setSigning(null);
        onChanged();
      } else {
        setProblem('Your answer was not sent. Check your connection and try again.');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.section}>
      <Heading level={2}>{t('Co-sign requests')}</Heading>
      {requests.map((request) => {
        const template = templateFor(request);
        const disabled = busy !== null;
        // An open request whose preview did not load is never answered: it
        // offers a retry instead (gate stage 185 on #8738, r1s1).
        const unanswerable = request.status !== 'accepted' && request.previewUnavailable;
        return (
          <Card key={request.formID}>
            <Body>{t(LEAD[request.status], { name: request.filerName })}</Body>
            {request.status !== 'accepted' && changed.has(request.formID) ? (
              <View accessibilityLiveRegion="polite" accessibilityRole="alert">
                <Body>{t('{name} changed this issue report after you opened the request, so you did not co-sign it. The issue shown now is the current one. Read it again, then accept or decline.', { name: request.filerName })}</Body>
              </View>
            ) : null}
            {request.summary ? <Body muted>{t('Issue: {summary}', { summary: request.summary })}</Body> : null}
            {unanswerable ? (
              <>
                <Body>{t('This invitation could not be loaded, so it cannot be answered yet. Try again.')}</Body>
                <Button label={t('Try again')} variant="secondary" disabled={disabled} onPress={onChanged} />
              </>
            ) : null}
            {request.status !== 'accepted' ? <Body muted>{t('You’ll see the full issue report only after you accept.')}</Body> : null}
            {request.status === 'accepted' && !request.grievance ? <Body muted>{t('The issue report details couldn’t be loaded. Try again shortly.')}</Body> : null}
            {request.status === 'accepted' && request.grievance && template ? (
              <>
                <Button label={t('Review issue report')} variant="secondary" onPress={() => setReviewing(reviewing === request.formID ? null : request.formID)} />
                {reviewing === request.formID ? template.steps.flatMap((step) => step.fields).map((field) => {
                  const value = answerText(field, request.grievance?.answers[field.key], t('Checked'), t('Not checked'));
                  return value ? <Body key={field.key}>{`${field.label}: ${value}`}</Body> : null;
                }) : null}
              </>
            ) : null}
            {request.status === 'accepted' && request.grievance?.status === 'approved' ? (
              <Body muted>{t('This issue report was approved, so your co-signature can no longer be withdrawn.')}</Body>
            ) : request.status === 'accepted' ? (
              <Button label={t('Withdraw')} variant="secondary" disabled={disabled} onPress={() => { void act(request, () => withdrawCosign(request.formID, ownerID)); }} />
            ) : null}
            {request.status !== 'accepted' && !unanswerable && signing !== request.formID ? (
              <View style={styles.actions}>
                <Button label={request.status === 'reaffirm_needed' ? t('Re-affirm') : t('Accept')} disabled={disabled} onPress={() => { setSigning(request.formID); setStrokes([]); setConsent(false); }} />
                <Button label={t('Decline')} variant="secondary" disabled={disabled} onPress={() => { void act(request, () => respondToCosign(request.formID, false, null, ownerID)); }} />
              </View>
            ) : null}
            {signing === request.formID && !unanswerable ? (
              <View style={styles.section}>
                <Body muted>{t('Draw your own signature. Union Ground never copies a signature from another form or person.')}</Body>
                <SignaturePad
                  value={strokes}
                  onChange={setStrokes}
                  onDrawingChange={drawingChange}
                  disabled={disabled}
                  label={t('Draw your co-signature')}
                  instructions={t('Draw with one finger inside the box. With VoiceOver or TalkBack on, double-tap and hold, then draw.')}
                  clearLabel={t('Clear signature')}
                  capLabel={t('This co-signature cannot accept any more strokes or points.')}
                />
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={t('I intend this drawing to be my signature on this version of the issue report.')}
                  accessibilityState={{ checked: consent, disabled }}
                  disabled={disabled}
                  onPress={() => { void haptics.select(); setConsent(!consent); }}
                  style={({ pressed }) => [styles.checkRow, { opacity: pressed ? 0.82 : 1 }]}
                >
                  <View style={[styles.checkBox, { borderColor: consent ? theme.primary : theme.mutedForeground, backgroundColor: consent ? theme.primary : 'transparent' }]}>
                    {consent ? <Text style={[styles.checkMark, { color: theme.primaryForeground }]}>✓</Text> : null}
                  </View>
                  <Text style={[styles.checkLabel, { color: theme.foreground }]}>{t('I intend this drawing to be my signature on this version of the issue report.')}</Text>
                </Pressable>
                <View style={styles.actions}>
                  <Button
                    label={busy === request.formID ? t('Signing…') : t('Sign and accept')}
                    disabled={disabled || !consent || !signatureIsSendable(strokes)}
                    // #9460: names only what is missing; drawing or clearing never changes the tick.
                    disabledReason={disabled || (consent && signatureIsSendable(strokes)) ? undefined
                      : !signatureIsSendable(strokes) && !consent ? t('Draw your signature in the box above, then tick the box to confirm it.')
                        : !signatureIsSendable(strokes) ? t('Draw your signature in the box above.')
                          : t('Tick the box above to confirm this drawing is your signature.')}
                    // The request on screen now, whose preview the member is
                    // reading, names the version the co-signature covers.
                    onPress={() => { void act(request, () => respondToCosign(request.formID, true, strokes, ownerID, request.reviewDigest)); }}
                  />
                  <Button label={t('Cancel')} variant="secondary" disabled={disabled} onPress={() => { setSigning(null); setStrokes([]); setConsent(false); }} />
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  checkRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkBox: { width: 24, height: 24, borderWidth: 2, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 15, lineHeight: 18, ...typeface.controlStrong },
  checkLabel: { flex: 1, fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
});
