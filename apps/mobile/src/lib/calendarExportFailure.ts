// #9462 (M2-11): a failed "Add to calendar" names only the cause the app can
// know. The press-time read says the record is gone when it found no row for
// this account (or the record can no longer go into a calendar: cancelled,
// started, no longer confirmed). Every other failure (no connection, a session
// that could not be confirmed, a refused or unreadable read) cannot be told
// apart here, so it is said as "could not be added", never as "gone".
const GONE = 'calendarRecordGone';

/** The error a press-time export read throws when the record itself is gone. */
export function calendarRecordGone(message: string): Error {
  return Object.assign(new Error(message), { [GONE]: true });
}

function isRecordGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, GONE) === true;
}

export function calendarExportFailureText(error: unknown, record: 'event' | 'appointment'): string {
  const gone = isRecordGone(error);
  if (record === 'event') {
    return gone ? 'That meeting is no longer available.' : 'The meeting could not be added to your calendar. Check your connection and try again.';
  }
  return gone ? 'That one-on-one is no longer available.' : 'The one-on-one could not be added to your calendar. Check your connection and try again.';
}

// #9462 (wave 3, LiveAppointmentsFeature history): the appointment history read
// carries the same tag only when get_appointment_history answered that the
// appointment is gone or not this account's; any other failure is told as
// "could not be loaded", never as "no longer available".
export function appointmentHistoryFailureText(error: unknown): string {
  return isRecordGone(error)
    ? 'That one-on-one history is no longer available.'
    : 'That one-on-one history could not be loaded. Check your connection and try again.';
}
