import { useBusinessWriter, useBusinessState, useBusinessRequests, useBusinessSubjectState, useBusinessOperationCache } from '../lib/useBusinessWriter';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useCallback, useEffect } from 'react';
import { Body, Button, Card, Heading } from '../components/ui';
import { queueAccessibilityAnnouncement } from '../lib/announce';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { useTheme } from '../theme/ThemeProvider';
import { assignCaseSteward, caseAssignmentRefusal, loadCaseAssignment, type CaseAssignmentRefusal, type CaseAssignmentState } from '../services/caseAssignment';

// What the server's refusal means, in the coordinator's language (
//  part 2); an unknown failure keeps the generic line.
const LOAD_REFUSAL_TEXT: Record<CaseAssignmentRefusal, NativeUiKey> = {
  'not-allowed': 'Your role or two-step verification doesn’t allow issue assignment right now. Work as Campaign lead with two-step verification complete, then try again.',
  'not-found': 'This issue is no longer available to you.',
  'out-of-scope': 'Eligible assignees couldn’t be loaded.',
  failed: 'Eligible assignees couldn’t be loaded.',
};
const SAVE_REFUSAL_TEXT: Record<CaseAssignmentRefusal, NativeUiKey> = {
  'not-allowed': 'Your role or two-step verification doesn’t allow this assignment right now. Nothing was changed.',
  'not-found': 'This issue is no longer available to you. Nothing was changed.',
  'out-of-scope': 'That committee member is outside this issue’s scope or no longer holds the committee member role. Nothing was changed.',
  failed: 'The assignment couldn’t be saved. Nothing was changed.',
};

// BUG-UG-NATIVE-COORDINATOR-ROLE-SHOWS-NO-CASE-QUEUE-20261118 (,
// part 2): the website's Case assignment form (CoordinatorView CaseAssignment)
// on the phone, for the steward: the eligible stewards the server lists, an
// explicit Unassigned choice and the same confirmation before saving. After a
// save, onSaved hands the case screen its updated_case access-history entry
// ('s recordCaseAccess), which the screen writes, reports and retries as
// it does for every staff change. Only the coordinator hat opens it; the
// server still decides who may write and whom.
export function CaseStewardAssignment({ caseID, onSaved }: { caseID: string; onSaved?: () => void | Promise<void> }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, caseID);
  const { t } = useNativeUi();
  const theme = useTheme();
  const [state, setState] = useBusinessSubjectState<{ caseID: string; value: CaseAssignmentState | null; refusal: CaseAssignmentRefusal | null }>(caseID, { caseID, value: null, refusal: null });
  const [accepted, setAccepted] = useBusinessSubjectState<CaseAssignmentState | null>(caseID, null);
  const reads = useBusinessOperationCache(`assignment-reads:${caseID}`, () => ({ current: 0 }));
  const [refreshing, setRefreshing] = useBusinessSubjectState(caseID, false);
  const [reload, setReload] = useBusinessState(0);
  const [choice, setChoice] = useBusinessSubjectState<{ caseID: string; steward: string | null } | null>(caseID, null);
  const [confirmed, setConfirmed] = useBusinessSubjectState(caseID, false);
  const [busy, setBusy] = useBusinessState(false);
  const [message, setMessage] = useBusinessSubjectState<{ caseID: string; key: NativeUiKey; error: boolean; steward?: string | null } | null>(caseID, null);
  // Refuses a second press before React commits the busy state.
  const [writing] = useBusinessState(() => ({ current: false }));

  const read = useCallback(async () => {
    const generation = ++reads.current;
    const ticket = requests.capture();
    try {
      const value = await loadCaseAssignment(caseID);
      if (generation !== reads.current || !ticket.isCurrent()) return;
      setState({ caseID, value, refusal: null });
      setAccepted(null);
      setMessage(current => current?.caseID === caseID && current.key === 'Assignment saved. Refresh to see it.'
        ? { ...current, key: 'Assignment saved.' } : current);
    } catch (error) {
      if (generation === reads.current && ticket.isCurrent()) setState({ caseID, value: null, refusal: caseAssignmentRefusal(error) });
    }
  }, [caseID, reads, requests, setState, setAccepted, setMessage]);
  useEffect(() => {
    setState({ caseID, value: null, refusal: null });
    void read();
    return () => { reads.current += 1; };
  }, [caseID, reload, read, reads, setState]);

  async function refresh() {
    if (writing.current || refreshing) return;
    const ticket = requests.capture();
    writing.current = true; setBusy(true);
    setRefreshing(true);
    try {
      if (await checkBusinessContinuation(writer, ticket.isCurrent) === 'current') await read();
    } finally { writing.current = false; setBusy(false); setRefreshing(false); }
  }

  const current = state.caseID === caseID ? state : { caseID, value: null, refusal: null };
  const shownMessage = message?.caseID === caseID ? message : null;
  const assignment = accepted ?? current.value;
  if (current.refusal && !assignment) {
    return <Card><Heading level={2}>{t('Issue assignment')}</Heading>
      <Body accessibilityRole="alert">{t(LOAD_REFUSAL_TEXT[current.refusal])}</Body>
      <Button label={t('Try again')} variant="secondary" onPress={() => setReload((value) => value + 1)} />
    </Card>;
  }
  if (!assignment) return <Card><Heading level={2}>{t('Issue assignment')}</Heading><Body muted>{t('Loading eligible assignees…')}</Body></Card>;
  const selected = choice?.caseID === caseID ? choice.steward : assignment.stewardUserID;
  const changed = selected !== assignment.stewardUserID;
  const currentSteward = assignment.stewards.find((person) => person.userId === assignment.stewardUserID);
  const currentName = assignment.stewardUserID
    ? currentSteward ? currentSteward.fullName ?? t('Unnamed committee member') : t('A committee member outside your list')
    : t('Unassigned');
  const pick = (steward: string | null) => { setChoice({ caseID, steward }); setConfirmed(false); setMessage(null); };

  async function save() {
    if (writing.current || !changed || !confirmed) return;
    const ticket = requests.capture();
    let accepted = false;
    writing.current = true; setBusy(true); setMessage(null);
    try {
      await assignCaseSteward(writer, caseID, selected);
      accepted = true;
      reads.current += 1;
      setAccepted({ ...assignment!, stewardUserID: selected });
      setMessage({ caseID, key: 'Assignment saved. Refresh to see it.', error: false, steward: selected });
      setChoice(null); setConfirmed(false);
      if (!ticket.isCurrent()) return;
      const proof = await writer.check();
      if (!ticket.isCurrent() || proof !== 'current') return;
      await onSaved?.();
      if (!ticket.isCurrent()) return;
      setMessage({ caseID, key: 'Assignment saved.', error: false });
      queueAccessibilityAnnouncement(t('Assignment saved.'));
      setChoice(null); setConfirmed(false); await read();
    } catch (error) {
      if (!ticket.isCurrent() || accepted) return;
      setMessage({ caseID, error: true, key: SAVE_REFUSAL_TEXT[caseAssignmentRefusal(error)] });
    } finally {
      writing.current = false; setBusy(false);
    }
  }

  return <Card>
    <Heading level={2}>{t('Issue assignment')}</Heading>
    <Body>{t('Assigned committee member: {name}', { name: currentName })}</Body>
    <Heading level={3}>{t('Choose the committee member')}</Heading>
    <Button label={t('Unassigned')} variant="secondary" selected={selected === null} disabled={busy} onPress={() => pick(null)} />
    {assignment.stewards.map((person) => <Button key={person.userId} label={person.fullName ?? t('Unnamed committee member')} variant="secondary" selected={selected === person.userId} disabled={busy} onPress={() => pick(person.userId)} />)}
    {assignment.stewards.length === 0 ? <Body muted>{t('No eligible committee members for this issue.')}</Body> : null}
    {changed ? <Button label={t('I confirm this assignment is correct for this issue.')} variant="secondary" selected={confirmed} disabled={busy} onPress={() => setConfirmed((value) => !value)} /> : null}
    <Button label={busy && !refreshing ? t('Saving assignment…') : t('Save assignment')} busy={busy} disabled={!changed || !confirmed} onPress={() => { void save(); }} />
    {shownMessage ? <Body accessibilityRole={shownMessage.error ? 'alert' : undefined} style={shownMessage.error ? { color: theme.destructive } : undefined}>{t(shownMessage.key)}</Body> : null}
    {current.refusal ? <Body accessibilityRole="alert">{t(LOAD_REFUSAL_TEXT[current.refusal])}</Body> : null}
    {accepted ? <Button label={t('Refresh the issue')} variant="secondary" disabled={busy || refreshing} onPress={() => { void refresh(); }} /> : null}
  </Card>;
}
