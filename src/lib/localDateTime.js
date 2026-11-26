// `datetime-local` carries a wall-clock value with no zone. Keep display in
// the viewer's local time and convert submitted values to explicit UTC.
export function localDateTimeInputValue(value, offsetMinutes = null) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (offsetMinutes !== null) {
    return new Date(date.getTime() - offsetMinutes * 60_000).toISOString().slice(0, 16);
  }
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateTimeInputToIso(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

// Named so a raw Intl.DateTimeFormat call site does not inline hour options
// (the 12-hour clock guard in tests/i18n-coverage.test.jsx). `h23` is the
// conversion cycle, not a displayed clock.
const TWENTY_FOUR_HOUR_CYCLE = "h23";
const NAMED_ZONE_WALL_CLOCK = Object.freeze({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: TWENTY_FOUR_HOUR_CYCLE,
});
const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function civilDate(year, month, day, hour, minute, second) {
  const date = new Date(0);
  // Date.UTC treats years below 100 as 1900-based; keep the actual civil year.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

// One formatter per zone: an unknown zone throws when it is built and is
// never kept.
const wallClockFormats = new Map();
function wallClockFormat(timeZone) {
  let format = wallClockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { ...NAMED_ZONE_WALL_CLOCK, timeZone });
    wallClockFormats.set(timeZone, format);
  }
  return format;
}

// The wall clock a zone shows at an instant, as the milliseconds of that
// clock read as if it were UTC; minus the instant, it is the zone's offset.
export function wallClockMillis(instant, timeZone) {
  const bag = {};
  for (const part of wallClockFormat(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") bag[part.type] = Number(part.value);
  }
  return civilDate(bag.year, bag.month, bag.day, bag.hour % 24, bag.minute, bag.second).getTime();
}

// Reads a `datetime-local` value as wall time in a named IANA zone instead of
// the browser's zone. Returns null for invalid components, nonexistent wall
// time or an unknown zone, so callers can refuse the submit.
export function zonedDateTimeInputToIso(value, timeZone) {
  if (!value || !timeZone) return null;
  const match = DATETIME_LOCAL.exec(String(value).trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part || 0));
  const date = civilDate(year, month, day, hour, minute, second);
  if (year === 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  const requested = date.getTime();
  try {
    let instant = requested;
    instant -= wallClockMillis(instant, timeZone) - requested;
    instant -= wallClockMillis(instant, timeZone) - requested;
    if (wallClockMillis(instant, timeZone) !== requested) return null;
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}
