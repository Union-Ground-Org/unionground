import { useBusinessWriter, useBusinessState, useBusinessRequests, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { DateTimeField } from '../components/DateTimeField';
import { Text, TextInput } from '../components/Text';
import { Body, Button, Card, Heading } from '../components/ui';
import { useNativeUi } from '../lib/useNativeUi';
import { useRetainedDraft, type RetainedAttempt } from '../lib/retainedDraft';
import { withReadDeadline } from '../lib/readDeadline';
import {
  CASE_DRAFT_SCOPE, CASE_RETRY_REFUSED, caseRefusalOutcome, caseWriteRefusedBeforeSending, coordinatorContactSurface, coordinatorDeadlineSurface, coordinatorNoteSurface, useCaseDraftOwner,
  type CoordinatorContactDraft, type CoordinatorDeadlineDraft, type CoordinatorNoteDraft,
} from './caseRetainedDrafts';
import type { MemberCaseDetail } from '../models/member';
import {
  CHANGE_REASON_MAX,
  CONTACT_DIRECTIONS,
  CONTACT_SUMMARY_MAX,
  CONTACT_TYPES,
  COORDINATOR_NOTE_MAX,
  CoordinatorWriteError,
  addCoordinatorCaseNote,
  calendarDay,
  caseDeadlineChangeProblem,
  coordinatorContactProblem,
  coordinatorNoteProblem,
  extendCaseDeadline,
  logCoordinatorCaseContact,
  type ContactDirection,
  type ContactType,
  type CoordinatorWriteFailure,
} from '../services/coordinatorCaseWrites';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

type Saved = 'note' | 'contact' | 'deadline';
// refreshing: saved, the case is being read again; saved: the reread shows it;
// stale: saved, but the reread failed (as the other case cards). The case
// screen's onChanged first writes the updated_case access-history entry
// (#9120) and shows its own notice when that entry could not be logged.
type Status = { kind: 'ready' }
  | { kind: 'refreshing' | 'saved' | 'stale'; saved: Saved }
  | { kind: 'failed'; reason: CoordinatorWriteFailure };

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
// (#9091), part 4: the coordinator's case writes on the phone, the twin of the
// website's coordinator case panel: Add case note, Log contact and a later
// case deadline with a reason for the change.
// onRefresh only rereads: the Refresh retry after a saved write uses it, so
// the write's updated_case entry is written once (review R-9239 rule).
//
// #9240 pull request E: the note, the contact (type, direction, time,
// summary) and the new deadline with its reason wait in memory through a
// session check (caseRetainedDrafts.ts). The case screen mounts this card only
// on a case it holds; the card shows held text from its first settled render
// on, never on the render that mounted it. A refused deadlines or steps read
// on the same case retires everything held for it. A write in flight keeps its
// form locked and settles after an unmount: saved, it is gone; refused, it
// All three are new rows or changes with no key, so a write that may have gone
// through (no answer, the 20-second deadline, any answer, whatever code or text
// it carries) stays locked as unconfirmed, with Save again and Discard, and is
// never sent again on its own; only the session writer's own refusal before
// sending returns it as editable text (caseWriteRefusedBeforeSending). Each
// form's input is checked before an attempt begins. Leaving the
// case for another discards what it holds.
const EMPTY_NOTE: CoordinatorNoteDraft = { note: '' };
const EMPTY_CONTACT: CoordinatorContactDraft = { contactType: 'phone', direction: 'outbound', contactedAt: null, summary: '' };
const EMPTY_DEADLINE: CoordinatorDeadlineDraft = { deadline: null, reason: '' };

export function CoordinatorCaseWritesCard({ caseID, currentDeadline, onChanged, onRefresh }: {
  caseID: string;
  currentDeadline: string | null;
  onChanged: () => Promise<MemberCaseDetail | null>;
  onRefresh: () => Promise<MemberCaseDetail | null>;
}) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, caseID);
  const { t } = useNativeUi();
  const theme = useTheme();
  const [busy, setBusy] = useBusinessState(false);
  const [writing] = useBusinessState(() => ({ current: false }));
  const [status, setStatus] = useBusinessSubjectState<Status>(caseID, { kind: 'ready' });
  const [settled, setSettled] = useState(false);
  useEffect(() => { setSettled(true); }, []);
  const notes = useRetainedDraft<CoordinatorNoteDraft>({ surface: coordinatorNoteSurface, item: caseID, empty: EMPTY_NOTE, fresh: settled, scope: CASE_DRAFT_SCOPE });
  const contact = useRetainedDraft<CoordinatorContactDraft>({ surface: coordinatorContactSurface, item: caseID, empty: EMPTY_CONTACT, fresh: settled, scope: CASE_DRAFT_SCOPE });
  const change = useRetainedDraft<CoordinatorDeadlineDraft>({ surface: coordinatorDeadlineSurface, item: caseID, empty: EMPTY_DEADLINE, fresh: settled, scope: CASE_DRAFT_SCOPE });
  const { note } = notes.value;
  const { contactType, direction, contactedAt, summary } = contact.value;
  const { deadline, reason } = change.value;
  useCaseDraftOwner(caseID);
  // Locked: sending, or unconfirmed (Save again and Discard only).
  const noteLocked = notes.pending !== false;
  const contactLocked = contact.pending !== false;
  const deadlineLocked = change.pending !== false;
  const [unconfirmed, setUnconfirmed] = useBusinessSubjectState<Saved | null>(caseID, null);
  const [acceptedDeadline, setAcceptedDeadline] = useBusinessSubjectState<{ from: string | null; value: string | null } | null>(caseID, null);
  const baselineDeadline = acceptedDeadline?.from === currentDeadline ? acceptedDeadline.value : currentDeadline;
  useEffect(() => {
    if (acceptedDeadline && acceptedDeadline.from !== currentDeadline) setAcceptedDeadline(null);
  }, [currentDeadline, acceptedDeadline, setAcceptedDeadline]);


  function showReread(saved: Saved, fresh: MemberCaseDetail | null) {
    if (fresh) {
      setUnconfirmed(null);
      setAcceptedDeadline({ from: currentDeadline, value: fresh.item.deadline });
    }
    setStatus({ kind: fresh ? 'saved' : 'stale', saved });
  }

  async function refresh(saved: Saved) {
    if (writing.current) return;
    const ticket = requests.capture();
    writing.current = true; setBusy(true);
    try {
      if (await checkBusinessContinuation(writer, ticket.isCurrent) !== 'current') return;
      setStatus({ kind: 'refreshing', saved });
      const fresh = await onRefresh();
      showReread(saved, ticket.isCurrent() ? fresh : null);
    } finally { writing.current = false; setBusy(false); }
  }

  // The attempt is begun by the caller in the press's own turn, after the
  // same refusal checks, so a second press finds it pending.
  const writeRefused = () => writing.current || status.kind === 'refreshing';

  // retrying: Save again from an unconfirmed write; a refusal of it keeps the lock.
  async function write<T>(saved: Saved, attempt: RetainedAttempt<T>, action: (value: T) => Promise<void>, clear: () => void = () => {}, retrying = false) {
    if (writing.current || status.kind === 'refreshing') return;
    const ticket = requests.capture();
    let accepted = false;
    writing.current = true;
    setBusy(true);
    try {
      try { await withReadDeadline(action(attempt.value)); }
      catch (error) {
        if (!caseWriteRefusedBeforeSending(error)) {
          // It may have saved: locked as unconfirmed until Save again or Discard.
          attempt.settle('uncertain');
          if (ticket.isCurrent()) setStatus({ kind: 'ready' });
          return;
        }
        attempt.settle(caseRefusalOutcome(retrying));
        if (retrying) { if (ticket.isCurrent()) setStatus({ kind: 'ready' }); return; }
        throw error;
      }
      attempt.settle('done');
      accepted = true;
      setUnconfirmed(saved);
      clear();
      setStatus({ kind: 'stale', saved });
      if (!ticket.isCurrent()) return;
      const proof = await writer.check();
      if (!ticket.isCurrent() || proof !== 'current') return;
      setStatus({ kind: 'refreshing', saved });
      // Keep the lock through the receipt and the guarded reread.
      const fresh = await onChanged();
      showReread(saved, ticket.isCurrent() ? fresh : null);
    } catch (error) {
      if (accepted || ticket.isCurrent()) setStatus(accepted ? { kind: 'stale', saved } : { kind: 'failed', reason: error instanceof CoordinatorWriteError ? error.reason : 'failed' });
    } finally {
      writing.current = false; setBusy(false);
    }
  }

  const failureText = (reason: CoordinatorWriteFailure): string => {
    switch (reason) {
      case 'coordinatorRole': return t('Only a campaign lead can make this change, so nothing was saved.');
      case 'unavailable': return t('This issue is no longer available to you, so nothing was saved.');
      case 'mfa': return t('This change needs two-step verification on this account, so nothing was saved.');
      case 'stepUp': return t('Sign in with your password to change this issue. Nothing was saved.');
      case 'refused': return t('You can’t change this issue, so nothing was saved.');
      case 'noteInvalid': return t('Write a note of 1 to 4,000 characters.');
      case 'contactInvalid': return t('Choose a contact type and direction and write a summary of 1 to 2,000 characters.');
      case 'contactTime': return t('Choose when the contact happened; it can’t be in the future.');
      case 'deadlineEarlier': return t('The new deadline can’t be earlier than the current one. Choose a later date.');
      case 'reasonInvalid': return t('Give a reason for the change of 1 to 1,000 characters.');
      case 'invalid': return t('That change was not accepted, so nothing was saved.');
      case 'failed': return t('The issue was not saved. Try again in a moment.');
    }
  };
  const savedText = (saved: Saved): string => ({ note: t('Issue note saved.'), contact: t('Contact logged.'), deadline: t('Issue deadline changed.') })[saved];
  // A write that failed after the card was unmounted says why once it is back.
  const heldFailure = ([notes.failed, contact.failed, change.failed].find((failed) => failed && failed !== CASE_RETRY_REFUSED) ?? null) as CoordinatorWriteFailure | null;
  const retryRefused = (pending: string | false, failed: string | null) => pending === 'uncertain' && failed === CASE_RETRY_REFUSED
    ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Save again was refused before it was sent. The first save is still unconfirmed, so it stays locked.')}</Body> : null;
  const message = status.kind === 'ready' && heldFailure ? failureText(heldFailure)
    : status.kind === 'failed' ? failureText(status.reason)
    : status.kind === 'ready' ? null
      : status.kind === 'saved' ? savedText(status.saved)
        : status.kind === 'refreshing' ? t('Saved. Updating the issue…')
          : `${savedText(status.saved)} ${t('This screen could not be refreshed. Refresh the issue to see the change.')}`;
  const good = status.kind === 'saved' || status.kind === 'refreshing';
  const typeLabel = (value: ContactType) => ({ phone: t('Phone'), email: t('Email'), meeting: t('Meeting'), letter: t('Letter'), other: t('Other') })[value];
  const directionLabel = (value: ContactDirection) => ({ outbound: t('Outbound'), inbound: t('Inbound'), internal: t('Internal') })[value];
  const input = [styles.textInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }];

  return (
    <Card>
      <Heading level={2}>{t('Campaign lead issue changes')}</Heading>

      {!notes.shown ? <Body muted>{t('Loading your work')}</Body> : <>
      <View style={styles.form}>
        <Heading level={3}>{t('Add an issue note')}</Heading>
        <TextInput accessibilityLabel={t('Issue note')} multiline maxLength={COORDINATOR_NOTE_MAX} editable={!busy && !noteLocked} keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={note} onChangeText={(value) => notes.set({ note: value })} style={[...input, styles.multiline]} />
        {notes.pending === 'uncertain' ? <Body accessibilityRole="alert">{t('We could not confirm this issue note was saved. Check the issue timeline first: saving it again may add it twice.')}</Body> : null}
        <Button label={notes.pending === 'sending' ? t('Saving…') : notes.pending === 'uncertain' ? t('Save again') : t('Add issue note')} busy={busy || notes.pending === 'sending'} onPress={() => {
          if (writeRefused()) return;
          const problem = coordinatorNoteProblem(note);
          if (problem) { setStatus({ kind: 'failed', reason: problem }); return; }
          const retrying = notes.pending === 'uncertain';
          const attempt = notes.begin();
          if (attempt) void write('note', attempt, (value) => addCoordinatorCaseNote(writer, caseID, value.note), undefined, retrying);
        }} />
        {retryRefused(notes.pending, notes.failed)}
        {notes.pending === 'uncertain' ? <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => { notes.discard(); }} /> : null}
      </View>

      <View style={styles.form}>
        <Heading level={3}>{t('Log a contact with the employer or others')}</Heading>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Contact type')}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t('Contact type')} style={styles.options}>
          {CONTACT_TYPES.map((value) => <Button key={value} label={typeLabel(value)} variant={contactType === value ? 'primary' : 'secondary'} selected={contactType === value} disabled={busy || contactLocked} onPress={() => contact.set({ contactType: value })} />)}
        </View>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Direction')}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t('Direction')} style={styles.options}>
          {CONTACT_DIRECTIONS.map((value) => <Button key={value} label={directionLabel(value)} variant={direction === value ? 'primary' : 'secondary'} selected={direction === value} disabled={busy || contactLocked} onPress={() => contact.set({ direction: value })} />)}
        </View>
        <DateTimeField label={t('Contacted at')} value={contactedAt} disabled={busy || contactLocked} onChange={(value) => contact.set({ contactedAt: value })} />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Contact summary')}</Text>
        <TextInput accessibilityLabel={t('Contact summary')} multiline maxLength={CONTACT_SUMMARY_MAX} editable={!busy && !contactLocked} keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={summary} onChangeText={(value) => contact.set({ summary: value })} style={[...input, styles.multiline]} />
        {contact.pending === 'uncertain' ? <Body accessibilityRole="alert">{t('We could not confirm this contact was logged. Check the issue timeline first: logging it again may add it twice.')}</Body> : null}
        <Button label={contact.pending === 'sending' ? t('Saving…') : contact.pending === 'uncertain' ? t('Save again') : t('Log contact')} busy={busy || contact.pending === 'sending'} onPress={() => {
          if (writeRefused()) return;
          if (!contactedAt) { setStatus({ kind: 'failed', reason: 'contactTime' }); return; }
          const problem = coordinatorContactProblem({ summary, contactedAt });
          if (problem) { setStatus({ kind: 'failed', reason: problem }); return; }
          const retrying = contact.pending === 'uncertain';
          const attempt = contact.begin();
          // As before, the chosen type and direction stay for the next contact.
          if (attempt) void write('contact', attempt, (value) => logCoordinatorCaseContact(writer, { caseID, type: value.contactType, direction: value.direction, summary: value.summary, contactedAt: value.contactedAt ?? contactedAt }),
            () => { contact.set({ contactType: attempt.value.contactType, direction: attempt.value.direction }); }, retrying);
        }} />
        {retryRefused(contact.pending, contact.failed)}
        {contact.pending === 'uncertain' ? <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => { contact.discard(); }} /> : null}
      </View>

      <View style={styles.form}>
        <Heading level={3}>{t('Change the issue deadline')}</Heading>
        <DateTimeField label={t('Next deadline')} mode="date" value={deadline} disabled={busy || deadlineLocked} onChange={(value) => change.set({ deadline: value })} />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Reason for change')}</Text>
        <TextInput accessibilityLabel={t('Reason for change')} multiline maxLength={CHANGE_REASON_MAX} editable={!busy && !deadlineLocked} keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={reason} onChangeText={(value) => change.set({ reason: value })} style={[...input, styles.multiline]} />
        {change.pending === 'uncertain' ? <Body accessibilityRole="alert">{t('We could not confirm the issue deadline was changed. Check the issue’s deadline first: saving it again may record the change twice.')}</Body> : null}
        <Button label={change.pending === 'sending' ? t('Saving…') : change.pending === 'uncertain' ? t('Save again') : t('Save the new deadline')} busy={busy || change.pending === 'sending'} onPress={() => {
          if (writeRefused()) return;
          if (!deadline) { setStatus({ kind: 'failed', reason: 'deadlineEarlier' }); return; }
          const problem = caseDeadlineChangeProblem({ currentDeadline: baselineDeadline, deadline, reason });
          if (problem) { setStatus({ kind: 'failed', reason: problem }); return; }
          const retrying = change.pending === 'uncertain';
          const attempt = change.begin();
          const chosen = attempt?.value.deadline ?? deadline;
          if (attempt) void write('deadline', attempt, (value) => extendCaseDeadline(writer, { caseID, currentDeadline: baselineDeadline, deadline: chosen, reason: value.reason }),
            () => { setAcceptedDeadline({ from: currentDeadline, value: calendarDay(chosen) }); }, retrying);
        }} />
        {retryRefused(change.pending, change.failed)}
        {change.pending === 'uncertain' ? <Button label={t('Discard')} variant="secondary" disabled={busy} onPress={() => { change.discard(); }} /> : null}
      </View>
      </>}

      {message ? (
        <View accessibilityLiveRegion="polite">
          <Body style={good ? undefined : { color: theme.destructive }}>{message}</Body>
        </View>
      ) : null}
      {unconfirmed || status.kind === 'stale' ? <Button label={t('Refresh the issue')} variant="secondary" disabled={busy || status.kind === 'refreshing'} onPress={() => { void refresh(unconfirmed ?? (status.kind === 'stale' ? status.saved : 'note')); }} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  options: { gap: spacing.sm },
  textInput: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
  multiline: { minHeight: minimumTouchTarget * 2, paddingVertical: spacing.sm, textAlignVertical: 'top' },
});
