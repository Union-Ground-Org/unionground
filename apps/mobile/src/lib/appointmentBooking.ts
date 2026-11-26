// BUG-UG-NATIVE-IOS-APPOINTMENTS-NO-HOURS-OR-BOOKING-20261117:
// the phone's booking-hours editor and member booking flow use the website's
// own choices and rules (src/views/AppointmentsView.jsx and
// src/lib/stewardAvailability.js). The server stays the authority: the window
// check below only refuses what set_appointment_windows would refuse anyway,
// and every open time on screen came from get_appointment_slots.
import { appointmentWindowsError as webAppointmentWindowsError } from '../../../../src/lib/stewardAvailability.js';
import { groupTimeZone, zoneDay, zoneLabel } from '../../../../src/lib/zoneTime.js';
import { deviceDateTime, deviceTimeZoneLabel, parseDatabaseTimestamp } from './evidenceTimestamp';
import type { NativeUiKey } from './nativeUiCopy';

export const APPOINTMENT_TYPES = ['office_hours', 'grievance_followup', 'onboarding', 'contract_questions'] as const;
export type AppointmentType = typeof APPOINTMENT_TYPES[number];
export const APPOINTMENT_DURATIONS = [20, 30, 45] as const;
export type AppointmentDuration = typeof APPOINTMENT_DURATIONS[number];

export const APPOINTMENT_TYPE_LABELS = {
  office_hours: 'Office hours',
  grievance_followup: 'Issue follow-up',
  onboarding: 'Onboarding',
  contract_questions: 'Contract questions',
} as const satisfies Record<AppointmentType, string>;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type AppointmentWindow = { weekday: number; startMinute: number; endMinute: number };

// The steps a phone stepper moves a start or end time by.
export const WINDOW_STEP_MINUTES = 15;
const DAY_MINUTES = 1440;
const LATEST_START = 1425;
const EARLIEST_END = 15;

export type AppointmentWindowsProblem = 'invalid' | 'overlap' | null;

/** The website's own pre-save check, with its message key reduced to a kind. */
export function appointmentWindowsProblem(windows: readonly AppointmentWindow[]): AppointmentWindowsProblem {
  const key: unknown = webAppointmentWindowsError(windows);
  if (key === 'appt.windowsOverlap') return 'overlap';
  return key ? 'invalid' : null;
}

/** 540 -> "9:00 AM"; 1440 -> "12:00 AM" (end of day). */
export function minuteLabel(minute: number): string {
  const wrapped = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** Moves one end of a window by a step, staying inside the server's bounds. */
export function stepWindow(window: AppointmentWindow, edge: 'start' | 'end', direction: -1 | 1): AppointmentWindow {
  if (edge === 'start') {
    const startMinute = Math.min(LATEST_START, Math.max(0, window.startMinute + direction * WINDOW_STEP_MINUTES));
    return { ...window, startMinute };
  }
  const endMinute = Math.min(DAY_MINUTES, Math.max(EARLIEST_END, window.endMinute + direction * WINDOW_STEP_MINUTES));
  return { ...window, endMinute };
}

export function stepWeekday(window: AppointmentWindow, direction: -1 | 1): AppointmentWindow {
  return { ...window, weekday: (window.weekday + direction + 7) % 7 };
}

/** A new 9 AM-noon window on the first weekday (Monday first) that has none yet. */
export function nextNewWindow(windows: readonly AppointmentWindow[]): AppointmentWindow {
  const used = new Set(windows.map((window) => window.weekday));
  const weekday = [1, 2, 3, 4, 5, 6, 0].find((day) => !used.has(day)) ?? 1;
  return { weekday, startMinute: 540, endMinute: 720 };
}

export function sortWindows<T extends AppointmentWindow>(windows: readonly T[]): T[] {
  return [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

/** YYYY-MM-DD in the device's own zone: what get_appointment_slots reads p_from/p_to as (the website sends the same). */
export function deviceDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** The website's two-week span: today through 13 days later, so next week is always inside it. */
export function slotSearchSpan(now: Date): { from: string; to: string } {
  const to = new Date(now);
  to.setDate(to.getDate() + 13);
  return { from: deviceDateKey(now), to: deviceDateKey(to) };
}

const EASTERN = 'America/New_York';

function easternParts(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // A Hermes build without the Eastern zone data throws on construction; the
  // caller falls back to the device's own clock rather than losing the slot.
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: EASTERN, ...options }).format(date).replace(/ | /g, ' ');
  } catch {
    return null; // swallow-ok: no Eastern zone data on this build; the caller labels the slot with the device clock instead
  }
}

export function easternDayKey(iso: string): string {
  return easternParts(iso, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }) ?? iso.slice(0, 10);
}

export function easternDayLabel(iso: string, locale: 'en-US' | 'es-US'): string {
  return easternParts(iso, locale, { weekday: 'short', month: 'short', day: 'numeric' }) ?? new Date(iso).toDateString();
}

export function easternTimeLabel(iso: string, locale: 'en-US' | 'es-US'): string {
  const time = easternParts(iso, locale, { hour: 'numeric', minute: '2-digit', hour12: true }); // zone-labelled: ET follows
  return time ? `${time} ET` : new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// Booked rows do not carry a group zone yet . Use the shared
// starting zone, as the booking picker does, for both card endpoints.
export function appointmentRangeLabel(startsAt: string, endsAt: string | null, locale: 'en-US' | 'es-US'): string | null {
  const start = parseDatabaseTimestamp(startsAt);
  if (!start) return null;
  const end = parseDatabaseTimestamp(endsAt);
  const timeZone: string = groupTimeZone(null);
  try {
    const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }); // zone-labelled: labels appended below
    const startZone: string = zoneLabel(start, timeZone) ?? timeZone;
    const label = deviceTimeZoneLabel(start, timeZone) ?? startZone;
    const plain = (value: string) => value.replace(/[\u00A0\u2009\u202F]/g, ' ');
    const fullStamp = (value: Date, zone: string) => `${plain(date.format(value))}, ${plain(clock.format(value))} ${zone}`;
    if (!end || end <= start) return fullStamp(start, label);

    const endZone: string = zoneLabel(end, timeZone) ?? timeZone;
    if (startZone !== endZone) return `${fullStamp(start, startZone)} – ${fullStamp(end, endZone)}`;
    if (zoneDay(start, timeZone) !== zoneDay(end, timeZone)) return `${fullStamp(start, label)} – ${fullStamp(end, label)}`;

    // Older phone Intl engines do not provide formatRange. Keep both clock
    // times and print the day once there too.
    const times = clock.formatRange?.(start, end) ?? `${clock.format(start)} – ${clock.format(end)}`;
    return `${plain(date.format(start))}, ${plain(times)} ${label}`;
  } catch {
    // Older engines can lack the group zone data while still formatting device times.
    const startLabel = deviceDateTime(startsAt, locale);
    if (!startLabel || !end || end <= start) return startLabel;
    const endLabel = deviceDateTime(endsAt, locale);
    return endLabel ? `${startLabel} – ${endLabel}` : startLabel;
  }
}

export type AppointmentSlot = { startsAt: string; stewardCount: number };

/** Open times grouped by Eastern day, in server order. */
export function slotsByEasternDay(slots: readonly AppointmentSlot[]): { key: string; firstStartsAt: string; slots: AppointmentSlot[] }[] {
  const groups = new Map<string, { key: string; firstStartsAt: string; slots: AppointmentSlot[] }>();
  for (const slot of slots) {
    const key = easternDayKey(slot.startsAt);
    const group = groups.get(key) ?? { key, firstStartsAt: slot.startsAt, slots: [] };
    group.slots.push(slot);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const PLACE_MAX_LENGTH = 300;

/** book_appointment refuses an empty place or one over 300 characters. */
export function bookingPlaceProblem(place: string): 'missing' | 'long' | null {
  const clean = place.trim();
  if (!clean) return 'missing';
  return clean.length > PLACE_MAX_LENGTH ? 'long' : null;
}

// The booking RPC refuses for reasons another
// time cannot fix (the three-upcoming cap, a missing chapter, the sign-in
// check). Only a time that went away sends the member back to the times.
export type BookingRefusal = 'cap' | 'taken' | 'place' | 'chapter' | 'signin' | 'other';

export function bookingRefusal(error: unknown): BookingRefusal {
  const failure = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = typeof failure.message === 'string' ? failure.message.toLowerCase() : '';
  if (failure.code === '42501') return 'signin';
  if (text.includes('upcoming one-on-ones')) return 'cap';
  if (text.includes('no longer available') || text.includes('out of range')) return 'taken';
  if (text.includes('one-on-one place')) return 'place';
  if (text.includes('worker campaign required')) return 'chapter';
  return 'other';
}

// Weekly windows are wall-clock minutes in the
// schedule's own saved zone (private.appointment_slots_for reads them there),
// so the card names that zone, never the phone's.
const SCHEDULE_ZONE_NAMES = {
  'America/New_York': 'Eastern time',
  'America/Detroit': 'Eastern time',
  'America/Chicago': 'Central time',
  'America/Denver': 'Mountain time',
  'America/Phoenix': 'Arizona time',
  'America/Los_Angeles': 'Pacific time',
  'America/Anchorage': 'Alaska time',
  'Pacific/Honolulu': 'Hawaii time',
} satisfies Record<string, NativeUiKey>;
export type ScheduleZoneName = typeof SCHEDULE_ZONE_NAMES[keyof typeof SCHEDULE_ZONE_NAMES];

export function scheduleZoneName(zone: string): ScheduleZoneName | null {
  return Object.hasOwn(SCHEDULE_ZONE_NAMES, zone) ? SCHEDULE_ZONE_NAMES[zone as keyof typeof SCHEDULE_ZONE_NAMES] : null;
}
