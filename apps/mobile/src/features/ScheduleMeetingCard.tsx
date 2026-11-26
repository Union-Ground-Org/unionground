import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessWriter, useBusinessState, useBusinessRequests } from '../lib/useBusinessWriter';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { Body, Button, Card, Heading } from '../components/ui';
import {
  createMeetingArgs,
  emptyMeetingDraft,
  MEETING_MAX_LENGTH,
  MEETING_MIN_LENGTH,
  meetingCheckInCode,
  meetingDraftProblem,
  meetingEventId,
  stepMeetingDay,
  stepMeetingLength,
  stepMeetingTime,
  type MeetingDraft,
} from '../lib/chapterMeeting';
import { useNativeUi } from '../lib/useNativeUi';
import { isAuthoritativeReadRefusal, isReadRefusal } from '../lib/readRefusal';
import { useResumeDraftKey, resumeDraftReadsConfirmed, retireResumeDraft, settleResumeDraft, useResumeDraft, writeResumeDraft } from '../lib/resumeDraftHolder';
import type { MeetingResumeDraft } from '../lib/resumeDraftHolder';
import { useApp } from '../state/AppProvider';
import { oneParagraph } from '../../../../src/lib/eventSummary.js';
import { createMobileChapterMeeting, meetingAlreadyExists, meetingRefusal } from '../services/chapterMeetings';
import { haptics } from '../services/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';
import { Stepper } from './AppointmentHoursCard';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

type Outcome = { tone: 'error' | 'status'; text: string } | null;

// expo-crypto is loaded with a plain require at first use (as ReminderPicker
// loads its picker), so every screen that imports this card does not load the
// native module until a meeting is actually scheduled.
function randomBytes(count: number): Uint8Array {
  const crypto = require('expo-crypto') as typeof import('expo-crypto');
  return crypto.getRandomBytes(count);
}

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 1 of 4): the Events desk's "Schedule a meeting" form. A chapter
// officer writes a one-time chapter meeting (title, day, start, length, place,
// what it is about, and a check-in code by default, as the website's form
// does); `onScheduled` reloads the desk so the saved row shows in the list.
export function ScheduleMeetingCard({ onScheduled, freshAccess = true, accessRetired = false, resumeItemID = 'new' }: {
  onScheduled: () => void | boolean | Promise<void | boolean>; freshAccess?: boolean; accessRetired?: boolean; resumeItemID?: string;
}) {
  const writer = useBusinessWriter();
  const { t, locale } = useNativeUi();
  const theme = useTheme();
  const app = useApp();
  const scopeConfirmed = resumeDraftReadsConfirmed(app);
  const resumeKey = useResumeDraftKey(app, 'meeting', resumeItemID);
  // A partial refresh can produce a non-null projection with temporary roles.
  // Remember only a confirmed key; the item id still retires a different form.
  const confirmedKey = scopeConfirmed ? resumeKey : null;
  const lastKey = useRef({ itemID: resumeItemID, id: confirmedKey?.id ?? null });
  const ownerID = confirmedKey?.id ?? (lastKey.current.itemID === resumeItemID ? lastKey.current.id : null) ?? resumeItemID;
  useLayoutEffect(() => {
    if (confirmedKey || lastKey.current.itemID !== resumeItemID) lastKey.current = { itemID: resumeItemID, id: confirmedKey?.id ?? null };
  }, [confirmedKey, resumeItemID]);
  const requests = useBusinessRequests(writer, JSON.stringify([ownerID, accessRetired]));
  const retained = useResumeDraft(resumeKey, freshAccess && !accessRetired);
  const localOwner = useRef(ownerID);
  const sameOwner = true; // local state is already keyed by the confirmed ownerID.
  const [localOpen, setOpen] = useBusinessDraftState(false, ownerID);
  const [localDraft, setDraft] = useBusinessDraftState<MeetingDraft>(() => emptyMeetingDraft(new Date()), ownerID);
  // Keep the starting defaults with the work, so a date/length/check-in-only
  // edit remains meaningful even after a remount or after text is emptied.
  const localDefaults = useRef<MeetingResumeDraft['defaults']>(localDraft);
  const defaults = retained?.value.defaults ?? localDefaults.current;
  localDefaults.current = defaults;
  const [localBusy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof localBusy>(setBusy, false);
  // R-9216b R2: after an attempt whose answer never arrived, the draft is
  // locked. The officer may only try again with the same details, or cancel,
  // so an "event id already exists" answer can only mean this exact draft
  // was saved.
  const [localLocked, setLocked] = useBusinessDraftState(false, ownerID);
  const open = !accessRetired && ((sameOwner && freshAccess && localOpen) || retained !== null);
  const draft = retained?.value.draft ?? (scopeConfirmed && freshAccess && sameOwner ? localDraft : emptyMeetingDraft(new Date()));
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const busy = localBusy || retained?.pending === true;
  const locked = retained?.value.identity?.uncertain ?? (scopeConfirmed && sameOwner && localLocked);
  const frozen = !scopeConfirmed || busy || locked || !freshAccess || accessRetired;
  const [needsRefresh, setNeedsRefresh] = useBusinessDraftState(false, ownerID);
  const [savedCode, setSavedCode] = useBusinessDraftState<string | null>(null, ownerID);
  const [outcome, setOutcome] = useBusinessDraftState<Outcome>(null, ownerID);
  // A second Schedule before React commits busy is refused here.
  const saving = useRef(false);
  // One creation identity per draft (R-9216 R1), as the website's event form
  // keeps its id across failed submits: the event id and check-in code are
  // made on the first Schedule and reused by every retry, so a save whose
  // response was lost cannot create a second meeting. `uncertain` marks that
  // an earlier attempt with this id may have been saved.
  const identity = useRef<{ id: string; code: string; uncertain: boolean } | null>(null);
  useEffect(() => {
    if (scopeConfirmed) return;
    const empty = emptyMeetingDraft(new Date()); localDefaults.current = empty;
    identity.current = null; setDraft(empty); setLocked(false); setOutcome(null);
  }, [scopeConfirmed]);
  useEffect(() => {
    const owner = ownerID;
    if (localOwner.current === owner) return;
    localOwner.current = owner; identity.current = null;
    const empty = emptyMeetingDraft(new Date()); localDefaults.current = empty;
    // Each confirmed owner keeps its own local draft and receipt.
  }, [ownerID]);
  useEffect(() => {
    if (accessRetired) {
      retireResumeDraft(resumeKey); identity.current = null;

      setDraft(emptyMeetingDraft(new Date())); setOpen(false); setLocked(false); setOutcome(null);
    }
  }, [accessRetired, resumeKey]);

  function change(patch: Partial<MeetingDraft>) {
    if (frozen) return;
    const next = { ...latestDraft.current, ...patch };
    latestDraft.current = next;
    setOpen(true);
    setDraft(next);
    setOutcome(null);
    const value: MeetingResumeDraft = { draft: next, defaults, identity: retained?.value.identity ?? identity.current, warning: null };
    if (next.title || next.location || next.summary || next.startsAt.getTime() !== defaults.startsAt.getTime()
      || next.lengthMinutes !== defaults.lengthMinutes || next.checkIn !== defaults.checkIn) writeResumeDraft(resumeKey, value);
    else retireResumeDraft(resumeKey);
  }

  function start() {
    if (!scopeConfirmed || !freshAccess || accessRetired || busy) return;
    retireResumeDraft(resumeKey);
    identity.current = null;
    setLocked(false);
    const empty = emptyMeetingDraft(new Date()); localDefaults.current = empty;
    setDraft(empty);
    setOutcome(null);
    setOpen(true);
  }

  async function confirmList(current: () => boolean, code: string | null) {
    try {
      const refreshed = await onScheduled();
      if (!current() || refreshed === false) return false;
      setNeedsRefresh(false);
      setOutcome({ tone: 'status', text: t('Meeting scheduled. It is in the list below.')
        + (code ? ` ${t('Check-in code: {code}', { code })}` : '') });
      return true;
    } catch {
      if (current()) setOutcome({ tone: 'status', text: t('Meeting scheduled. Refresh to see it in the list.')
        + (code ? ` ${t('Check-in code: {code}', { code })}` : '') });
      return false;
    }
  }

  async function refresh() {
    await operate(true, async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current') await confirmList(current, savedCode);
    });
  }

  async function schedule() {
    await operate(true, async () => {
    if (!scopeConfirmed || saving.current || busy || !freshAccess || accessRetired) return;
    const current = requests.capture().isCurrent;
    if (!current()) return;
    const problem = meetingDraftProblem(draft, new Date());
    if (problem) {
      setOutcome({ tone: 'error', text: problemText(problem) });
      return;
    }
    identity.current = retained?.value.identity ?? identity.current;
    identity.current ??= { id: meetingEventId(draft.startsAt, randomBytes(8)), code: meetingCheckInCode(randomBytes(6)), uncertain: false };
    const held = identity.current;
    const ticket = writeResumeDraft(resumeKey, { draft, defaults, identity: held, warning: null }, true);
    if (resumeKey && !ticket) return;
    saving.current = true;

    setOutcome(null);
    const code = draft.checkIn ? held.code : null;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      try {
        await createMobileChapterMeeting(writer, createMeetingArgs(draft, held.id, code, timezone));
      } catch (error) {
        // The RPC refuses an id that already exists. After an attempt whose
        // answer never arrived, that refusal means the earlier save landed.
        if (!(held.uncertain && meetingAlreadyExists(error))) throw error;
      }
      setDraft(emptyMeetingDraft(new Date())); setLocked(false); setOpen(false);
      setNeedsRefresh(true); setSavedCode(code);
      setOutcome({ tone: 'status', text: t('Meeting scheduled. Refresh to see it in the list.') + (code ? ` ${t('Check-in code: {code}', { code })}` : '') });
      if (ticket) settleResumeDraft(ticket, null);
      const proof = await checkBusinessContinuation(writer, current);
      if (!current() || proof === 'changed') return;
      if (proof === 'current') identity.current = null;
      setDraft(emptyMeetingDraft(new Date()));
      setLocked(false);
      if (proof === 'current') void haptics.success();
      setOpen(false);
      if (proof === 'current') await confirmList(current, code);
    } catch (error) {
      // A refusal the server named was not saved; anything else may have been.
      // Ledger 714: the writer's own refusal before sending, never a copied
      // marker, which would hide an earlier save that landed.
      const sessionRefused = error instanceof WriterSessionChanged && businessRpcProvenance(error) === null;
      const refused = isAuthoritativeReadRefusal(error);
      const uncertain = !sessionRefused && !refused && (held.uncertain || (!isReadRefusal(error) && meetingRefusal(error) === null && !meetingAlreadyExists(error)));
      const warning = uncertain
        ? 'We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.'
        : 'The meeting could not be scheduled. Try again.';
      if (uncertain) {
        held.uncertain = true;
      }
      if (ticket && !settleResumeDraft(ticket, refused ? null : { draft, defaults, identity: held, warning })) return;
      if (!current()) return;
      setDraft(refused ? emptyMeetingDraft(new Date()) : draft);
      if (refused) identity.current = null;
      setLocked(uncertain);
      setOutcome({
        tone: 'error',
        text: uncertain
          ? t('We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.')
          : meetingRefusal(error) === 'role'
          ? t('Your role cannot schedule meetings for this campaign.')
          : meetingRefusal(error) === 'chapter'
            ? t('This account is not in a campaign, so it cannot schedule a campaign meeting. Ask a campaign administrator to add you to your campaign.')
            : t('The meeting could not be scheduled. Try again.'),
      });
    } finally {
      saving.current = false;
    }

    });
  }

  function problemText(problem: NonNullable<ReturnType<typeof meetingDraftProblem>>): string {
    if (problem === 'title') return t('Give the meeting a title of 3 to 120 characters.');
    if (problem === 'past') return t('Pick a time that has not passed.');
    if (problem === 'location') return t('Add where the meeting is, up to 120 characters.');
    return t('Add what the meeting is about, up to 500 characters.');
  }

  const dayText = draft.startsAt.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  // The meeting is set on the phone's clock and saved with the phone's zone
  // (p_timezone), so the time names that zone.
  const timeText = draft.startsAt.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const lengthText = t('{minutes} min', { minutes: draft.lengthMinutes });
  const context = `${dayText} ${timeText}`;
  const inputStyle = [styles.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }];
  const heldWarning = retained?.value.warning;
  const outcomeView = heldWarning ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t(heldWarning)}</Body> : scopeConfirmed && sameOwner && outcome
    ? <Body accessibilityRole={outcome.tone === 'error' ? 'alert' : undefined} style={outcome.tone === 'error' ? { color: theme.destructive } : undefined}>{outcome.text}</Body>
    : null;

  return (
    <Card>
      <Heading level={3}>{t('Campaign meetings')}</Heading>
      <Body muted>{t('Workers of your campaign see it in Meetings and can RSVP.')}</Body>
      {needsRefresh ? <Button label={t('Refresh')} disabled={busy || !scopeConfirmed || accessRetired} variant="secondary" onPress={() => void refresh()} /> : null}
      {!open ? <>
        {outcomeView}
        <Button label={t('Schedule a meeting')} disabled={busy || !scopeConfirmed || !freshAccess || accessRetired} onPress={start} />
      </> : <>
        <TextInput
          accessibilityLabel={t('Meeting title')}
          value={draft.title}
          onChangeText={(title) => change({ title })}
          placeholder={t('Meeting title')}
          placeholderTextColor={theme.quietForeground}
          keyboardAppearance={theme.appearance}
          maxLength={120}
          editable={!frozen}
          style={inputStyle}
        />
        <Stepper label={t('Day')} value={dayText} earlier={t('Earlier day')} later={t('Later day')} context={context} disabled={frozen}
          onEarlier={() => change({ startsAt: stepMeetingDay(draft.startsAt, -1) })} onLater={() => change({ startsAt: stepMeetingDay(draft.startsAt, 1) })} />
        <Stepper label={t('Starts')} value={timeText} earlier={t('Start earlier')} later={t('Start later')} context={context} disabled={frozen}
          onEarlier={() => change({ startsAt: stepMeetingTime(draft.startsAt, -1) })} onLater={() => change({ startsAt: stepMeetingTime(draft.startsAt, 1) })} />
        <Stepper label={t('Length')} value={lengthText} earlier={t('Shorter')} later={t('Longer')} context={context} disabled={frozen}
          onEarlier={() => change({ lengthMinutes: stepMeetingLength(draft.lengthMinutes, -1) })}
          onLater={() => change({ lengthMinutes: stepMeetingLength(draft.lengthMinutes, 1) })} />
        {draft.lengthMinutes <= MEETING_MIN_LENGTH || draft.lengthMinutes >= MEETING_MAX_LENGTH
          ? <Body muted>{t('Meetings run 15 minutes to 12 hours.')}</Body> : null}
        <TextInput
          accessibilityLabel={t('Location, room, or meeting link')}
          value={draft.location}
          onChangeText={(location) => change({ location })}
          placeholder={t('Union hall, Room 204, or a meeting link')}
          placeholderTextColor={theme.quietForeground}
          keyboardAppearance={theme.appearance}
          maxLength={120}
          editable={!frozen}
          style={inputStyle}
        />
        <TextInput
          accessibilityLabel={t('What the meeting is about')}
          value={draft.summary}
          onChangeText={(summary) => change({ summary: oneParagraph(summary) })}
          placeholder={t('What the meeting is about')}
          placeholderTextColor={theme.quietForeground}
          keyboardAppearance={theme.appearance}
          maxLength={500}
          multiline
          editable={!frozen}
          style={[...inputStyle, styles.summary]}
        />
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.foreground }]}>{t('Workers check in with a code')}</Text>
          <DisabledStateBoundary disabled={frozen} accessibilityRole="switch" accessibilityLabel={`${t('Workers check in with a code')}, ${busy ? t('Saving…') : t('Try again or cancel')}`} checked={draft.checkIn}>
            <Switch
              style={styles.switch}
              accessibilityLabel={t('Workers check in with a code')}
              accessibilityState={{ disabled: frozen, busy }}
              value={draft.checkIn}
              disabled={frozen}
              onValueChange={(checkIn) => change({ checkIn })}
              trackColor={{ false: theme.muted, true: theme.primary }}
              thumbColor={draft.checkIn ? theme.primaryForeground : theme.mutedForeground}
            />
          </DisabledStateBoundary>
        </View>
        {outcomeView}
        <View style={styles.actions}>
          <Button label={t('Schedule meeting')} busy={busy} disabled={!scopeConfirmed || busy || !freshAccess || accessRetired} onPress={() => { void schedule(); }} />
          <Button label={t('Cancel')} variant="secondary" disabled={busy} onPress={() => { retireResumeDraft(resumeKey); identity.current = null; setDraft(emptyMeetingDraft(new Date())); setLocked(false); setOpen(false); setOutcome(null); }} />
        </View>
      </>}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { flexShrink: 1, fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  switch: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16 },
  summary: { minHeight: 96, paddingTop: spacing.sm, textAlignVertical: 'top' },
});
