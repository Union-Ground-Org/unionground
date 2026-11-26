import { describe, expect, it } from 'vitest';

import { createIntentStamp } from './intentStamp';

describe('a retried write keeps its first time', () => {
  it('reuses the time for the same intent until it is answered, changed or ten minutes old', () => {
    let clock = Date.parse('2026-11-13T15:00:00.000Z');
    const stamp = createIntentStamp(() => clock);
    const first = stamp.stamp('contact:email:Question');
    clock += 60_000;
    expect(stamp.stamp('contact:email:Question')).toBe(first);
    expect(stamp.stamp('contact:phone:Question')).toBe('2026-11-13T15:01:00.000Z');
    clock += 60_000;
    stamp.settle();
    expect(stamp.stamp('contact:phone:Question')).toBe('2026-11-13T15:02:00.000Z');
    clock += 10 * 60_000;
    expect(stamp.stamp('contact:phone:Question')).toBe('2026-11-13T15:12:00.000Z');
  });

  it('reads the device clock by default', () => {
    const before = Date.now();
    expect(Date.parse(createIntentStamp().stamp('x'))).toBeGreaterThanOrEqual(before);
  });
});
