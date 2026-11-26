import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { useBusinessWriter, useBusinessState, useBusinessRequests, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import { Body, Button, Card, Heading } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { useRetainedDraft } from '../lib/retainedDraft';
import { withReadDeadline } from '../lib/readDeadline';
import { CASE_DRAFT_SCOPE, CASE_RETRY_REFUSED, caseNoteSurface, caseRefusalOutcome, caseWriteRefusedBeforeSending, useCaseDraftOwner } from './caseRetainedDrafts';
import { STEWARD_CASE_NOTE_MAX, addStewardCaseNote, stewardCaseNoteProblem, type StewardCaseNoteFailure } from '../services/stewardCaseNote';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

// refreshing: saved, the case is being read again; shown: the reread holds the
// saved note; saved: the reread succeeded but its timeline window does not
// hold the note, so the card says only that it was saved, as the website does
// (review R-9228, P2-2); stale: saved, but the reread failed (
// 8b9d97d8), so the card never says the note is in the timeline.
export type StewardNoteReread = 'shown' | 'saved' | 'stale';
type Status = 'ready' | 'refreshing' | StewardNoteReread | StewardCaseNoteFailure;

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
//, part 1: the steward's note on a case assigned to them, the phone
// twin of the website steward case dialog's note form. A saved note goes into
// the case history, so the screen reloads the case and the note shows in the
// case timeline here and on the website. The screen draws it only on a case
// assigned to this steward (useAssignedStewardCase). onSaved gets the saved
// note's id, records the update once and rereads. onRefresh only rereads;
// both answer whether the reread shows the saved note.
//
//  pull request E: the unsent note waits in memory through a session
// check (src/features/caseRetainedDrafts.ts). The case screen mounts this card
// only on a case it holds and, for the steward, after this route generation's
// assignment read; the card shows held text from its first settled render on,
// never on the render that mounted it. A save in flight keeps the note locked
// and settles after an unmount: saved, the note is gone. The note is a new
// row with no key, so a save that may have gone through (no answer, the
// 20-second deadline, any answer, whatever code or text it carries) stays
// locked as unconfirmed, with Save again and Discard, and is never sent again
// on its own; only the session writer's own refusal before sending returns it
// as editable text (caseWriteRefusedBeforeSending). Leaving the case for another
// discards it. One save at a time: a second press in the same turn finds the
// attempt already begun (ledger 551).
export function StewardCaseNoteCard({ caseID, onSaved, onRefresh }: {
  caseID: string;
  onSaved: (noteID: string | null) => Promise<StewardNoteReread>;
  onRefresh: (noteID: string | null) => Promise<StewardNoteReread>;
}) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, caseID);
  const { t } = useNativeUi();
  const theme = useTheme();
  const [settled, setSettled] = useState(false);
  useEffect(() => { setSettled(true); }, []);
  const draft = useRetainedDraft<{ body: string }>({ surface: caseNoteSurface, item: caseID, empty: { body: '' }, fresh: settled, scope: CASE_DRAFT_SCOPE });
  useCaseDraftOwner(caseID);
  const body = draft.value.body;
  const sending = draft.pending === 'sending';
  const uncertain = draft.pending === 'uncertain';
  const [operation, setOperation] = useBusinessState<'save' | 'refresh' | null>(null);
  const busy = operation !== null;
  const [operate, control] = useBusinessOperation<'save' | 'refresh' | null>(setOperation, null);
  const [status, setStatus] = useBusinessSubjectState<Status>(caseID, 'ready');
  const [savedNoteID, setSavedNoteID] = useBusinessSubjectState<string | null>(caseID, null);
  const [unconfirmed, setUnconfirmed] = useBusinessSubjectState(caseID, false);

  async function reread(noteID: string | null) {
    await operate('refresh', async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) !== 'current') return;
      setStatus('refreshing');
      // Refresh never records an update; a failed reread answers 'stale'.
      const status = await onRefresh(noteID);
      setStatus(current() ? status : 'stale');
      if (current() && status !== 'stale') setUnconfirmed(false);
    });
  }

  async function save() {
    const current = requests.capture().isCurrent;
    // control: a save or Refresh already holds the card, even in this turn.
    if (busy || control.current || status === 'refreshing' || !draft.shown || sending) return;
    // Checked before an attempt begins: nothing is sent for an invalid note.
    const problem = stewardCaseNoteProblem(body);
    if (problem) {
      setStatus(problem);
      return;
    }
    // Save again from an unconfirmed save: a refusal of this retry keeps the lock.
    const retrying = uncertain;
    // Begun in the press's own turn: a second press finds it pending.
    const attempt = draft.begin();
    if (!attempt) return;
    await operate('save', async () => {
      let saved = false;
      let noteID: string | null = null;
      try {
        noteID = await withReadDeadline(addStewardCaseNote(writer, caseID, attempt.value.body));
        saved = true;
        attempt.settle('done');
        setSavedNoteID(noteID);
        setUnconfirmed(true);
        setStatus('saved');
      } catch (error) {
        // Refused before sending: a first save comes back to edit; a refused
        // Save again stays locked beside the earlier unconfirmed save. Anything
        // else may have saved.
        const refused = caseWriteRefusedBeforeSending(error);
        attempt.settle(refused ? caseRefusalOutcome(retrying) : 'uncertain');
        setStatus(refused && !retrying ? 'failed' : 'ready');
      }
      // The only receipt-writing callback call: the acknowledged save.
      if (saved) {
        const proof = await checkBusinessContinuation(writer, current);
        if (proof === 'changed') return;
        if (proof === 'unavailable') { setStatus('stale'); return; }
        setStatus('refreshing');
        const status = await onSaved(noteID);
        setStatus(current() ? status : 'stale');
        if (current() && status !== 'stale') setUnconfirmed(false);
      }
    });
  }

  // A save that failed after the card was unmounted says why once it is back.
  const shownStatus: Status = status === 'ready' && draft.failed && draft.failed !== CASE_RETRY_REFUSED ? draft.failed as StewardCaseNoteFailure : status;
  const message = shownStatus === 'shown' ? t('Issue note saved. It is in the issue timeline.')
    : shownStatus === 'saved' ? t('Issue note saved.')
    : shownStatus === 'refreshing' ? t('Issue note saved. Updating the issue timeline…')
      : shownStatus === 'stale' ? t('Issue note saved, but the issue timeline could not be updated. Refresh the issue to see it.')
        : shownStatus === 'invalid' ? t('Write a note of 1 to 4,000 characters.')
          : shownStatus === 'notYours' ? t('This issue is not assigned to you as committee member, so the note was not saved.')
            : shownStatus === 'stewardRole' ? t('Adding an issue note needs the Committee role and two-step verification on this account, so the note was not saved.')
              : shownStatus === 'stepUp' ? t('Sign in with your password to add an issue note. The note was not saved.')
                : shownStatus === 'refused' ? t('Your access to this issue was refused, so the note was not saved.')
                  : shownStatus === 'failed' ? t('Your issue note was not saved. Try again in a moment.')
                    : null;
  const good = status === 'shown' || status === 'saved' || status === 'refreshing';

  return (
    <Card>
      <Heading level={2}>{t('Add an issue note')}</Heading>
      <Body muted>{t('Notes go into the issue history. The worker, their committee member, the campaign’s committee members and campaign leads can read them.')}</Body>
      {draft.shown ? <>
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Issue note')}</Text>
        <TextInput
          accessibilityLabel={t('Issue note')}
          multiline
          maxLength={STEWARD_CASE_NOTE_MAX}
          editable={!busy && !sending && !uncertain}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={body}
          onChangeText={(value) => {
            draft.set({ body: value });
            if (status !== 'ready' && status !== 'refreshing' && status !== 'stale') setStatus('ready');
          }}
          style={[styles.textInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
      </View>
      {uncertain ? <Body accessibilityRole="alert">{t('We could not confirm this issue note was saved. Check the issue timeline first: saving it again may add it twice.')}</Body> : null}
      {uncertain && draft.failed === CASE_RETRY_REFUSED ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Save again was refused before it was sent. The first save is still unconfirmed, so it stays locked.')}</Body> : null}
      <Button label={operation === 'save' || sending ? t('Saving…') : uncertain ? t('Save again') : t('Save issue note')} busy={busy || sending || status === 'refreshing'} onPress={() => { void save(); }} />
      {uncertain ? <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => { draft.discard(); setStatus('ready'); }} /> : null}
      </> : <Body muted>{t('Loading your work')}</Body>}
      {message ? (
        <View accessibilityLiveRegion="polite">
          <Body style={good ? undefined : { color: theme.destructive }}>{message}</Body>
        </View>
      ) : null}
      {unconfirmed || status === 'stale' ? <Button label={t('Refresh the issue')} variant="secondary" disabled={busy || status === 'refreshing'} onPress={() => { void reread(savedNoteID); }} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  textInput: {
    minHeight: minimumTouchTarget * 2,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
});
