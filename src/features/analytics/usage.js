import { ANALYTICS_WINDOW_DAYS, analyticsAnonymityFloor } from "./contract.js";
import { enoughForCohort, keepOrganizationRows } from "./privacy.js";

function dayKey(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function usageCutoffIso(now = new Date(), days = ANALYTICS_WINDOW_DAYS.usage) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function buildPortalUsageSummary(snapshot = {}, viewer = {}, now = new Date()) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const cutoff = usageCutoffIso(now);
  const today = now.toISOString().slice(0, 10);
  const views = keepOrganizationRows(snapshot.usageViews, organizationId)
    // Day aggregates use a half-open lower bound. An inclusive cutoff adds a
    // 31st calendar bucket to a 30-day window; undated and future rows cannot
    // be assigned to the requested observation period.
    .filter((row) => typeof row.day === "string"
      && row.day > cutoff.slice(0, 10)
      && row.day <= today);

  const byPath = new Map();
  const byHat = new Map();
  const byDay = new Map();
  let total = 0;

  for (const row of views) {
    const count = Number(row.count) || 0;
    total += count;
    const path = row.path || "unknown";
    const hat = row.hat || "unknown";
    const day = dayKey(row.day);
    byPath.set(path, (byPath.get(path) || 0) + count);
    byHat.set(hat, (byHat.get(hat) || 0) + count);
    byDay.set(day, (byDay.get(day) || 0) + count);
  }

  const windows = snapshot.usageWindows?.organizationId === organizationId
    ? snapshot.usageWindows
    : { dau: null, wau: null, mau: null, organizationId, suppressed: { dau: true, wau: true, mau: true } };

  const ranked = (map) => [...map.entries()]
    .filter(([, count]) => enoughForCohort(count, floor))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    windowDays: ANALYTICS_WINDOW_DAYS.usage,
    totalViews: enoughForCohort(total, floor) ? total : null,
    totalViewsSuppressed: !enoughForCohort(total, floor),
    minCohort: floor,
    dau: windows.dau ?? null,
    wau: windows.wau ?? null,
    mau: windows.mau ?? null,
    suppressed: windows.suppressed || {
      dau: windows.dau == null,
      wau: windows.wau == null,
      mau: windows.mau == null,
    },
    byPath: ranked(byPath).slice(0, 12),
    byHat: ranked(byHat),
    daily: [...byDay.entries()]
      .filter(([, count]) => enoughForCohort(count, floor))
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}
