import { dateTimeFormatCore } from "./format.js";
import { formatZoneInstant, groupTimeZone } from "../zoneTime.js";

// Web-only date helpers, kept out of format.js because the native app imports
// that module and holds it to a catalogue budget.
//
// A full date and time with the time zone named (Lovable audit "time and
// labels", APP-VP-04, APP-STEWARD-06, -12; REQ-UNIONGROUND-LOVABLE-AUDIT-
// WEBAPP-FIXES-20261103): "Oct 23, 2026, 5:00 PM EDT", never a bare "5:00 PM".
export const DATE_TIME_WITH_ZONE_OPTIONS = Object.freeze({
  year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export function formatDateTimeWithZone(value, lang, options = DATE_TIME_WITH_ZONE_OPTIONS) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatCore(lang, options).format(date);
}

// A date with its year ("Jul 23, 2026"), for lists where a month and day alone
// cannot be placed in time (APP-ADMIN-02, -10).
export function formatDateWithYear(value, lang) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatCore(lang, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

// UX-UG-TIMES-SHOWN-WITHOUT-A-ZONE-AND-IN-SEVERAL-FORMATS-20261122
// (#9530): the one way a web screen prints a moment a person reads, "Aug 21,
// 2025, 1:00 PM EDT" / "21 ago 2025, 1:00 p. m. EDT", never the bare stamp
// with seconds that dateTimeFormat(lang) prints with no options. Moments are
// labelled with their zone. timeZone is the owning group's zone as its payload
// delivers it (docs/contracts/time-zones-per-group.md). Today every screen that
// calls this reads the starting zone the contract names, through
// groupTimeZone: the organization switch of #9446 is held and these payloads
// deliver no group zone, so no call site passes one yet. A call site takes its
// group's zone once its payload carries one; that work belongs to #9446 or the
// rest of #9530. A null, empty or unreadable value prints "", never 1970.
// eslint.config.js refuses the bare stamp under src/.
export function formatGroupMoment(value, lang, timeZone) {
  return formatZoneInstant(value, lang, groupTimeZone(timeZone)) ?? "";
}

// A fact that is a day and not a moment (a source date, a filing date) shows
// as that date for everyone and never shifts with a zone: "2026-07-20" reads
// "Jul 20, 2026" / "20 jul 2026". Anything that is not a YYYY-MM-DD calendar
// day answers "" so the caller can fall back.
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
export function formatCalendarDay(value, lang) {
  const match = typeof value === "string" ? CALENDAR_DAY.exec(value.trim()) : null;
  if (!match) return "";
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1) return ""; // year 0000 has no numeric year without an era; the caller shows the stored text
  // setUTCFullYear reads a year below 100 as written (Date.UTC adds 1900).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  // The day was built at UTC midnight, so it is read back in UTC: no zone moves it.
  return dateTimeFormatCore(lang, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}
