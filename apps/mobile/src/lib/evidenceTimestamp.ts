// BUG-UG-NATIVE-EVIDENCE-ROWS-RAW-UPDATED-TIMESTAMP-20261103: the
// native staff record lists (Casework, Forms, Rights, Chapter documents,
// Campaigns) printed the database value after "Updated", for example
// "Updated 2026-11-03T07:57:41.22431+00:00". The meta line now reads as an
// Eastern date and time, the zone every other dated Union Ground surface uses.

import { formatZoneInstant, groupTimeZone } from '../../../../src/lib/zoneTime.js';
import { EASTERN_TIME_ZONE as EASTERN } from './easternTime';

const UNAVAILABLE = 'Update time unavailable';

// Postgres timestamps carry microseconds and may arrive with a space for the
// "T" or a bare "+00" offset. Engines differ on parsing those, so the value is
// brought to the plain ISO-8601 shape every engine reads before it is parsed.
export function parseDatabaseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const iso = value.trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Newer ICU puts a narrow no-break space (U+202F) before AM/PM, and some
// builds a no-break space (U+00A0); the meta line uses plain spaces.
function plainSpaces(text: string): string {
  return text.replace(/[\u202F\u00A0]/g, ' ');
}

// BUG-UG-NATIVE-CHAPTER-RECORD-DATE-WITHOUT-TIME-ZONE-20261103: My
// chapter printed its records, briefings and document "Updated" lines through
// toLocaleString(), so a record read "11/2/2026, 5:00:00 pm" in the phone's own
// zone and an unreadable value surfaced raw. My chapter and the "Updated" lines
// of #6872's family share this Eastern format: "Nov 2, 2026 · 5:00 PM ET".
// Null means the value is missing or unreadable; each caller names its own
// plain fallback. Spanish readers get the es-US words for the same instant.
export function easternDateTime(value: unknown, locale: 'en-US' | 'es-US' = 'en-US'): string | null {
  const date = parseDatabaseTimestamp(value);
  if (!date) return null;
  // The formatters are built per call, inside the guard: a Hermes build
  // without the Eastern zone data throws on construction, and a row must fall
  // back to its unavailable line rather than fail the whole list.
  try {
    const day = easternCalendarDay(date, locale, true);
    const time = new Intl.DateTimeFormat(locale, { timeZone: EASTERN, hour: 'numeric', minute: '2-digit', hour12: true }).format(date); // zone-labelled: ET follows
    return `${day} · ${plainSpaces(time)} ET`;
  } catch {
    return null;
  }
}

// The one place the Eastern calendar day is worked out, so every surface that
// dates the same record lands on the same day.
function easternCalendarDay(date: Date, locale: 'en-US' | 'es-US', withYear: boolean): string {
  const fields: Intl.DateTimeFormatOptions = withYear
    ? { timeZone: EASTERN, month: 'short', day: 'numeric', year: 'numeric' }
    : { timeZone: EASTERN, month: 'short', day: 'numeric' };
  return plainSpaces(new Intl.DateTimeFormat(locale, fields).format(date));
}

// Gate round 2 on #6934 (r2g1): the Home unread-broadcast card dated a
// broadcast by the phone's calendar day while My chapter's briefing archive
// dates the same published_at in Eastern, so a phone outside Eastern could
// show two days for one briefing. Both now take the Eastern day from
// easternCalendarDay; this is the short "Nov 2" form the Home eyebrow uses.
// Null means the value is missing or unreadable, or the Eastern zone data is.
export function easternShortDay(value: unknown, locale: 'en-US' | 'es-US' = 'en-US'): string | null {
  const date = parseDatabaseTimestamp(value);
  if (!date) return null;
  try {
    return easternCalendarDay(date, locale, false);
  } catch {
    return null;
  }
}

// The surfaces whose neighbouring times follow the phone's clock (message
// threads, appointments and availability, rewards, chapter health,
// the leadership claim) keep their existing phone-clock basis so no screen
// mixes zones. These stamps show the date, minute and zone together.
// A time with its zone named, in the phone's own zone, as
// the chapter notices print it ("Aug 5, 12:00 PM EDT"). The Campaigns list
// printed close times through deviceDateTime ("10/23/2026, 8:00:00 PM") with
// no zone. Null means the value is missing or unreadable.
export function deviceZonedDateTime(value: unknown, locale?: string): string | null {
  const date = parseDatabaseTimestamp(value);
  return date ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null;
}

// Campaign closing times, including ballot campaigns, and surveys use the
// phone clock. Voting cards and Search ballot rows use the group clock.
export function deviceDateTime(value: unknown, locale?: 'en-US' | 'es-US'): string | null {
  const date = parseDatabaseTimestamp(value);
  return date ? plainSpaces(date.toLocaleString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })) : null;
}

export function formatBallotClosingTime(value: string | number | null, language: 'en' | 'es'): string | null {
  const instant = typeof value === 'number' ? value : parseDatabaseTimestamp(value);
  try {
    return formatZoneInstant(instant, language, groupTimeZone(null));
  } catch { // swallow-ok: Voting and Search can still show the ballot status when the engine lacks the zone
    return null;
  }
}

export function deviceTimeZoneLabel(date: Date, timeZone?: string): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const nameStyles: NonNullable<Intl.DateTimeFormatOptions['timeZoneName']>[] = ['shortGeneric', 'short'];
  for (const timeZoneName of nameStyles) {
    try {
      const label = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName })
        .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
      if (label === 'EST' || label === 'EDT') return 'ET'; // fixed-zone: these are formatter results, not a selected zone
      if (label) return label;
    } catch {
      // swallow-ok: older native Intl can reject a generic name but still supply a short one.
      continue;
    }
  }
  return null;
}

// BUG-UG-NATIVE-WORKLOAD-HISTORY-SHOWS-EACH-LOG-ONE-DAY-EARLY-20261118
// (#9163): the Workload log history and the Reports cards read a date with no
// time (a workload log's logged_on, such as 2026-11-18) as midnight UTC, so a
// phone behind UTC showed the evening before (11/17/2026). A date with no time
// is that calendar day wherever the phone is, so it is read at the phone's own
// noon; a timestamp keeps its instant. Both print in the phone's own words, as
// the history always did.
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function deviceDay(value: string | null | undefined): Date | null {
  // A missing endpoint (null or undefined) is skipped, as the old range did.
  if (typeof value !== 'string') return null;
  const day = CALENDAR_DAY.exec(value.trim());
  if (!day) return parseDatabaseTimestamp(value);
  const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const noon = new Date(year, month - 1, date, 12);
  return noon.getFullYear() === year && noon.getMonth() === month - 1 && noon.getDate() === date ? noon : null;
}

const DAY_FIELDS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

export function deviceCalendarDay(value: string | null | undefined, locale?: 'en-US' | 'es-US'): string | null {
  const day = deviceDay(value);
  return day ? plainSpaces(day.toLocaleDateString(locale, DAY_FIELDS)) : null;
}

// "Nov 2, 2026 – Nov 18, 2026" from the oldest to the newest readable value;
// empty when none is readable. A null or undefined value is skipped.
export function deviceDayRange(values: readonly (string | null | undefined)[], locale?: 'en-US' | 'es-US'): string {
  const sorted = values.flatMap((value) => deviceDay(value) ?? []).sort((left, right) => left.getTime() - right.getTime());
  if (!sorted.length) return '';
  const format = (day: Date) => plainSpaces(day.toLocaleDateString(locale, DAY_FIELDS));
  return `${format(sorted[0]!)} – ${format(sorted[sorted.length - 1]!)}`;
}

export function evidenceUpdatedMeta(value: unknown): string {
  const stamp = easternDateTime(value);
  return stamp ? `Updated ${stamp}` : UNAVAILABLE;
}

// Be heard listed each report with its raw created_at value
// (REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103); it reads
// as the same Eastern date and time as the "Updated" lines.
export function sentMeta(value: unknown): string {
  const stamp = easternDateTime(value);
  return stamp ? `Sent ${stamp}` : 'Send time unavailable';
}
