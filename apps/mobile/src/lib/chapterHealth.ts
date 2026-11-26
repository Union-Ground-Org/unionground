import type { MobileHealthChapter, MobileHealthDrivers } from '../services/supabase';

export function utcHealthDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function validHealthDate(value: string, maximum: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !/^\d{4}-\d{2}-\d{2}$/.test(maximum) || value > maximum) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

export function mergePreviewHealthSnapshot(
  chapter: MobileHealthChapter,
  measuredOn: string,
  drivers: MobileHealthDrivers,
  recordedAt: string,
  recordedBy: string | undefined,
): MobileHealthChapter {
  const score = Math.round(Object.values(drivers).reduce((total, value) => total + value, 0) / Object.keys(drivers).length);
  const correction = chapter.measuredOn === measuredOn;
  const becomesLatest = chapter.measuredOn === null || measuredOn >= chapter.measuredOn;
  const trend = chapter.cohortProtected ? [] : [
    ...chapter.trend.filter((point) => point.measuredOn !== measuredOn),
    { measuredOn, score },
  ].sort((left, right) => left.measuredOn.localeCompare(right.measuredOn)).slice(-12);

  if (!becomesLatest) return { ...chapter, trend };
  return {
    ...chapter,
    measuredOn,
    score: chapter.cohortProtected ? null : score,
    drivers: chapter.cohortProtected ? null : drivers,
    trend,
    recordedAt: correction ? chapter.recordedAt : recordedAt,
    recordedBy: correction ? chapter.recordedBy : recordedBy,
    revisedAt: correction ? recordedAt : null,
    revisedBy: correction ? recordedBy : null,
  };
}

export const HEALTH_DRIVER_FIELDS: ReadonlyArray<{ key: keyof MobileHealthDrivers; label: string }> = [
  { key: 'participation', label: 'Participation' },
  { key: 'caseTimeliness', label: 'Issue response times' },
  { key: 'stewardCapacity', label: 'Committee support' },
  { key: 'trainingCoverage', label: 'Training' },
  { key: 'communicationReach', label: 'Communication' },
  { key: 'governanceReadiness', label: 'Campaign planning' },
];

// Rows come only from the labelled catalogue: a driver key with no approved
// label is dropped rather than shown as raw key text.
export function healthDriverRows(
  drivers: Partial<Record<keyof MobileHealthDrivers, number>>,
): { key: keyof MobileHealthDrivers; label: string; value: number }[] {
  return HEALTH_DRIVER_FIELDS.flatMap(({ key, label }) => {
    const value = drivers[key];
    return typeof value === 'number' ? [{ key, label, value }] : [];
  });
}

// #7001 gate round 1 (r1s1, r1g1): record_chapter_health_snapshot upserts on
// (chapter_id, measured_on), so any save whose date already holds a snapshot
// replaces measures other staff read, whichever form opened it. A known date
// (the latest snapshot or a point on the trend) is a replacement. A back-dated
// save may land on a day older than the trend shows, so it confirms too. Only
// a new snapshot for the database's own date with no row yet saves directly.
export type HealthSnapshotOverwrite = 'replaces' | 'may_replace' | null;

export function healthSnapshotOverwrite(chapter: Pick<MobileHealthChapter, 'measuredOn' | 'trend' | 'databaseDate'>, snapshotDate: string): HealthSnapshotOverwrite {
  const known = new Set([chapter.measuredOn, ...chapter.trend.map((point) => point.measuredOn)].filter(Boolean));
  if (known.has(snapshotDate)) return 'replaces';
  return snapshotDate === chapter.databaseDate ? null : 'may_replace';
}

export function healthSnapshotOverwriteMessage(overwrite: Exclude<HealthSnapshotOverwrite, null>, snapshotDate: string): string {
  return overwrite === 'replaces'
    ? `This replaces the ${snapshotDate} snapshot for this campaign. Everyone who reads campaign health sees the new measures, recorded under your name.`
    : `If this campaign already has a ${snapshotDate} snapshot, this replaces it. Everyone who reads campaign health sees the new measures, recorded under your name.`;
}
