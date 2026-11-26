// The one time-zone module for web and native
// (REQ-UG-TIME-ZONES-PER-GROUP-20261122; docs/contracts/time-zones-per-group.md).
// Every group (an organization, a chapter, a unit or worksite) has its own
// zone, and a day, a deadline and a clock are worked out in the zone of the
// group the item belongs to: never in the device's zone and never in one
// fixed zone for everyone. Each function takes the zone as an IANA region
// name, so that region's own daylight rules apply. Day arithmetic moves the
// calendar date, never 24 elapsed hours. Catalogue-free, so the native app
// imports it as is.
import { dateTimeFormatCore } from "./i18n/format.js";
import { wallClockMillis } from "./localDateTime.js";

// What a group reads until its own zone reaches the client. Every existing
// group is in this zone today, and the server answers it for every group
// while the group-zone switch is held.
export const UNSET_GROUP_TIME_ZONE = "America/New_York"; // fixed-zone: the value before a group's own zone is delivered
// A group whose zone this device's engine does not know is shown in UTC,
// labelled as such; it is never moved onto another region's clock.
export const UNKNOWN_TIME_ZONE = "UTC";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR = 3_600_000;
const SECOND = 1_000;

// Built on first use, not at import: an engine without a zone's data throws
// on construction, and that must fail the caller, not the import.
const formatters = new Map();
function formatter(zone, name, options) {
  const key = `${zone}\n${name}`;
  let made = formatters.get(key);
  if (!made) {
    made = dateTimeFormatCore("en", { timeZone: zone, ...options });
    formatters.set(key, made);
  }
  return made;
}

function instant(value) {
  const at = value instanceof Date ? value : new Date(value ?? "");
  return Number.isFinite(at.getTime()) ? at : null;
}

// Whether this engine can work in the named zone.
export function isTimeZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try {
    formatter(zone, "day", { year: "numeric", month: "2-digit", day: "2-digit" });
    return true;
  } catch { // swallow-ok: an unknown zone is the answer "no", not a failure to report
    return false;
  }
}

// The zone of a group as the server delivered it: an object with a
// `timeZone`, or the name itself. No zone yet answers UNSET_GROUP_TIME_ZONE;
// a zone this engine does not know answers UTC.
export function groupTimeZone(group) {
  const zone = typeof group === "string" ? group : group?.timeZone;
  if (zone === undefined || zone === null || zone === "") return UNSET_GROUP_TIME_ZONE;
  return isTimeZone(zone) ? zone : UNKNOWN_TIME_ZONE;
}

// The calendar day of an instant in a zone, as YYYY-MM-DD; null when unreadable.
export function zoneDay(value, zone) {
  const at = instant(value);
  if (!at) return null;
  const parts = Object.fromEntries(formatter(zone, "day", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// A calendar day moved by whole days. The civil date moves, so a 23- or
// 25-hour day still counts as one day.
export function addDays(day, days) {
  const match = DAY.exec(String(day ?? ""));
  if (!match || !Number.isInteger(days)) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10); // utc-day: a civil date built at UTC midnight, not an instant's day
}

// A civil date as one number, so dates compare whatever their year's width
// (the formatter prints the year 99 as "99").
function dayKey(year, month, day) {
  return year * 10_000 + month * 100 + day;
}

function zoneDayKey(at, zone) {
  const parts = Object.fromEntries(formatter(zone, "day", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return dayKey(parts.year, parts.month, parts.day);
}

// The instant a calendar day begins in a zone; null for an unreadable day.
// It is the first instant whose date in the zone is that day, and not always
// midnight: where the clocks skip midnight (Havana, for one) the day begins
// at the first minute that exists, and where midnight comes twice it begins
// at the first of the two. Between two clock changes a zone keeps one
// offset, and the day can only begin where that offset calls it midnight or
// at the change itself (Toronto's clock once jumped from 11:30 PM to 12:30
// AM). So the candidates are the midnight of each offset the zone used around
// the day and the instant of each change, whatever its size (Casey station
// has moved its clock back three hours), and the earliest candidate that is
// on the day is the start. A date the zone never had (Apia skipped December
// 30, 2011) has no beginning and answers null.
// private.local_day_start in the database works it out the same way.
export function zoneMidnight(day, zone) {
  const match = DAY.exec(String(day ?? ""));
  if (!match) return null;
  const [year, month, date] = match.slice(1).map(Number);
  if (year === 0) return null;
  // setUTCFullYear keeps the actual year; Date.UTC reads 0 to 99 as 1900 to 1999.
  const anchor = new Date(0);
  anchor.setUTCFullYear(year, month - 1, date);
  if (anchor.getUTCFullYear() !== year || anchor.getUTCMonth() !== month - 1 || anchor.getUTCDate() !== date) return null;
  const wanted = dayKey(year, month, date);
  const offsetAt = (at) => wallClockMillis(at, zone) - at;
  // Zones run from 12 hours behind UTC to 14 ahead, so the offsets in use
  // around the day's start, and the changes between them, are all met
  // between these two hours.
  const candidates = new Set();
  let before = null;
  for (let at = anchor.getTime() - 42 * HOUR; at <= anchor.getTime() + 17 * HOUR; at += HOUR) {
    const offset = offsetAt(at);
    candidates.add(anchor.getTime() - offset);
    if (before !== null && before.offset !== offset) {
      // The change is somewhere in this hour, on a whole second: halve down to it.
      let low = before.at;
      let high = at;
      while (high - low > SECOND) {
        const middle = low + Math.floor((high - low) / (2 * SECOND)) * SECOND;
        if (offsetAt(middle) === before.offset) low = middle;
        else high = middle;
      }
      candidates.add(high);
    }
    before = { at, offset };
  }
  let first = null;
  for (const candidate of candidates) {
    if ((first === null || candidate < first) && zoneDayKey(candidate, zone) === wanted) first = candidate;
  }
  return first === null ? null : new Date(first);
}

// Advance the civil date, then resolve where that day begins in the zone. Its
// day can last 23 or 25 hours, so adding an elapsed 24 hours would miss a
// boundary; a date the zone never had is passed over. An unreadable instant
// gives an Invalid Date.
export function nextZoneMidnight(now, zone) {
  let day = addDays(zoneDay(now, zone), 1);
  for (let skipped = 0; day && skipped < 3; skipped += 1) {
    const start = zoneMidnight(day, zone);
    if (start) return start;
    day = addDays(day, 1);
  }
  return new Date(Number.NaN);
}

// The zone's short label for the instant ("EST", "PDT", "GMT+1"); null when
// unreadable. Always the English label, in either app language: Spanish CLDR
// prints a numeric offset where English has a name.
export function zoneLabel(value, zone) {
  const at = instant(value);
  if (!at) return null;
  return formatter(zone, "zone", { timeZoneName: "short" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? null;
}

// An instant in a zone with the zone named: "Nov 12, 2026, 4:30 PM PST".
export function formatZoneInstant(value, lang, zone) {
  const at = instant(value);
  if (!at) return null;
  const text = dateTimeFormatCore(lang ?? "en", {
    timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", // zone-labelled
  }).format(at);
  return `${text.replace(/[\u202F\u00A0]/gu, " ")} ${zoneLabel(at, zone)}`;
}
