import { calendarFreeBusyFailure } from "./errors.js";
import { isCalendarProvider } from "./config.js";

const MAX_WINDOWS = 500;
const LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

function asInstant(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/.exec(text);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? match[1] : null;
}

function withinHorizon(startsAt, endsAt, nowIso) {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return false;
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return end > now - LOOKBACK_MS && start < now + LOOKAHEAD_MS;
}

function collectWindows(rawWindows, nowIso) {
  if (!Array.isArray(rawWindows)) return [];
  const windows = [];
  for (const row of rawWindows) {
    const startsAt = asInstant(row?.startsAt ?? row?.start);
    const endsAt = asInstant(row?.endsAt ?? row?.end);
    if (!startsAt || !endsAt) continue;
    if (!withinHorizon(startsAt, endsAt, nowIso)) continue;
    // Detect overflow only when another valid in-horizon window would be lost.
    if (windows.length >= MAX_WINDOWS) return null;
    windows.push({ startsAt, endsAt });
  }
  return windows;
}

function microsoftInstant(value) {
  const raw = String(value?.dateTime || "");
  if (!raw) return value;
  // Graph may send Z, an explicit ±HH:MM offset, or a timezone-free clock.
  // Pass a trailing Z or offset through; only a timezone-free value is UTC.
  return /[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`;
}

export function parseGoogleFreeBusy(payload, nowIso) {
  const busy = payload?.calendars?.primary?.busy;
  return collectWindows(Array.isArray(busy) ? busy : [], nowIso);
}

export function parseMicrosoftSchedule(payload, nowIso) {
  const first = Array.isArray(payload?.value) ? payload.value[0] : null;
  const schedule = first?.scheduleItems;
  const busy = Array.isArray(schedule)
    ? schedule.filter((item) => item?.status === "busy" || item?.status === "tentative" || item?.status === "oof" || item?.status === "workingElsewhere")
    : [];
  return collectWindows(busy.map((item) => ({
    start: microsoftInstant(item?.start),
    end: microsoftInstant(item?.end),
  })), nowIso);
}

export function parseFreeBusyResponse(provider, payload, nowIso) {
  if (!isCalendarProvider(provider)) return calendarFreeBusyFailure("unknown_provider");
  if (!nowIso || !asInstant(nowIso)) return calendarFreeBusyFailure("invalid_input", { field: "now" });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return calendarFreeBusyFailure("provider_error");
  }
  // Both providers can return HTTP success while a calendar lookup failed.
  // Such a response confirms no availability; keep it on the sync error path.
  const googleErrors = payload.calendars?.primary?.errors;
  if (payload.error
    || (provider === "google" && googleErrors && (!Array.isArray(googleErrors) || googleErrors.length > 0))
    || (provider === "microsoft" && Array.isArray(payload.value) && payload.value.some((schedule) => schedule?.error))) {
    return calendarFreeBusyFailure("provider_error");
  }
  const windows = provider === "microsoft"
    ? parseMicrosoftSchedule(payload, nowIso)
    : parseGoogleFreeBusy(payload, nowIso);
  if (windows === null) return calendarFreeBusyFailure("provider_error");
  return { ok: true, provider, windows };
}

export function slotConflictsWithBusy(slotStartIso, slotEndIso, windows) {
  const slotStart = Date.parse(slotStartIso);
  const slotEnd = Date.parse(slotEndIso);
  if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd <= slotStart) return false;
  return (windows || []).some((window) => {
    const busyStart = Date.parse(window.startsAt);
    const busyEnd = Date.parse(window.endsAt);
    return Number.isFinite(busyStart) && Number.isFinite(busyEnd) && busyStart < slotEnd && busyEnd > slotStart;
  });
}

export function presentBusyConflicts(slots, windows) {
  return (slots || []).map((slot) => ({
    ...slot,
    conflict: slotConflictsWithBusy(slot.startsAt, slot.endsAt, windows),
  }));
}
