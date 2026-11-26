import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

// Rows a screen keeps beyond the page its own refresh replaces (older Steward
// Direct pages, earlier messages in a thread) carry the time of the read that
// last returned them, and leave the screen once they are too old.
//
// Age is measured on two clocks and the larger reading wins, so neither can
// keep a row longer than the bound. The wall clock (Date.now) keeps counting
// while the device sleeps but moves when the device time is changed; the
// monotonic clock (performance.now) ignores time changes but may pause while
// the device sleeps. Setting the time forward only ages rows early (they are
// read again); setting it back leaves the monotonic clock counting.

export type FreshnessStamp = { wall: number; mono: number };
export type Kept<T> = { row: T; seen: FreshnessStamp };

function monotonicNow(): number {
  const clock = globalThis.performance;
  return clock && typeof clock.now === 'function' ? clock.now() : Date.now();
}

export function freshnessNow(): FreshnessStamp {
  return { wall: Date.now(), mono: monotonicNow() };
}

export function freshnessAge(seen: FreshnessStamp, now: FreshnessStamp): number {
  return Math.max(now.wall - seen.wall, now.mono - seen.mono);
}

/** How many rows, from the start, are all younger than the bound. */
export function freshCount<T>(kept: readonly Kept<T>[], now: FreshnessStamp, staleAfterMs: number): number {
  let count = 0;
  while (count < kept.length && freshnessAge(kept[count]!.seen, now) < staleAfterMs) count += 1;
  return count;
}

/**
 * One page read again replaces the kept rows in the range it covers: strictly
 * after `after` (the start when null) through `last` (the end when null), in
 * the list's order, where `before(a, b)` means a comes first. The last page of
 * a re-read also drops what lies past it.
 */
export function replaceKeptRange<T extends K, K>(kept: readonly Kept<T>[], range: {
  after: K | null;
  last: K | null;
  rows: readonly T[];
  seen: FreshnessStamp;
  final: boolean;
  before: (row: K, other: K) => boolean;
}): Kept<T>[] {
  const { after, last, rows, seen, final, before } = range;
  const head = after ? kept.filter((entry) => !before(after, entry.row)) : [];
  const tail = last && !final ? kept.filter((entry) => before(last, entry.row)) : [];
  return [...head, ...rows.map((row) => ({ row, seen })), ...tail];
}

/**
 * Calls `cut` the moment the oldest kept row reaches the bound, and again when
 * the app returns to the foreground: timers do not run while it is suspended,
 * so a row that aged out meanwhile is cut in the same pass that lifts the
 * privacy cover, before the screen shows again. Nothing is subscribed while
 * no row is kept.
 */
export function useFreshnessCut(lists: readonly (readonly Kept<unknown>[])[], staleAfterMs: number, cut: () => void): void {
  const cutRef = useRef(cut);
  cutRef.current = cut;
  const [, setWoken] = useState(0);
  let soonest = Infinity;
  const now = freshnessNow();
  for (const kept of lists) {
    for (const entry of kept) soonest = Math.min(soonest, staleAfterMs - freshnessAge(entry.seen, now));
  }
  const holding = soonest !== Infinity;
  // Rescheduled on each render from the clocks read above, so the timer
  // always waits the time left. It also renders again, so a timer that fires
  // a little early (the two clocks drift) measures again and reschedules
  // instead of leaving the row for the next unrelated render.
  useEffect(() => {
    if (!holding) return undefined;
    const timer = setTimeout(() => {
      cutRef.current();
      setWoken((value) => value + 1);
    }, Math.max(0, soonest));
    return () => clearTimeout(timer);
  }, [holding, soonest]);
  useEffect(() => {
    if (!holding) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') cutRef.current();
    });
    return () => subscription.remove();
  }, [holding]);
}
