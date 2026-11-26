import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { MobileHealthChapter, MobileHealthDrivers } from '../services/supabase';
import { HEALTH_DRIVER_FIELDS, healthDriverRows, mergePreviewHealthSnapshot, utcHealthDate, validHealthDate } from './chapterHealth';

function healthDriverPanelSource(): string {
  const source = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
  return source.slice(source.indexOf('{chapter.drivers ?'), source.indexOf('Driver detail is hidden'));
}

const drivers: MobileHealthDrivers = {
  participation: 90,
  caseTimeliness: 80,
  stewardCapacity: 70,
  trainingCoverage: 60,
  communicationReach: 50,
  governanceReadiness: 40,
};

function chapter(): MobileHealthChapter {
  return {
    chapterId: 'chapter-a',
    chapterName: 'Campaign A',
    databaseDate: '2026-09-02',
    measuredOn: '2026-08-15',
    cohortProtected: false,
    memberCount: 24,
    score: 72,
    drivers: { ...drivers, participation: 82 },
    trend: [
      { measuredOn: '2026-07-15', score: 68 },
      { measuredOn: '2026-08-15', score: 72 },
    ],
    recordedAt: '2026-08-15T12:00:00Z',
    recordedBy: 'Original Author',
    revisedAt: null,
    revisedBy: null,
    coaching: [],
  };
}

describe('campaign health dates and preview state', () => {
  it('validates against the server date instead of the handset calendar', () => {
    expect(validHealthDate('2026-09-02', '2026-09-02')).toBe(true);
    expect(validHealthDate('2026-09-03', '2026-09-02')).toBe(false);
    expect(validHealthDate('2026-02-30', '2026-09-02')).toBe(false);
    expect(utcHealthDate(new Date('2026-09-02T23:59:59Z'))).toBe('2026-09-02');
  });

  it('adds a backfill point without replacing the latest summary', () => {
    const original = chapter();
    const next = mergePreviewHealthSnapshot(original, '2026-08-01', drivers, '2026-09-02T12:00:00Z', 'Backfill Author');
    expect(next.measuredOn).toBe('2026-08-15');
    expect(next.score).toBe(72);
    expect(next.recordedBy).toBe('Original Author');
    expect(next.trend).toEqual([
      { measuredOn: '2026-07-15', score: 68 },
      { measuredOn: '2026-08-01', score: 65 },
      { measuredOn: '2026-08-15', score: 72 },
    ]);
  });

  it('attributes a correction while preserving the original recording identity', () => {
    const next = mergePreviewHealthSnapshot(chapter(), '2026-08-15', drivers, '2026-09-02T12:00:00Z', 'Correcting Author');
    expect(next.measuredOn).toBe('2026-08-15');
    expect(next.score).toBe(65);
    expect(next.recordedBy).toBe('Original Author');
    expect(next.revisedBy).toBe('Correcting Author');
    expect(next.revisedAt).toBe('2026-09-02T12:00:00Z');
  });
});

describe('campaign health driver labels', () => {
  it('reads every driver out as its written label instead of a split camelCase key', () => {
    expect(healthDriverRows(drivers)).toEqual([
      { key: 'participation', label: 'Participation', value: 90 },
      { key: 'caseTimeliness', label: 'Issue response times', value: 80 },
      { key: 'stewardCapacity', label: 'Committee support', value: 70 },
      { key: 'trainingCoverage', label: 'Training', value: 60 },
      { key: 'communicationReach', label: 'Communication', value: 50 },
      { key: 'governanceReadiness', label: 'Campaign planning', value: 40 },
    ]);
    for (const { label } of HEALTH_DRIVER_FIELDS) expect(label).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
  });

  it('never shows a driver key that has no approved label', () => {
    const served: Record<string, number> = { participation: 90, memberSentiment: 55 };
    expect(healthDriverRows(served)).toEqual([{ key: 'participation', label: 'Participation', value: 90 }]);
  });

  it('covers each measured driver exactly once and in the order of the snapshot form', () => {
    expect(HEALTH_DRIVER_FIELDS.map((field) => field.key)).toEqual(Object.keys(drivers));
  });

  it('renders the summary panel from the shared labels, not from the key text', () => {
    const panel = healthDriverPanelSource();
    expect(panel).toContain('healthDriverRows(chapter.drivers)');
    expect(panel).not.toContain("replace(/([A-Z])/g, ' $1')");
    expect(panel).not.toContain('Object.entries(chapter.drivers)');
  });
});
