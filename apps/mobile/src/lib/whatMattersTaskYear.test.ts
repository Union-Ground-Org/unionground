import { afterEach, expect, it, vi } from 'vitest';
import { whatMattersCopy } from './whatMattersCopy';
import { type WhatMattersItem } from './whatMattersShared';

afterEach(() => vi.useRealTimers());

it.each([
  ['2024-11-09', 'en', 'Due Nov 9, 2024'],
  ['2024-11-09', 'es', 'Vence el 9 nov 2024'],
  ['2027-01-01', 'en', 'Due Jan 1, 2027'],
  ['2027-01-01', 'es', 'Vence el 1 ene 2027'],
  ['2026-11-21', 'en', 'Due Nov 21'],
  ['2026-11-21', 'es', 'Vence el 21 nov'],
] as const)('names the year of a task due outside this year: %s (%s)', (deadline, language, expected) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T17:00:00Z'));
  const item: WhatMattersItem = {
    kind: 'assigned_task', urgency: 'warning', task: { id: 't1', title: 'Order the flyers' }, days: -2, deadline,
    action: { kind: 'open_task', taskId: 't1' },
  };
  expect(whatMattersCopy(item, language).meta).toBe(expected);
});
