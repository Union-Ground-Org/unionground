// The Eastern names of the shared time-zone module, src/lib/zoneTime.js, kept
// for their existing importers (SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113).
// Each one is the zone function with New York's zone filled in, so web and
// native keep one implementation. New code takes its zone from the group the
// item belongs to (REQ-UG-TIME-ZONES-PER-GROUP-20261122;
// docs/contracts/time-zones-per-group.md): call zoneTime.js with
// groupTimeZone(group), not these.
import { addDays, formatZoneInstant, nextZoneMidnight, zoneDay, zoneLabel, zoneMidnight } from "./zoneTime.js";

export const EASTERN_TIME_ZONE = "America/New_York"; // fixed-zone: the Eastern names of the zone module

// The Eastern calendar day of an instant, as YYYY-MM-DD; null when unreadable.
export function easternDay(value) {
  return zoneDay(value, EASTERN_TIME_ZONE);
}

// A calendar day moved by whole days. The civil date moves, so a 23- or
// 25-hour Eastern day still counts as one day.
export function addEasternDays(day, days) {
  return addDays(day, days);
}

// The instant an Eastern calendar day begins; null for an unreadable day.
export function easternMidnight(day) {
  return zoneMidnight(day, EASTERN_TIME_ZONE);
}

// The next Eastern midnight after an instant. An unreadable instant gives an
// Invalid Date, as before.
export function nextEasternMidnight(now) {
  return nextZoneMidnight(now, EASTERN_TIME_ZONE);
}

// "EST" or "EDT" for the instant; null when unreadable.
export function easternZoneLabel(value) {
  return zoneLabel(value, EASTERN_TIME_ZONE);
}

// An Eastern instant with its zone named: "Nov 12, 2026, 7:30 PM EST".
// Spanish keeps the same EST/EDT label (CLDR would print a GMT offset).
export function formatEasternInstant(value, lang = "en") {
  return formatZoneInstant(value, lang, EASTERN_TIME_ZONE);
}
