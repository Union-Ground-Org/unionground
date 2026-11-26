import { afterEach, describe, expect, it, vi } from 'vitest';

import { deviceDateTime } from './evidenceTimestamp';
import { monthBuckets } from './monthBuckets';

afterEach(() => { vi.unstubAllEnvs(); });

// BUG-UG-NATIVE-REWARDS-MONTH-GROUPS-COUNT-AN-EASTERN-EVENING-IN-THE-NEXT-MONTH-20261118
// (#9170): each entry counts in the month its own ledger row shows.
type Reward = { occurredAt: string; points: number };
const rewardMonths = (events: Reward[], locale?: 'en-US' | 'es-US') => monthBuckets(events, (event) => event.occurredAt, (event) => event.points, locale);

// 10:30 PM ET on Sat Oct 31, 2026, the record's example: already November in UTC.
const EASTERN_EVENING = '2026-11-01T02:30:00Z';
// 1:30 AM ET on Sun Nov 1, 2026: early the next morning.
const EASTERN_EARLY = '2026-11-01T05:30:00Z';
// 1:00 AM in Tokyo on Sun Nov 1, 2026: still October in UTC.
const TOKYO_EARLY = '2026-10-31T16:00:00Z';

const labels = {
  'en-US': { '2026-10': 'October 2026', '2026-11': 'November 2026' },
  'es-US': { '2026-10': 'octubre de 2026', '2026-11': 'noviembre de 2026' },
} as const;
// The month each instant falls in on a phone set to each zone.
const expected: Record<string, Record<string, '2026-10' | '2026-11'>> = {
  'America/New_York': { [EASTERN_EVENING]: '2026-10', [EASTERN_EARLY]: '2026-11', [TOKYO_EARLY]: '2026-10' },
  'America/Los_Angeles': { [EASTERN_EVENING]: '2026-10', [EASTERN_EARLY]: '2026-10', [TOKYO_EARLY]: '2026-10' },
  'Pacific/Honolulu': { [EASTERN_EVENING]: '2026-10', [EASTERN_EARLY]: '2026-10', [TOKYO_EARLY]: '2026-10' },
  'Asia/Tokyo': { [EASTERN_EVENING]: '2026-11', [EASTERN_EARLY]: '2026-11', [TOKYO_EARLY]: '2026-11' },
};
const locales: Array<'en-US' | 'es-US'> = ['en-US', 'es-US'];
const cases = Object.keys(expected).flatMap((zone) => locales.map((locale) => [zone, locale] as [string, 'en-US' | 'es-US']));

describe('Contributions month groups', () => {
  it.each(cases)('count each action in the month its ledger row shows, on a phone set to %s (%s)', (zone, locale) => {
    vi.stubEnv('TZ', zone);
    for (const occurredAt of [EASTERN_EVENING, EASTERN_EARLY, TOKYO_EARLY]) {
      const month = expected[zone]![occurredAt]!;
      // The ledger row and month bucket both use the phone's existing clock.
      const displayMonth = labels['en-US'][month].slice(0, 3);
      const stamp = deviceDateTime(occurredAt, 'en-US');
      expect(stamp?.startsWith(`${displayMonth} `)).toBe(true);
      expect(rewardMonths([{ occurredAt, points: 10 }], locale)).toEqual([{ key: month, label: labels[locale][month], count: 1, total: 10 }]);
    }
  });

  it('splits an Eastern month-end evening and the next morning into October and November on an Eastern phone', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const months = rewardMonths([{ occurredAt: EASTERN_EVENING, points: 10 }, { occurredAt: EASTERN_EARLY, points: 5 }], 'en-US');
    expect(months).toEqual([
      { key: '2026-11', label: 'November 2026', count: 1, total: 5 },
      { key: '2026-10', label: 'October 2026', count: 1, total: 10 },
    ]);
  });

  it('keeps an unreadable time in its own group', () => {
    expect(rewardMonths([{ occurredAt: 'not a time', points: 3 }])).toEqual([{ key: 'unknown', label: 'Unknown date', count: 1, total: 3 }]);
  });
});

describe('Workload month groups', () => {
  it.each(['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Pacific/Kiritimati'])('keep a log on the month of its date on a phone set to %s', (zone) => {
    vi.stubEnv('TZ', zone);
    const logs = [{ loggedOn: '2026-10-31', items: 2 }, { loggedOn: '2026-11-01', items: 3 }];
    expect(monthBuckets(logs, (log) => log.loggedOn, (log) => log.items, 'en-US')).toEqual([
      { key: '2026-11', label: 'November 2026', count: 1, total: 3 },
      { key: '2026-10', label: 'October 2026', count: 1, total: 2 },
    ]);
  });
});
