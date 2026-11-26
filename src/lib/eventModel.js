import { localeFor, dateTimeFormatCore } from './i18n/format.js';
import { eventTypeText } from './i18n/eventTypes.js';

export function eventModelFields(row) {
  return {
    eventKind: row.event_kind ?? row.eventKind ?? 'meeting',
    eventDate: row.event_date ?? row.eventDate ?? null,
    endsAt: row.ends_at ?? row.endsAt ?? null,
    seriesId: row.series_id ?? row.seriesId ?? null,
    checkInOffered: (row.check_in_offered ?? row.checkInOffered) === true,
  };
}
// Calendar labels and sorting share the Eastern day; date-only values
// remain calendar dates rather than instants.
function easternDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function eventDisplayDate(event) {
  return event.eventDate ? new Date(`${event.eventDate}T12:00:00`) : new Date(event.startsAt);
}
export function eventModelLabels(event, lang = 'en') {
  const date = eventDisplayDate(event);
  const dateLabel = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(localeFor(lang), { timeZone: event.eventDate ? undefined : 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  const kind = event.eventKind ?? 'meeting';
  const time = (value) => `${dateTimeFormatCore(lang, { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(value))} ${eventTimeZoneLabel(value)}`;
  const end = event.endsAt ? new Date(event.endsAt) : null;
  const sameDay = end && easternDay(event.startsAt) === easternDay(event.endsAt);
  const timeLabel = kind !== 'meeting' ? eventTypeText(lang, kind)
    : !event.startsAt || event.eventDate ? '' : `${time(event.startsAt)}${end ? ` – ${sameDay ? time(event.endsAt) : `${dateTimeFormatCore(lang, { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(end)}, ${time(event.endsAt)}`}` : ''}`;
  return { dateLabel, timeLabel, startsLabel: [dateLabel, timeLabel].filter(Boolean).join(' · ') };
}
// Display clocks are Eastern. Authors can still pass their explicitly named
// input zone; its wall-time conversion is independent of card presentation.
export function eventTimeZoneLabel(value, lang = 'en', timeZone = 'America/New_York') {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return dateTimeFormatCore(timeZone === 'America/New_York' ? 'en' : lang, { hour: 'numeric', timeZoneName: 'short', timeZone })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
}
// A draft schedule that is already behind the clock: a timed start before now,
// or a calendar date before today. Saving stays possible (a meeting can be
// recorded after the fact); the form warns first.
export function eventScheduleInPast({ eventKind = 'meeting', startsAt, eventDate }, nowMs = Date.now()) {
  if ((eventKind ?? 'meeting') === 'meeting') {
    const start = Date.parse(startsAt);
    return Number.isFinite(start) && start < nowMs;
  }
  if (!eventDate) return false;
  const today = easternDay(nowMs);
  return eventDate < today;
}
export function eventIsPast(event, nowMs = Date.now()) {
  const today = easternDay(nowMs);
  if (event.eventDate) return event.eventDate < today;
  return new Date(event.endsAt ?? event.startsAt).getTime() < nowMs - 6 * 3600000;
}

// #9560: whether an event ended at or after sinceMs. A date-only event ends with
// its calendar day, read the way eventIsPast reads it; a timed one at its end,
// or its start when it has none. Unlike eventIsPast it allows no six-hour
// grace, so callers ask it only about events eventIsPast already calls past.
export function eventEndedSince(event, sinceMs) {
  if (event.eventDate) return event.eventDate >= easternDay(sinceMs); // fixed-zone: the same calendar day eventIsPast reads
  return new Date(event.endsAt ?? event.startsAt).getTime() >= sinceMs;
}

// Calendar dates have no instant. Compare Eastern calendar days first, then
// timed meetings within the day, with date-only items at the end of that day.
export function compareEventSchedule(a, b, direction = 1) {
  const dateKey = (event) => {
    const explicit = event.eventDate ?? event.event_date;
    if (explicit) return explicit;
    return easternDay(event.startsAt ?? event.starts_at);
  };
  if (!a.eventDate && !a.event_date && !Number.isFinite(Date.parse(a.startsAt ?? a.starts_at))) return 0;
  if (!b.eventDate && !b.event_date && !Number.isFinite(Date.parse(b.startsAt ?? b.starts_at))) return 0;
  const day = dateKey(a).localeCompare(dateKey(b));
  const aDated = Boolean(a.eventDate ?? a.event_date);
  const bDated = Boolean(b.eventDate ?? b.event_date);
  return day * direction || Number(aDated) - Number(bDated)
    || (aDated ? 0 : (Date.parse(a.startsAt ?? a.starts_at) - Date.parse(b.startsAt ?? b.starts_at)) * direction)
    || String(a.id).localeCompare(String(b.id));
}
