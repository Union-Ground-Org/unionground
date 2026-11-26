import { useBusinessRequests, useBusinessWriter } from '../lib/useBusinessWriter';
import { useNativeUi } from '../lib/useNativeUi';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../components/ui';
import { canOpenFeature } from '../lib/featureCatalog';
import { explicitLiveStaffHat } from '../lib/hatFunctions';
import { appointmentRangeLabel } from '../lib/appointmentBooking';
import { haptics } from '../services/haptics';
import {
  calendarExportWasSaved,
  exportToDeviceCalendar,
  isCalendarExportAvailable,
} from '../services/nativeCalendarExport';
import {
  loadMobileAppointmentHistory,
  loadMobileAppointments,
  loadMobileSupervisedAppointments,
  prepareAuthorizedAppointmentCalendarExport,
  type MobileAppointment,
  type MobileAppointmentHistory,
} from '../services/supabase';
import {
  APPOINTMENT_CARD_ACCESSIBILITY_HINT,
  appointmentCardAccessibilityLabel,
  appointmentCardDetailLine,
} from '../lib/appointmentCardAccessibility';
import { offersAppointmentCalendarExport } from '../lib/calendarExportOffer';
import { appointmentHistoryFailureText, calendarExportFailureText } from '../lib/calendarExportFailure';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { useApp } from '../state/AppProvider';
import { AppointmentBookingCard } from './AppointmentBookingCard';
import { AppointmentHoursCard } from './AppointmentHoursCard';
import type { StatusState } from '../theme/statusRamp';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
function appointmentStatusState(status: MobileAppointment['status']): StatusState {
  if (status === 'completed') return 'done';
  if (status === 'cancelled' || status === 'no_show') return 'attention';
  return 'active';
}

function appointmentEventState(action: string): StatusState {
  if (action === 'completed') return 'done';
  if (action === 'cancelled' || action === 'no_show' || action === 'reassigned') return 'attention';
  if (action === 'booked' || action === 'rescheduled') return 'queued';
  return 'active';
}

export function LiveAppointmentsFeature() {
  const { catalogLabel, locale, t } = useNativeUi();
  const theme = useTheme();
  const { dashboard, authorizedRoles, chapterRoles, organizationRoles, captureAuthenticatedSessionGuard, mode, sampleHat, liveSampleBackend } = useApp();
  const chapterID = dashboard?.member.chapterID;
  const activeRole = explicitLiveStaffHat(authorizedRoles);
  const canSupervise = activeRole !== null && ['coordinator', 'advisor', 'admin'].includes(activeRole);
  // #9082: booking hours for an account the steward appointment desk admits
  // (set_appointment_windows still checks the steward role), and booking for
  // everyone reading their own appointments.
  const canSetHours = canOpenFeature(mode, 'steward-appointments', null, chapterRoles, organizationRoles);
  const [appointments, setAppointments] = useState<MobileAppointment[] | null>(null);
  const [history, setHistory] = useState<MobileAppointmentHistory | null>(null);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [calendarBusy, setCalendarBusy] = useState(false);
  // The error card is not a live region, so a failed calendar handoff is spoken on both platforms.
  const announceCalendarFailure = useAccessibilityAnnouncementQueue('appointments-calendar');
  const announceHistoryFailure = useAccessibilityAnnouncementQueue('appointments-history');
  // Ledger 807: a failure line still waiting to be spoken belongs to the
  // history that failed; opening another one, or reloading the list, cancels it.
  const cancelHistoryAnnouncement = useRef<(() => void) | null>(null);
  const historyRequest = useRef(0);
  const calendarReady = useMemo(() => isCalendarExportAvailable(), []);
  // Item 4 of the calendar-export record: SAMPLE/PREVIEW fixtures never offer
  // export into a real device calendar.
  const calendarOffer = useMemo(() => ({
    mode, sampleHat, liveSampleBackend, calendarReady,
  }), [calendarReady, liveSampleBackend, mode, sampleHat]);
  const appointmentSections = useMemo(() => {
    const referenceTime = Date.now();
    const items = appointments ?? [];
    return {
      upcoming: items.filter((item) => item.status === 'confirmed' && Date.parse(item.startsAt) >= referenceTime),
      pastOrClosed: items.filter((item) => item.status !== 'confirmed' || Date.parse(item.startsAt) < referenceTime),
    };
  }, [appointments]);
  async function addToCalendar(item: MobileAppointment) {
    setCalendarBusy(true);
    setError(null);
    try {
      const sessionStillCurrent = captureAuthenticatedSessionGuard();
      const payload = await prepareAuthorizedAppointmentCalendarExport(item.id, Date.now());
      const result = await exportToDeviceCalendar(payload, sessionStillCurrent);
      if (result === 'unavailable') setError('No calendar app on this phone could take that one-on-one.');
      else if (calendarExportWasSaved(result)) void haptics.success();
    } catch (failure) {
      const copy = catalogLabel(calendarExportFailureText(failure, 'appointment'));
      setError(copy);
      announceCalendarFailure(copy);
    } finally {
      setCalendarBusy(false);
    }
  }
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, canSupervise);
  const appointmentReads = useRef(0);
  const refreshAppointments = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++appointmentReads.current;
    const active = () => at === appointmentReads.current && ticket.isCurrent();
    historyRequest.current += 1;
    cancelHistoryAnnouncement.current?.();
    cancelHistoryAnnouncement.current = null;
    setAppointments(null);
    setSelectedID(null);
    setHistory(null);
    setHistoryHasMore(false);
    setHistoryBusy(false);
    setError(null);
    setLoadFailed(false);
    try {
      const items = await (canSupervise ? loadMobileSupervisedAppointments() : loadMobileAppointments());
      if (!active()) return false;
      setAppointments(items);
      return true;
    } catch {
      if (active()) { setLoadFailed(true); setError('One-on-ones could not be refreshed.'); }
      return false;
    }
  }, [canSupervise, chapterID, requests]);
  useEffect(() => { void refreshAppointments(); return () => { appointmentReads.current += 1; }; }, [refreshAppointments, reload]);
  async function openHistory(id: string) {
    const request = ++historyRequest.current;
    cancelHistoryAnnouncement.current?.();
    cancelHistoryAnnouncement.current = null;
    setSelectedID(id);
    setHistory(null);
    setHistoryHasMore(false);
    setError(null);
    try {
      const nextHistory = await loadMobileAppointmentHistory(id);
      if (request === historyRequest.current) {
        setHistory(nextHistory);
        setHistoryHasMore(Boolean(nextHistory.nextBefore && nextHistory.nextBeforeID));
      }
    } catch (failure) {
      if (request !== historyRequest.current) return;
      const copy = catalogLabel(appointmentHistoryFailureText(failure));
      setError(copy);
      cancelHistoryAnnouncement.current = announceHistoryFailure(copy);
    }
  }
  async function loadOlderHistory() {
    const appointmentID = selectedID;
    const cursor = history?.nextBefore && history.nextBeforeID
      ? { createdAt: history.nextBefore, id: history.nextBeforeID }
      : null;
    if (!appointmentID || !cursor || historyBusy || !historyHasMore) return;
    const request = historyRequest.current;
    setHistoryBusy(true);
    setError(null);
    try {
      const older = await loadMobileAppointmentHistory(appointmentID, cursor);
      if (request !== historyRequest.current) return;
      setHistory((current) => current ? {
        ...current,
        items: [...current.items, ...older.items.filter((item) => !current.items.some((existing) => existing.id === item.id))],
        nextBefore: older.nextBefore,
        nextBeforeID: older.nextBeforeID,
      } : older);
      setHistoryHasMore(Boolean(older.nextBefore && older.nextBeforeID));
    } catch {
      if (request === historyRequest.current) setError('Older one-on-one history could not be loaded.');
    } finally {
      if (request === historyRequest.current) setHistoryBusy(false);
    }
  }
  function appointmentCards(items: MobileAppointment[]) {
    return items.map((item) => {
      // The heading and the accessible name share one formatted appointment range, so
      // what VoiceOver and TalkBack speak is exactly what the card paints.
      const scheduleLabel = appointmentRangeLabel(item.startsAt, item.endsAt, locale) ?? t('Time unavailable');
      return (
        // Add to calendar is a sibling of the history control, never inside it, so a
        // screen reader reaches it as its own focus target instead of swallowing it
        // into the card-wide history button.
        //
        // A labelled button hides its children from the accessibility tree, so the
        // button's own name carries the type, status, date and time the sighted
        // reader sees (iPhone device window 9 finding); the verb lives in the hint.
        <Card key={item.id}>
          <Pressable accessibilityRole="button" accessibilityLabel={appointmentCardAccessibilityLabel(item, canSupervise, scheduleLabel)} accessibilityHint={APPOINTMENT_CARD_ACCESSIBILITY_HINT} onPress={() => { void openHistory(item.id); }}>
            {({ pressed }) => <View style={{ opacity: pressed ? 0.82 : 1 }}>
              <View style={styles.workChipRow}>
                <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.appointmentType.replaceAll('_', ' ')}</Text>
                <StatusPill label={item.status.replaceAll('_', ' ')} state={appointmentStatusState(item.status)} />
              </View>
              <Heading level={3}>{scheduleLabel}</Heading>
              <Body muted>{appointmentCardDetailLine(item, canSupervise)} · View history</Body>
            </View>}
          </Pressable>
          {offersAppointmentCalendarExport(calendarOffer, item, Date.now()) ? <View style={styles.workChipRow}><Button label="Add to calendar" variant="secondary" disabled={calendarBusy} onPress={() => { void addToCalendar(item); }} /></View> : null}
        </Card>
      );
    });
  }
  return (
    <Screen>
      <Heading>{catalogLabel('One-on-ones')}</Heading>
      <Body muted>{canSupervise ? 'Upcoming and past campaign meetings with an authorized supervisor history.' : 'Upcoming and past meetings with a participant-visible lifecycle.'} Calendar gaps never reveal private busy reasons.</Body>
      {error ? <Card><Body style={{ color: theme.destructive }}>{error}</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card> : null}
      {canSetHours ? <AppointmentHoursCard t={t} /> : null}
      {canSupervise ? null : <AppointmentBookingCard t={t} locale={locale} onBooked={refreshAppointments} />}
      {appointments === null && !loadFailed ? <StateMessage title="Loading one-on-ones" body="Loading your one-on-ones." /> : appointments === null ? null : appointments.length === 0 ? <StateMessage title="No one-on-ones" body="Booked meetings will appear here." /> : (
        <>
          {appointmentSections.upcoming.length ? <Heading level={2}>Upcoming</Heading> : null}
          {appointmentCards(appointmentSections.upcoming)}
          {appointmentSections.pastOrClosed.length ? <Heading level={2}>Past &amp; closed</Heading> : null}
          {appointmentCards(appointmentSections.pastOrClosed)}
        </>
      )}
      {selectedID && history === null && !error ? <StateMessage title="Loading history" body="Reading the paginated audit trail." /> : null}
      {history ? <Card><Heading level={3}>One-on-one history</Heading><Body muted>Latest meeting first.</Body>{history.items.length === 0 ? <Body muted>No lifecycle meetings were recorded.</Body> : history.items.map((item, index) => <View key={item.id} style={styles.timelineRow}><View style={[styles.timelineDot, { backgroundColor: theme.primary }]} /><View style={styles.flex}><StatusPill label={item.action.replaceAll('_', ' ')} state={appointmentEventState(item.action)} /><Body muted>{item.actorKind === 'member' ? 'worker' : item.actorKind.replaceAll('-', ' ')} · {appointmentRangeLabel(item.createdAt, null, locale) ?? t('Time unavailable')}</Body>{index < history.items.length - 1 ? <View style={[styles.timelineLine, { backgroundColor: theme.border }]} /> : null}</View></View>)}{historyHasMore ? <Button label={historyBusy ? 'Loading older…' : 'Load older history'} disabled={historyBusy} variant="secondary" onPress={() => { void loadOlderHistory(); }} /> : null}</Card> : null}
      <Card>
        <View style={styles.workChipRow}>
          <Heading level={3}>Expanded booking</Heading>
          <View style={[styles.liveStatus, { backgroundColor: theme.muted }]}><Text style={[styles.liveStatusText, { color: theme.mutedForeground }]}>planned</Text></View>
        </View>
        <Body muted>Multi-attendee scheduling and additional meeting formats are not active. Current participant one-on-ones and their audit history remain available here.</Body>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  workChipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between' },
  flex: { flex: 1 },
  liveStatus: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  liveStatusText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, textTransform: 'capitalize' },
  timelineRow: { minHeight: 58, flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  timelineLine: { position: 'absolute', left: -17, top: 23, bottom: -15, width: StyleSheet.hairlineWidth },
});
