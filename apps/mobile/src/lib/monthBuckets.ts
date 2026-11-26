import { deviceDay } from './evidenceTimestamp';

// BUG-UG-NATIVE-REWARDS-MONTH-GROUPS-COUNT-AN-EASTERN-EVENING-IN-THE-NEXT-MONTH-20261118
//: the Rewards and Workload month cards keyed each entry by its UTC
// month, so an action on the last evening of a month (10:30 PM ET on Oct 31)
// counted in the next month while its own ledger row, printed in the phone's
// zone, showed Oct 31. An entry now counts in the month its row shows: a
// timestamp (a reward's occurred_at) in the phone's own zone, and a date with
// no time (a workload log's logged_on) on its own calendar day, as deviceDay
// reads both .

export type MonthBucket = { key: string; label: string; count: number; total: number };

export function monthBuckets<T>(items: readonly T[], dateOf: (item: T) => string, valueOf: (item: T) => number, locale?: 'en-US' | 'es-US'): MonthBucket[] {
  const result = new Map<string, MonthBucket>();
  for (const item of items) {
    const date = deviceDay(dateOf(item));
    const key = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : 'unknown';
    const current = result.get(key) ?? { key, label: date ? date.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) : 'Unknown date', count: 0, total: 0 };
    current.count += 1; current.total += valueOf(item); result.set(key, current);
  }
  return [...result.values()].sort((left, right) => right.key.localeCompare(left.key));
}
