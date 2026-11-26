import { ANALYTICS_WINDOW_DAYS, analyticsAnonymityFloor } from "./contract.js";
import {
  average,
  enoughForCohort,
  keepOrganizationRows,
  protectedCohort,
  roundRate,
  suppressHeatmapCell,
} from "./privacy.js";

function datePartsInTimeZone(date, timeZone) {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  } catch {
    return null;
  }
}

function weekKey(iso, timeZone = "UTC") {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = datePartsInTimeZone(date, timeZone);
  if (!parts) return null;
  const utc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const day = weekday || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}

export function buildAttendanceAnalytics(snapshot = {}, viewer = {}, now = new Date()) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const cutoff = new Date(now.getTime() - ANALYTICS_WINDOW_DAYS.attendance * 24 * 60 * 60 * 1000)
    .toISOString();
  const upperBound = now.toISOString();
  const cutoffMs = Date.parse(cutoff);
  const upperBoundMs = Date.parse(upperBound);
  const events = keepOrganizationRows(snapshot.attendanceEvents, organizationId)
    .filter((event) => {
      const startsAtMs = Date.parse(event?.startsAt);
      return Number.isFinite(startsAtMs) && startsAtMs >= cutoffMs && startsAtMs <= upperBoundMs;
    });

  const rows = events.map((event) => {
    const checkIns = Number(event.checkIns) || 0;
    const expected = Number(event.rsvpGoing) || 0;
    return {
      id: event.id,
      chapterId: event.chapterId || null,
      startsAt: event.startsAt || null,
      timeZone: event.timeZone || snapshot.timeZone || "UTC",
      checkIns,
      expected,
      rate: expected > 0 ? roundRate((checkIns / expected) * 100) : null,
    };
  }).sort((a, b) => String(b.startsAt || "").localeCompare(String(a.startsAt || "")));

  const totalCheckIns = rows.reduce((sum, row) => sum + row.checkIns, 0);
  const totalsSuppressed = rows.some((row) => suppressHeatmapCell(row.checkIns, floor).suppressed);
  const weekly = new Map();
  for (const row of rows) {
    const key = weekKey(row.startsAt, row.timeZone);
    if (!key) continue;
    const current = weekly.get(key) || { week: key, events: 0, checkIns: 0, expected: 0, suppressed: false };
    current.events += 1;
    current.checkIns += row.checkIns;
    current.expected += row.expected;
    current.suppressed ||= suppressHeatmapCell(row.checkIns, floor).suppressed;
    weekly.set(key, current);
  }

  const byChapter = new Map();
  for (const row of rows) {
    if (!row.chapterId) continue;
    const current = byChapter.get(row.chapterId) || {
      id: row.chapterId,
      events: 0,
      checkIns: 0,
      expected: 0,
      suppressed: false,
    };
    current.events += 1;
    current.checkIns += row.checkIns;
    current.expected += row.expected;
    current.suppressed ||= suppressHeatmapCell(row.checkIns, floor).suppressed;
    byChapter.set(row.chapterId, current);
  }

  const firstTime = Number(snapshot.attendanceCohorts?.firstTime) || 0;
  const repeat = Number(snapshot.attendanceCohorts?.repeat) || 0;
  const cohorts = snapshot.attendanceCohorts?.organizationId === organizationId
    && enoughForCohort(firstTime, floor)
    && enoughForCohort(repeat, floor)
    ? {
      enoughData: true,
      reason: null,
      minCohort: floor,
      firstTime,
      repeat,
    }
    : protectedCohort("anonymity_floor", floor);

  const chapterRows = [...byChapter.values()].map((row) => ({
    ...row,
    checkIns: row.suppressed ? null : row.checkIns,
    expected: row.suppressed ? null : row.expected,
    rate: !row.suppressed && row.expected > 0 ? roundRate((row.checkIns / row.expected) * 100) : null,
  })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || a.id.localeCompare(b.id));

  return {
    windowDays: ANALYTICS_WINDOW_DAYS.attendance,
    enoughData: rows.length > 0,
    reason: rows.length ? null : "empty",
    totals: {
      events: rows.length,
      suppressed: totalsSuppressed,
      checkIns: totalsSuppressed ? null : totalCheckIns,
      averagePerEvent: totalsSuppressed ? null : (average(rows.map((row) => row.checkIns)) ?? 0),
      bestAttendance: totalsSuppressed ? null : rows.reduce((max, row) => Math.max(max, row.checkIns), 0),
    },
    trend: [...weekly.values()]
      .map((row) => ({
        ...row,
        checkIns: row.suppressed ? null : row.checkIns,
        expected: row.suppressed ? null : row.expected,
        rate: !row.suppressed && row.expected > 0 ? roundRate((row.checkIns / row.expected) * 100) : null,
      }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    chapters: chapterRows,
    cohorts,
    recent: rows.slice(0, 8).map((row) => {
      const protectedCheckIns = suppressHeatmapCell(row.checkIns, floor);
      return {
        ...row,
        checkIns: protectedCheckIns.value,
        expected: protectedCheckIns.suppressed ? null : row.expected,
        rate: protectedCheckIns.suppressed ? null : row.rate,
        suppressed: protectedCheckIns.suppressed,
      };
    }),
  };
}
