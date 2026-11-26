import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessWriter, useBusinessState, useBusinessRequests } from '../lib/useBusinessWriter';
import { useEffect, useRef } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { Text } from '../components/Text';

import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { Body, Button, Card, Heading, StatusPill } from '../components/ui';
import {
  appointmentWindowsProblem,
  minuteLabel,
  nextNewWindow,
  scheduleZoneName,
  sortWindows,
  stepWeekday,
  stepWindow,
  WEEKDAY_NAMES,
  type AppointmentWindow,
} from '../lib/appointmentBooking';
import type { NativeUiText } from '../lib/nativeUiCopy';
import { haptics } from '../services/haptics';
import { isPermissionRefusal, saveMobileAppointmentAccepting, saveMobileAppointmentWindows } from '../services/appointmentBooking';
import { loadMobileStewardAppointmentsDesk, type LivedInStewardAppointmentsDesk } from '../services/livedIn';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

type SavedHours = { accepting: boolean | null; timezone: string | null; windows: AppointmentWindow[] };
type DeskAvailability = LivedInStewardAppointmentsDesk['availability'];

function savedHours(availability: DeskAvailability): SavedHours {
  return {
    accepting: availability.accepting,
    timezone: availability.timezone,
    windows: sortWindows(availability.windows.map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute }))),
  };
}
type Outcome = { tone: 'error' | 'status'; text: string } | null;

// BUG-UG-NATIVE-IOS-APPOINTMENTS-NO-HOURS-OR-BOOKING-20261117 (#9082):
// a steward sets weekly booking hours from Appointments, as the website's
// Steward desk > Appointments > Availability sheet does. What the card shows
// is always the server's copy, read again after every save.
// BUG-UG-NATIVE-STEWARD-DESK-APPOINTMENTS-HAS-NO-HOURS-EDITOR-20261118
// (#9100): the steward desk's Appointments shows this same card, seeded with
// the availability its own desk read already holds (`initial`), so both
// screens edit and show the same saved windows.
export function AppointmentHoursCard({ t, initial }: { t: NativeUiText; initial?: DeskAvailability }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const theme = useTheme();
  const [saved, setSaved] = useBusinessDraftState<SavedHours | null>(() => (initial ? savedHours(initial) : null));
  // The first read is skipped only when the caller handed over its own copy.
  const seeded = useRef(initial !== undefined);
  const [loadFailed, setLoadFailed] = useBusinessDraftState(false);
  const [reload] = useBusinessDraftState(0);
  const [editing, setEditing] = useBusinessDraftState(false);
  const [draft, setDraft] = useBusinessDraftState<AppointmentWindow[]>([]);
  const [accepting, setAccepting] = useBusinessDraftState(true);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [outcome, setOutcome] = useBusinessDraftState<Outcome>(null);
  // A second Save before React commits busy is refused here.

  const reads = useRef(0);
  const [refreshing, setRefreshing] = useBusinessState(false);
  const [needsRefresh, setNeedsRefresh] = useBusinessDraftState(false);
  async function reread() {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++reads.current;
    setLoadFailed(false);
    try {
      const desk = await loadMobileStewardAppointmentsDesk();
      if (at !== reads.current || !ticket.isCurrent()) return false;
      setSaved(savedHours(desk.availability)); setNeedsRefresh(false);
      setOutcome(previous => previous?.tone === 'status' ? { tone: 'status', text: t('Booking hours saved.') }
        : previous ? { ...previous, text: previous.text.replace(' ' + t('Reopen this screen to see it.'), '') } : previous);
      return true;
    } catch { if (at === reads.current && ticket.isCurrent()) setLoadFailed(true); return false; }
  }
  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    void reread();
    return () => { reads.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, requests, setSaved, setLoadFailed]);
  async function refresh() {
    await operate(true, async () => {
      setRefreshing(true);
      try { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await reread(); }
      finally { setRefreshing(false); }
    });
  }

  function startEditing() {
    if (!saved) return;
    setDraft(saved.windows.map((window) => ({ ...window })));
    setAccepting(saved.accepting ?? true);
    setOutcome(null);
    setEditing(true);
  }

  function update(index: number, next: AppointmentWindow) {
    setDraft((windows) => windows.map((window, at) => (at === index ? next : window)));
  }

  async function save() {
    await operate(true, async () => {
    if (!saved) return;
    const current = requests.capture().isCurrent;
    const problem = appointmentWindowsProblem(draft);
    if (problem) {
      setOutcome({ tone: 'error', text: problem === 'overlap' ? t('Hours on the same day must not overlap.') : t('Each window needs an end at least 20 minutes after its start, on the same day. Use at most 28 windows.') });
      return;
    }

    setOutcome(null);
    let windowsSaved = false;
    try {
      await saveMobileAppointmentWindows(writer, sortWindows(draft));
      windowsSaved = true;
      if (current()) reads.current += 1;
      setNeedsRefresh(true);
      setSaved({ ...saved, windows: sortWindows(draft) });
      if (accepting !== (saved.accepting ?? true)) { await saveMobileAppointmentAccepting(writer, accepting); setSaved({ ...saved, windows: sortWindows(draft), accepting }); }
      if (await writer.isCurrent() && current()) void haptics.success();
      setEditing(false);
      setOutcome({ tone: 'status', text: t('Booking hours saved.') });
    } catch (error) {
      setOutcome({
        tone: 'error',
        text: windowsSaved
          ? t('Your hours were saved, but taking bookings could not be changed. Try again.')
          : isPermissionRefusal(error)
            ? t('This account cannot set booking hours. Sign in with a committee member account and try again.')
            : t('Booking hours could not be saved. Try again.'),
      });
    } finally {
      // Read the server's copy again whatever happened, so the card never
      // shows hours the server does not hold.
      try {
        if (windowsSaved) await settleBusinessWrite(writer, {
          current, accepted: () => {},
          stale: () => setOutcome((previous) => previous?.tone === 'error'
            ? { ...previous, text: `${previous.text} ${t('Reopen this screen to see it.')}` }
            : { tone: 'status', text: t(BUSINESS_SAVED_STALE) }),
          refresh: reread,
        });
      } finally {  }
    }

    });
  }

  const outcomeView = outcome
    ? <Body accessibilityRole={outcome.tone === 'error' ? 'alert' : undefined} style={outcome.tone === 'error' ? { color: theme.destructive } : undefined}>{outcome.text}</Body>
    : null;

  return (
    <Card>
      <View style={styles.row}>
        <Heading level={3}>{t('Your booking hours')}</Heading>
        {saved ? <StatusPill label={saved.accepting === false ? t('Paused') : t('Taking bookings')} state={saved.accepting === false ? 'attention' : 'active'} /> : null}
      </View>
      <Body muted>{t('Weekly windows workers can book with you.')}</Body>
      {needsRefresh ? <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void refresh()} /> : null}
      {saved && !loadFailed ? <Body muted>{scheduleZoneLine(t, saved.timezone)}</Body> : null}
      {loadFailed ? <>
        <Body style={{ color: theme.destructive }}>{t('Your booking hours could not be read.')}</Body>
        <Button label={t('Try again')} variant="secondary" disabled={busy} onPress={() => void refresh()} />
      </> : saved === null ? <Body muted>{t('Loading your booking hours…')}</Body> : !editing ? <>
        {saved.windows.length === 0
          ? <Body muted>{t('No weekly hours yet. Workers cannot book you until you add some.')}</Body>
          : saved.windows.map((window) => <Body key={`${window.weekday}-${window.startMinute}-${window.endMinute}`}>{dayLabel(t, window.weekday)} · {minuteLabel(window.startMinute)}–{minuteLabel(window.endMinute)}</Body>)}
        {outcomeView}
        <Button disabled={busy} label={t('Set booking hours')} onPress={startEditing} />
      </> : <>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.foreground }]}>{t('Workers can book time with me')}</Text>
          <DisabledStateBoundary disabled={busy} accessibilityRole="switch" accessibilityLabel={`${t('Workers can book time with me')}, ${t('Saving…')}`} checked={accepting}>
            <Switch
              style={styles.switch}
              accessibilityLabel={t('Workers can book time with me')}
              accessibilityState={{ disabled: busy, busy }}
              value={accepting}
              disabled={busy}
              onValueChange={setAccepting}
              trackColor={{ false: theme.muted, true: theme.primary }}
              thumbColor={accepting ? theme.primaryForeground : theme.mutedForeground}
            />
          </DisabledStateBoundary>
        </View>
        {draft.length === 0 ? <Body muted>{t('No weekly hours yet. Workers cannot book you until you add some.')}</Body> : null}
        {draft.map((window, index) => {
          const name = `${dayLabel(t, window.weekday)} ${minuteLabel(window.startMinute)}–${minuteLabel(window.endMinute)}`;
          return (
            <View key={index} style={[styles.window, { borderColor: theme.border }]}>
              <Text style={[styles.label, { color: theme.foreground }]}>{dayLabel(t, window.weekday)} · {minuteLabel(window.startMinute)}–{minuteLabel(window.endMinute)}</Text>
              <Stepper label={t('Day')} value={dayLabel(t, window.weekday)} earlier={t('Earlier day')} later={t('Later day')} context={name} disabled={busy}
                onEarlier={() => update(index, stepWeekday(window, -1))} onLater={() => update(index, stepWeekday(window, 1))} />
              <Stepper label={t('Starts')} value={minuteLabel(window.startMinute)} earlier={t('Start earlier')} later={t('Start later')} context={name} disabled={busy}
                onEarlier={() => update(index, stepWindow(window, 'start', -1))} onLater={() => update(index, stepWindow(window, 'start', 1))} />
              <Stepper label={t('Ends')} value={minuteLabel(window.endMinute)} earlier={t('End earlier')} later={t('End later')} context={name} disabled={busy}
                onEarlier={() => update(index, stepWindow(window, 'end', -1))} onLater={() => update(index, stepWindow(window, 'end', 1))} />
              <Button label={t('Remove these hours')} accessibilityLabel={`${t('Remove these hours')}: ${name}`} variant="secondary" disabled={busy}
                onPress={() => setDraft((windows) => windows.filter((_, at) => at !== index))} />
            </View>
          );
        })}
        {draft.length < 28 ? <Button label={t('Add hours')} variant="secondary" disabled={busy} onPress={() => setDraft((windows) => [...windows, nextNewWindow(windows)])} /> : null}
        {outcomeView}
        <View style={styles.actions}>
          <Button label={t('Save hours')} busy={busy && !refreshing} onPress={() => { void save(); }} disabled={Boolean(busy)} />
          <Button label={t('Cancel')} variant="secondary" disabled={busy} onPress={() => { setEditing(false); setOutcome(null); }} />
        </View>
      </>}
    </Card>
  );
}

/** The schedule's own zone. With no schedule yet, the first save takes the profile's zone or Eastern, as set_appointment_windows does. */
function scheduleZoneLine(t: NativeUiText, zone: string | null): string {
  if (!zone) return t('Your first save uses the time zone on your profile, or Eastern time if none is set.');
  const name = scheduleZoneName(zone);
  return name ? t('Hours are in {zone} ({id}).', { zone: t(name), id: zone }) : t('Hours are in the {id} time zone.', { id: zone });
}

function dayLabel(t: NativeUiText, weekday: number): string {
  const name = WEEKDAY_NAMES[weekday];
  return name ? t(name) : `${weekday}`;
}

export function Stepper({ label, value, earlier, later, context, disabled, onEarlier, onLater }: {
  label: string; value: string; earlier: string; later: string; context: string; disabled: boolean;
  onEarlier: () => void; onLater: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stepper}>
      <Text style={[styles.stepperLabel, { color: theme.mutedForeground }]}>{label}</Text>
      <View style={styles.stepperControls}>
        <Button label="−" accessibilityLabel={`${earlier}: ${context}`} variant="secondary" disabled={disabled} onPress={onEarlier} />
        <Text style={[styles.stepperValue, { color: theme.foreground }]}>{value}</Text>
        <Button label="+" accessibilityLabel={`${later}: ${context}`} variant="secondary" disabled={disabled} onPress={onLater} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { flexShrink: 1, fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  switch: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget },
  window: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  stepperLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperValue: { minWidth: 96, textAlign: 'center', fontSize: 15, lineHeight: 21, ...typeface.controlStrong, fontVariant: ['tabular-nums'] },
});
