// REQ-UNION-BASE-APPOINTMENT-HISTORY-READER-20260818, acceptance item 3:
// "Upcoming, cancelled, rescheduled and reassigned states remain visually and
// semantically distinct without relying on color alone on the physical iPhone
// and Android proofs." The 2026-09-27 iPhone device window 9 found that the
// appointment cards' date, time and status pill were not exposed to
// accessibility on iOS at all: the card-wide history Pressable carried the
// label "Open <type> history", and a labelled button hides its children from
// the accessibility tree, so neither the XCUITest tree nor a VoiceOver walk
// carried any text for a card beyond its two buttons.
//
// The fix keeps one operable 48 pt+ button per card (the whole summary stays
// the touch target) and makes its accessible name carry everything the sighted
// reader sees: type, lifecycle status, the same formatted appointment range the
// heading paints, and the second line (worker with committee member for
// supervising staff, the reason category for a worker). The action itself moves to the
// hint, so a screen reader hears the facts first and the verb second.

export type AppointmentCardSummary = {
  appointmentType: string;
  status: string;
  startsAt: string;
  memberName?: string;
  stewardName?: string;
  reasonCategory?: string;
};

export const APPOINTMENT_CARD_ACCESSIBILITY_HINT = 'Opens the one-on-one history';

/** Free-text record values are stored with underscores (office_hours, no_show). */
export function humanizeAppointmentValue(value: string): string {
  return value.replaceAll('_', ' ');
}

/** The second visible line of a card, without the trailing "View history" cue. */
export function appointmentCardDetailLine(item: AppointmentCardSummary, canSupervise: boolean): string {
  if (canSupervise) return `${item.memberName ?? 'Worker'} · ${item.stewardName ?? 'Committee member'}`;
  return humanizeAppointmentValue(item.reasonCategory ?? 'One-on-one');
}

/**
 * The accessible name of the card-wide history button. `scheduleLabel` is the
 * exact string the card's heading renders, so what is spoken equals what is
 * painted; the caller formats it once and passes it to both.
 */
export function appointmentCardAccessibilityLabel(
  item: AppointmentCardSummary,
  canSupervise: boolean,
  scheduleLabel: string,
): string {
  return [
    humanizeAppointmentValue(item.appointmentType),
    humanizeAppointmentValue(item.status),
    scheduleLabel,
    appointmentCardDetailLine(item, canSupervise),
  ].join(', ');
}
