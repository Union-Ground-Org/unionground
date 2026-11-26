// Relative and clock formatting for the alternate shell. The design's `fmt`
// module wrote English only and assumed Eastern wall-clock timestamps; here
// the words come from the altShell catalogue (English and Spanish) and the
// instants are real dates, formatted in the member's locale. The side clock
// alone is pinned to Eastern time, labelled ET, as the design specifies.
import { localeFor } from "../lib/i18n.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function calendarDaysBetween(later, earlier) {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

// "just now", "3 hours ago", "yesterday", "in 4 days": the design's fmt.ago /
// fmt.until, with every word translated.
export function relativeTime(value, t, now = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const diff = now - date;
  if (diff < 0) return relativeFuture(date, t, now);
  if (diff < MINUTE) return t("altShell.justNow");
  if (diff < HOUR) return t("altShell.minutesAgo", { count: Math.floor(diff / MINUTE) });
  const days = calendarDaysBetween(now, date);
  if (days === 0) return t("altShell.hoursAgo", { count: Math.max(1, Math.floor(diff / HOUR)) });
  if (days === 1) return t("altShell.yesterday");
  if (days < 14) return t("altShell.daysAgo", { count: days });
  if (days < 62) return t("altShell.weeksAgo", { count: Math.floor(days / 7) });
  if (days < 365) return t("altShell.monthsAgo", { count: Math.floor(days / 30.4) });
  return t("altShell.overYearAgo");
}

function relativeFuture(date, t, now) {
  const diff = date - now;
  if (diff < HOUR) return t("altShell.inMinutes", { count: Math.max(1, Math.round(diff / MINUTE)) });
  const days = calendarDaysBetween(date, now);
  if (days === 0) return t("altShell.inHours", { count: Math.max(1, Math.round(diff / HOUR)) });
  if (days === 1) return t("altShell.tomorrow");
  if (days < 14) return t("altShell.inDays", { count: days });
  return t("altShell.inWeeks", { count: Math.round(days / 7) });
}

export function formatDay(value, lang, { year = false } = {}) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleDateString(localeFor(lang), { month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}) });
}

export function formatShortDay(value, lang) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" });
}

export function formatClock(value, lang) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleTimeString(localeFor(lang), { hour: "numeric", minute: "2-digit" });
}

// The side nav clock: Eastern time, labelled ET, whatever the device's zone.
export function formatEasternClock(value, lang) {
  const date = toDate(value);
  if (!date) return "";
  try {
    return date.toLocaleTimeString(localeFor(lang), { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  } catch {
    return formatClock(date, lang);
  }
}

export function formatNumber(value, lang) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toLocaleString(localeFor(lang));
}
