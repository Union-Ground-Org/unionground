import { EASTERN_TIME_ZONE, easternZoneLabel } from "./easternTime.js";
import { dateTimeFormat } from "./i18n.js";

// Activity is always an absolute Eastern instant, independent of the
// device zone. Intl applies New York's standard/daylight offset for the date.
export function formatEasternTimestamp(value, lang, { daylightName = false, weekday } = {}) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  // Keep EST/EDT explicit in either app language; Spanish CLDR otherwise
  // substitutes a numeric GMT offset for New York's short zone name.
  const zone = daylightName ? easternZoneLabel(date) : "ET";
  return {
    dateTime: date.toISOString(),
    text: `${dateTimeFormat(lang, {
      timeZone: EASTERN_TIME_ZONE,
      weekday,
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", // zone-labelled: ET or EST/EDT follows
    }).format(date)} ${zone}`,
  };
}
