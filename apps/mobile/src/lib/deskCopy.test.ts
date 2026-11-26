import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultShortcutKeys,
  formatEventWhen,
  isOpenTaskStatus,
  isPastEvent,
  orderEventsForDesk,
  reconcileShortcutKeys,
  statusLabel,
} from './deskCopy';

// @types/node stopped declaring TZ on ProcessEnv, so through Expo's
// `[key: string]: any` env index every read of process.env.TZ became `any`.
// Go through one typed view of the same object instead.
const env: Record<string, string | undefined> = process.env;
const originalTz = env.TZ;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTz === undefined) delete env.TZ;
  else env.TZ = originalTz;
});

describe('statusLabel', () => {
  it('sentence-cases stored statuses and keeps label-shaped values', () => {
    expect(statusLabel('requested')).toBe('Requested');
    expect(statusLabel('on_ballot')).toBe('On ballot');
    expect(statusLabel('Worker action')).toBe('Worker action');
    expect(statusLabel('')).toBe('');
  });
});

describe('formatEventWhen', () => {
  const now = new Date('2026-08-31T12:00:00-04:00');

  it('uses one grammar and adds the year only outside the current one', () => {
    expect(formatEventWhen('2026-08-30T14:00:00-04:00', now)).toBe('Sun, Aug 30 · 2:00 PM');
    expect(formatEventWhen('2025-08-24T18:00:00-04:00', now)).toBe('Sun, Aug 24, 2025 · 6:00 PM');
    expect(formatEventWhen('2026-07-30T00:05:00-04:00', now)).toBe('Thu, Jul 30 · 12:05 AM');
  });

  it('reads the meeting in Eastern time from any device timezone', () => {
    for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
      env.TZ = tz;
      expect(formatEventWhen('2026-08-30T14:00:00-04:00', now), tz).toBe('Sun, Aug 30 · 2:00 PM');
      // An instant that is still Saturday in Los Angeles is Sunday in Boston.
      expect(formatEventWhen('2026-08-30T00:30:00-04:00', now), tz).toBe('Sun, Aug 30 · 12:30 AM');
    }
  });

  it('returns an unparseable value untouched instead of printing Invalid Date', () => {
    expect(formatEventWhen('TBD', now)).toBe('TBD');
  });

  it('does not depend on the optional native dayPeriod part at launch', () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    // The physical iPhone crashed during preview-module evaluation because
    // its native formatter omitted dayPeriod. Exercise a real 24-hour
    // formatter, not a fabricated AM/PM fallback or device-local hour.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
      return new NativeDateTimeFormat(locale, { ...options, hour12: false });
    });
    expect(formatEventWhen('2026-08-30T14:00:00-04:00', now)).toBe('Sun, Aug 30 · 2:00 PM');
    expect(formatEventWhen('2026-08-30T00:05:00-04:00', now)).toBe('Sun, Aug 30 · 12:05 AM');
    expect(formatEventWhen('2026-08-30T12:05:00-04:00', now)).toBe('Sun, Aug 30 · 12:05 PM');
    expect(formatEventWhen('2026-01-15T23:30:00-05:00', now)).toBe('Thu, Jan 15 · 11:30 PM');
  });

  it('keeps friendly dates when native formatToParts supplies no component fields, including h24 midnight', () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
      const formatter = new NativeDateTimeFormat(locale, { ...options, hour12: undefined, hourCycle: 'h24' });
      vi.spyOn(formatter, 'formatToParts').mockImplementation((date) => [{ type: 'literal', value: formatter.format(date) }]);
      return formatter;
    });
    expect(formatEventWhen('2026-08-30T14:00:00-04:00', now)).toBe('Sun, Aug 30 · 2:00 PM');
    expect(formatEventWhen('2026-08-30T00:05:00-04:00', now)).toBe('Sun, Aug 30 · 12:05 AM');
    expect(formatEventWhen('2025-08-24T18:00:00-04:00', now)).toBe('Sun, Aug 24, 2025 · 6:00 PM');
  });
});

describe('orderEventsForDesk', () => {
  const now = new Date('2026-08-31T12:00:00-04:00').getTime();
  const events = [
    { id: 'past-old', startsAt: '2025-08-24T18:00:00-04:00' },
    { id: 'later', startsAt: '2026-09-12T18:00:00-04:00' },
    { id: 'undated' },
    { id: 'unparseable', startsAt: 'TBD' },
    { id: 'past-recent', startsAt: '2026-08-30T14:00:00-04:00' },
    { id: 'soon', startsAt: '2026-09-03T18:00:00-04:00' },
  ];

  it('puts upcoming meetings first, soonest at the top, then past meetings most recent first', () => {
    const { upcoming, past } = orderEventsForDesk(events, now);
    expect(upcoming.map((event) => event.id)).toEqual(['soon', 'later', 'undated', 'unparseable']);
    expect(past.map((event) => event.id)).toEqual(['past-recent', 'past-old']);
  });

  // isPastEvent compares two absolute instants and makes no time-zone call,
  // so each boundary is asserted once and the device zone is not touched.
  it('turns a meeting past only after its start instant', () => {
    const start = '2026-08-30T14:00:00-04:00';
    expect(isPastEvent({ startsAt: start }, new Date('2026-08-30T13:59:59-04:00').getTime())).toBe(false);
    expect(isPastEvent({ startsAt: start }, new Date('2026-08-30T14:00:00-04:00').getTime())).toBe(false);
    expect(isPastEvent({ startsAt: start }, new Date('2026-08-30T14:00:01-04:00').getTime())).toBe(true);
    expect(isPastEvent({}, now)).toBe(false);
    expect(isPastEvent({ startsAt: 'TBD' }, now)).toBe(false);
  });
});

describe('isOpenTaskStatus', () => {
  it('treats finished statuses as closed and everything else as open', () => {
    for (const status of ['open', 'in progress', 'blocked', 'to do', 'in review', 'needs_review']) expect(isOpenTaskStatus(status), status).toBe(true);
    for (const status of ['done', 'Done', 'completed', 'complete', 'closed', 'resolved', 'canceled', 'cancelled', 'archived']) expect(isOpenTaskStatus(status), status).toBe(false);
  });
});

describe('defaultShortcutKeys', () => {
  const groups = [
    { items: [{ key: 'a1' }, { key: 'a2' }, { key: 'a3' }, { key: 'a4' }, { key: 'a5' }] },
    { items: [{ key: 'b1' }, { key: 'b2' }] },
    { items: [{ key: 'c1' }] },
  ];

  it('takes one destination per group before filling from the first group', () => {
    expect(defaultShortcutKeys(groups, 4)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });

  it('never repeats a key and stops at the limit', () => {
    expect(defaultShortcutKeys([{ items: [{ key: 'a1' }, { key: 'a1' }] }, { items: [{ key: 'a1' }] }], 4)).toEqual(['a1']);
    expect(defaultShortcutKeys(groups, 2)).toEqual(['a1', 'b1']);
  });
});

describe('reconcileShortcutKeys', () => {
  const catalog = ['a1', 'a2', 'b1', 'c1'];
  const defaults = ['a1', 'b1', 'c1', 'a2'];

  it('uses the defaults when nothing is stored', () => {
    expect(reconcileShortcutKeys(null, catalog, defaults, 4)).toEqual(defaults);
  });

  it('keeps a valid stored selection in the worker\'s order', () => {
    expect(reconcileShortcutKeys(['c1', 'a2'], catalog, defaults, 4)).toEqual(['c1', 'a2']);
  });

  it('drops removed and duplicate keys and backfills their slots from the defaults', () => {
    expect(reconcileShortcutKeys(['gone', 'c1'], catalog, defaults, 4)).toEqual(['c1', 'a1']);
    expect(reconcileShortcutKeys(['gone'], catalog, defaults, 4)).toEqual(['a1']);
    expect(reconcileShortcutKeys(['c1', 'c1', 'a2'], catalog, defaults, 4)).toEqual(['c1', 'a2', 'a1']);
  });

  it('keeps an explicitly emptied row empty and never exceeds the limit', () => {
    expect(reconcileShortcutKeys([], catalog, defaults, 4)).toEqual([]);
    expect(reconcileShortcutKeys(['a1', 'a2', 'b1', 'c1', 'a1'], catalog, defaults, 3)).toEqual(['a1', 'a2', 'b1']);
  });
});
