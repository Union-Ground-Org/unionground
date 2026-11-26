import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading } from '../components/ui';
import {
  APPOINTMENT_DURATIONS,
  APPOINTMENT_TYPE_LABELS,
  APPOINTMENT_TYPES,
  bookingPlaceProblem,
  bookingRefusal,
  easternDayLabel,
  easternTimeLabel,
  PLACE_MAX_LENGTH,
  slotSearchSpan,
  slotsByEasternDay,
  type AppointmentDuration,
  type AppointmentSlot,
  type AppointmentType,
  type BookingRefusal,
} from '../lib/appointmentBooking';
import type { NativeUiKey, NativeUiText } from '../lib/nativeUiCopy';
import { haptics } from '../services/haptics';
import {
  bookMobileAppointment,
  loadMobileAppointmentSlots,
  loadMobileBookableStewards,
  type MobileBookableSteward,
} from '../services/appointmentBooking';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

type Outcome = { tone: 'error' | 'status'; text: string } | null;

// BUG-UG-NATIVE-IOS-APPOINTMENTS-NO-HOURS-OR-BOOKING-20261117 (#9082):
// the website's booking flow (src/views/AppointmentsView.jsx BookingWizard) on
// the phone: pick what it is about, how long, and who; pick an open time from
// the server's next two weeks; say where; confirm. The phone never computes
// availability, and a refused booking sends the member back to the times.
export function AppointmentBookingCard({ t, locale, onBooked }: { t: NativeUiText; locale: 'en-US' | 'es-US'; onBooked: () => void | boolean | Promise<void | boolean> }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, null);
  const theme = useTheme();
  const [open, setOpen] = useBusinessDraftState(false);
  const [type, setType] = useBusinessDraftState<AppointmentType | null>(null);
  const [duration, setDuration] = useBusinessDraftState<AppointmentDuration>(30);
  const [stewardId, setStewardId] = useBusinessDraftState<string | null>(null);
  const [stewards, setStewards] = useBusinessDraftState<MobileBookableSteward[] | null>(null);
  const [stewardsFailed, setStewardsFailed] = useBusinessDraftState(false);
  const [stewardsReload, setStewardsReload] = useBusinessDraftState(0);
  const [slots, setSlots] = useBusinessDraftState<AppointmentSlot[] | null>(null);
  const [slotsFailed, setSlotsFailed] = useBusinessDraftState(false);
  const [slotsReload, setSlotsReload] = useBusinessDraftState(0);
  const [dayKey, setDayKey] = useBusinessDraftState<string | null>(null);
  const [slot, setSlot] = useBusinessDraftState<string | null>(null);
  const [place, setPlace] = useBusinessDraftState('');
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [needsRefresh, setNeedsRefresh] = useBusinessDraftState(false);
  const [outcome, setOutcome] = useBusinessDraftState<Outcome>(null);

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    setStewards(null);
    setStewardsFailed(false);
    void loadMobileBookableStewards()
      .then((rows) => { if (current) setStewards(rows); })
      .catch(() => { if (current) setStewardsFailed(true); });
    return () => { current = false; };
  }, [open, stewardsReload, setStewards, setStewardsFailed]);

  const canSearch = open && type !== null && stewards !== null && stewards.length > 0;
  useEffect(() => {
    if (!canSearch || type === null) return undefined;
    let current = true;
    setSlots(null);
    setSlotsFailed(false);
    setSlot(null);
    const span = slotSearchSpan(new Date());
    void loadMobileAppointmentSlots({ type, duration, from: span.from, to: span.to, stewardId })
      .then((rows) => { if (current) setSlots(rows); })
      .catch(() => { if (current) setSlotsFailed(true); });
    return () => { current = false; };
  }, [canSearch, type, duration, stewardId, slotsReload, setSlots, setSlotsFailed, setSlot]);

  const days = useMemo(() => slotsByEasternDay(slots ?? []), [slots]);
  const activeDay = days.find((day) => day.key === dayKey) ?? days[0] ?? null;

  function reset() {
    setOpen(false);
    setType(null);
    setDuration(30);
    setStewardId(null);
    setSlots(null);
    setDayKey(null);
    setSlot(null);
    setPlace('');
  }

  async function confirmList(current: () => boolean) {
    try {
      const refreshed = await onBooked();
      if (!current() || refreshed === false) return false;
      setNeedsRefresh(false);
      setOutcome({ tone: 'status', text: t('Booked. Your one-on-one is in the list below.') });
      return true;
    } catch {
      if (current()) setOutcome({ tone: 'status', text: t('Booked. Refresh to see it in the list.') });
      return false;
    }
  }

  async function refresh() {
    await operate(true, async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current') await confirmList(current);
    });
  }

  async function confirm() {
    await operate(true, async () => {
    const current = requests.capture().isCurrent;
    if (type === null || slot === null) return;
    const placeProblem = bookingPlaceProblem(place);
    if (placeProblem) {
      setOutcome({ tone: 'error', text: placeProblem === 'missing' ? t('Add where the one-on-one will happen.') : t('Keep the place under 300 characters.') });
      return;
    }

    setOutcome(null);
    try {
      await bookMobileAppointment(writer, { type, duration, startsAt: slot, place, stewardId });
      reset();
      setNeedsRefresh(true);
      setOutcome({ tone: 'status', text: t('Booked. Refresh to see it in the list.') });
      await settleBusinessWrite(writer, { current,
        accepted: () => {},
        stale: () => setOutcome({ tone: 'status', text: t('Booked. Refresh to see it in the list.') }),
        refresh: async () => { const confirmed = await confirmList(current); if (confirmed) void haptics.success(); return confirmed; },
      });
    } catch (error) {
      const refusal = bookingRefusal(error);
      setOutcome({ tone: 'error', text: t(REFUSAL_MESSAGES[refusal]) });
      // Only a time that went away while the member chose it is fixed by
      // another time: read the times again for that one alone.
      if (refusal === 'taken') setSlotsReload((value) => value + 1);
    }

    });
  }

  const outcomeView = outcome
    ? <Body accessibilityRole={outcome.tone === 'error' ? 'alert' : undefined} style={outcome.tone === 'error' ? { color: theme.destructive } : undefined}>{outcome.text}</Body>
    : null;

  if (!open) {
    return (
      <Card>
        <Heading level={3}>{t('Book time with a committee member')}</Heading>
        <Body muted>{t('Pick an open time in the next two weeks. It appears here and on the website.')}</Body>
        {outcomeView}
        {needsRefresh ? <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void refresh()} /> : null}
        <Button disabled={busy} label={t('Book a time')} onPress={() => { setOutcome(null); setOpen(true); }} />
      </Card>
    );
  }

  return (
    <Card>
      <Heading level={3}>{t('Book time with a committee member')}</Heading>
      <Choices label={t('What is this about?')}>
        {APPOINTMENT_TYPES.map((key) => <Button key={key} label={t(APPOINTMENT_TYPE_LABELS[key])} variant="secondary" selected={type === key} disabled={busy} onPress={() => setType(key)} />)}
      </Choices>
      <Choices label={t('How long do you need?')}>
        {APPOINTMENT_DURATIONS.map((minutes) => <Button key={minutes} label={t('{minutes} min', { minutes })} variant="secondary" selected={duration === minutes} disabled={busy} onPress={() => setDuration(minutes)} />)}
      </Choices>
      {stewardsFailed ? <>
        {/* #9459 M1-23: the steward list retries in place, as the open times do. */}
        <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Committee members could not be read. Try again.')}</Body>
        <Button label={t('Try again')} variant="secondary" onPress={() => setStewardsReload((value) => value + 1)} />
      </>
        : stewards === null ? <Body muted>{t('Finding committee members…')}</Body>
          : stewards.length === 0 ? <Body muted>{t('No committee members are taking one-on-ones right now.')}</Body>
            : <Choices label={t('Who would you like to meet?')}>
              <Button label={t('Any committee member')} variant="secondary" selected={stewardId === null} disabled={busy} onPress={() => setStewardId(null)} />
              {stewards.map((row) => <Button key={row.id} label={row.name} variant="secondary" selected={stewardId === row.id} disabled={busy} onPress={() => setStewardId(row.id)} />)}
            </Choices>}
      {!canSearch ? (type === null && stewards && stewards.length > 0 ? <Body muted>{t('Choose what this is about to see open times.')}</Body> : null)
        : slotsFailed ? <>
          <Body style={{ color: theme.destructive }}>{t('Open times could not be loaded.')}</Body>
          <Button label={t('Try again')} variant="secondary" onPress={() => setSlotsReload((value) => value + 1)} />
        </> : slots === null ? <Body muted>{t('Finding open times…')}</Body>
          : days.length === 0 ? <Body muted>{t('No open times in the next two weeks. Try a different committee member or length.')}</Body>
            : <>
              <Choices label={t('Pick a day')}>
                {days.map((day) => <Button key={day.key} label={easternDayLabel(day.firstStartsAt, locale)} variant="secondary" selected={day.key === activeDay?.key} disabled={busy} onPress={() => { setDayKey(day.key); setSlot(null); }} />)}
              </Choices>
              <Choices label={t('Pick a time (Eastern)')}>
                {(activeDay?.slots ?? []).map((option) => <Button key={option.startsAt} label={easternTimeLabel(option.startsAt, locale)} variant="secondary" selected={slot === option.startsAt} disabled={busy} onPress={() => setSlot(option.startsAt)} />)}
              </Choices>
            </>}
      <Text style={[styles.label, { color: theme.foreground }]}>{t('Location, room, or meeting link')}</Text>
      <TextInput
        accessibilityLabel={t('Location, room, or meeting link')}
        value={place}
        onChangeText={setPlace}
        placeholder={t('Union hall, Room 204, or a meeting link')}
        placeholderTextColor={theme.quietForeground}
        keyboardAppearance={theme.appearance}
        maxLength={PLACE_MAX_LENGTH}
        editable={!busy}
        style={[styles.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }]}
      />
      {outcomeView}
      {needsRefresh ? <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void refresh()} /> : null}
      <View style={styles.actions}>
        <Button label={t('Confirm booking')} busy={busy} disabled={slot === null} onPress={() => { void confirm(); }} />
        <Button label={t('Cancel')} variant="secondary" disabled={busy} onPress={() => { reset(); setOutcome(null); }} />
      </View>
    </Card>
  );
}

const REFUSAL_MESSAGES = {
  taken: 'That time could not be booked. It may have just been taken. Pick another time.',
  cap: 'You already have three upcoming one-on-ones. One of them has to take place or be cancelled before you can book another.',
  place: 'Check the place: use 1 to 300 characters, with no special characters.',
  chapter: 'Your account is not linked to a campaign yet, so it cannot book a committee member. Ask a campaign officer to add you.',
  signin: 'Your sign-in needs to be confirmed before you can book. Sign in again and try again.',
  other: 'The booking could not be saved. Try again.',
} satisfies Record<BookingRefusal, NativeUiKey>;

function Choices({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.choices}>
      <Text style={[styles.label, { color: theme.foreground }]}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choiceRow}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { gap: spacing.sm },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16 },
});
