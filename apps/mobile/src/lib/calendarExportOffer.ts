// REQ-UNION-GROUND-MOBILE-NATIVE-CALENDAR-EXPORT-20260825, acceptance item 4:
// "The action appears only in live authenticated sessions for upcoming,
// non-cancelled records the session is authorized to read; SAMPLE/PREVIEW
// fixtures never offer export into a real device calendar." The 2026-09-27
// device windows (Android 7c/7d `d1-appts`, iPhone 9 `n9-cal-1/2`) found
// "Add to calendar" offered on the SAMPLE fixture session's confirmed
// upcoming appointments on both platforms, and tapping it opened the real
// system composer. The screens gated the control on the native module and the
// record's own state only; nothing asked whether the session was live.
//
// A session is live only when it is authenticated, is not a SAMPLE persona
// session and the build itself does not target the pinned SAMPLE project.
// PREVIEW (no auth session) and SAMPLE (fixture data) never offer the export.

export type CalendarExportOfferContext = {
  mode: string;
  sampleHat: string | null;
  liveSampleBackend: boolean;
  calendarReady: boolean;
};

export function calendarExportSessionIsLive(context: CalendarExportOfferContext): boolean {
  return context.mode === 'authenticated' && context.sampleHat === null && !context.liveSampleBackend;
}

export function offersAppointmentCalendarExport(
  context: CalendarExportOfferContext,
  appointment: { status: string; startsAt: string },
  nowMs: number,
): boolean {
  if (!context.calendarReady || !calendarExportSessionIsLive(context)) return false;
  const startMs = Date.parse(appointment.startsAt);
  return appointment.status === 'confirmed' && Number.isFinite(startMs) && startMs > nowMs;
}

export function offersEventCalendarExport(
  context: CalendarExportOfferContext,
  event: { cancelled: boolean; startsAt: string },
  nowMs: number,
): boolean {
  if (!context.calendarReady || !calendarExportSessionIsLive(context)) return false;
  const startMs = Date.parse(event.startsAt);
  return !event.cancelled && Number.isFinite(startMs) && startMs > nowMs;
}
