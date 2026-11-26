import { eventDisplayDate, eventIsPast as sharedEventIsPast, eventModelLabels } from '../../../../src/lib/eventModel.js';
import type { LivedInEvent } from '../services/livedIn';
import { compareEventSchedule } from './eventModelShared';

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-STEWARD-09, MOB-COORDINATOR-07/-08, MOB-VP-08): event rows read
// "Tue, Nov 3 · 7:00 PM" with no year and no zone, mixed past and upcoming
// events in one list, and gave no word on check-in once an event had ended.
// Since #7820 the shared clock label shows Eastern time and ends each clock
// with its zone, so this label adds no zone of its own (#9138: "4:00 PM EST
// EST").
// BUG-UG-NATIVE-EVENT-DATE-IN-PHONE-ZONE-CLOCK-IN-EASTERN-20261119
// (#9209): a timed event's date is its Eastern date too, as on the website
// (src/lib/eventModel.js), so a phone outside Eastern never puts a 1:00 AM EST
// meeting on the day before. A date-only event keeps its own calendar date.

export function eventWhenLabel(event: LivedInEvent, lang: 'en' | 'es' = 'en'): string {
  const date = eventDisplayDate(event) as Date;
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const timeZone = event.eventDate ? undefined : 'America/New_York';
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  const { timeLabel } = eventModelLabels(event, lang) as { timeLabel: string };
  return [dateLabel, timeLabel].filter(Boolean).join(' · ').replace(/[  ]/g, ' ');
}

export function eventIsPast(event: LivedInEvent, nowMs = Date.now()): boolean {
  return Boolean(sharedEventIsPast(event, nowMs));
}

// Upcoming events first in schedule order, then past events newest first, so a
// list never puts last month's meeting between two meetings still to come. The
// split sorts for itself rather than trusting the loader's order (gate round 1
// on #6996).
export function splitEventsByTime(events: readonly LivedInEvent[], nowMs = Date.now()): { upcoming: LivedInEvent[]; past: LivedInEvent[] } {
  const upcoming: LivedInEvent[] = [];
  const past: LivedInEvent[] = [];
  for (const event of [...events].sort(compareEventSchedule)) (eventIsPast(event, nowMs) ? past : upcoming).push(event);
  past.reverse();
  return { upcoming, past };
}

// Check-in runs from two hours before a meeting starts until four hours after
// (the window LiveEventsScreen has always used). After the window the row says
// so instead of dropping the control without a word.
export function eventCheckInClosed(event: LivedInEvent, nowMs = Date.now()): boolean {
  if (!event.checkInOffered || (event.eventKind ?? 'meeting') !== 'meeting' || event.checkedInAt) return false;
  const start = Date.parse(event.startsAt);
  return Number.isFinite(start) && nowMs > start + 4 * 60 * 60 * 1_000;
}
