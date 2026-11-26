import NativeCalendarExportModule from '../../modules/native-calendar-export/src/NativeCalendarExportModule';
import type { LivedInEvent } from './livedIn';
import type { MobileAppointment } from './supabase';

// One user-confirmed handoff to the operating system's own event composer.
// The payload is the entire calendar surface of a record: no identifier,
// deep link, summary, worker or staff name, one-on-one type, or reason
// category may enter it, because synced device calendars leave the app's
// authorization boundary.
export type CalendarExportPayload = {
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
};

export type CalendarExportResult = 'saved' | 'canceled' | 'opened' | 'unavailable';

export function calendarExportWasSaved(result: CalendarExportResult): boolean {
  return result === 'saved';
}

const TITLE_MAX = 120;
const LOCATION_MAX = 160;
const EVENT_DEFAULT_DURATION_MS = 60 * 60 * 1000;
const APPOINTMENT_FALLBACK_DURATION_MS = 30 * 60 * 1000;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;

export const APPOINTMENT_CALENDAR_TITLE = 'Union Ground one-on-one';

function cleanText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
    .trim();
}

function boundedEnd(startMs: number, candidateEndMs: number | null, fallbackDurationMs: number): number {
  if (candidateEndMs !== null && Number.isFinite(candidateEndMs)) {
    const duration = candidateEndMs - startMs;
    if (duration > 0 && duration <= MAX_DURATION_MS) return candidateEndMs;
  }
  return startMs + fallbackDurationMs;
}

/** An upcoming, non-cancelled authorized campaign meeting keeps its own title and room. */
export function calendarExportPayloadForEvent(event: LivedInEvent, nowMs: number): CalendarExportPayload | null {
  if (event.cancelled || (event.eventKind && event.eventKind !== 'meeting')) return null;
  const startMs = Date.parse(event.startsAt);
  if (!Number.isFinite(startMs) || startMs <= nowMs) return null;
  if (event.endsAt && (!Number.isFinite(Date.parse(event.endsAt)) || Date.parse(event.endsAt) <= startMs)) return null;
  const title = cleanText(event.title, TITLE_MAX);
  if (!title) return null;
  const location = cleanText(event.location, LOCATION_MAX);
  return {
    title,
    startMs,
    endMs: event.endsAt ? Date.parse(event.endsAt) : startMs + EVENT_DEFAULT_DURATION_MS,
    location: location || null,
  };
}

/** A confirmed upcoming one-on-one exports exact times under a generic title only. */
export function calendarExportPayloadForAppointment(
  appointment: MobileAppointment,
  nowMs: number,
): CalendarExportPayload | null {
  if (appointment.status !== 'confirmed') return null;
  const startMs = Date.parse(appointment.startsAt);
  if (!Number.isFinite(startMs) || startMs <= nowMs) return null;
  const parsedEnd = Date.parse(appointment.endsAt);
  return {
    title: APPOINTMENT_CALENDAR_TITLE,
    startMs,
    endMs: boundedEnd(startMs, Number.isFinite(parsedEnd) ? parsedEnd : null, APPOINTMENT_FALLBACK_DURATION_MS),
    location: null,
  };
}

export function isCalendarExportAvailable(): boolean {
  try {
    return NativeCalendarExportModule?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

export async function exportToDeviceCalendar(
  payload: CalendarExportPayload,
  isCurrent: () => boolean,
): Promise<CalendarExportResult> {
  let current = false;
  try {
    current = isCurrent();
  } catch {
    current = false;
  }
  if (!current) throw new Error('Calendar export authorization changed.');
  if (!NativeCalendarExportModule) return 'unavailable';
  try {
    return await NativeCalendarExportModule.presentEventComposerAsync(
      payload.title,
      payload.startMs,
      payload.endMs,
      payload.location,
    );
  } catch (error) {
    // A second tap while the system sheet is already open is not a missing
    // calendar app; treat it like the user staying in the open composer.
    return (error as { code?: string } | null)?.code === 'E_BUSY' ? 'canceled' : 'unavailable';
  }
}
