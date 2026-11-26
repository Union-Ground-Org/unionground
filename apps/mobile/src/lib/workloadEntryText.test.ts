import { describe, expect, it } from 'vitest';

import { workloadChoiceText } from './workloadEntryText';

// Ledger 485: an admin-written choice shows with its underscores read as
// spaces only when no other choice of the same field then reads the same, so
// `day_shift` and `day shift` stay two different buttons (the web keeps them
// apart, src/lib/workloadConfiguration.js).
describe('workload choice text', () => {
  const field = { key: 'shift', options: ['day_shift', 'day shift', 'night_shift'] };

  it('keeps two choices apart when replacing underscores would make them read the same', () => {
    expect(workloadChoiceText(field, 'day_shift')).toBe('day_shift');
    expect(workloadChoiceText(field, 'day shift')).toBe('day shift');
    expect(new Set(field.options.map((option) => workloadChoiceText(field, option))).size).toBe(field.options.length);
  });

  it('still reads underscores as spaces in a choice no other choice collides with', () => {
    expect(workloadChoiceText(field, 'night_shift')).toBe('night shift');
    expect(workloadChoiceText({ key: 'shift' }, 'night_shift')).toBe('night shift');
  });

  it('translates an original field\'s default choice', () => {
    const employment = { key: 'employment', options: ['full_time', 'part_time'] };
    expect(workloadChoiceText(employment, 'full_time')).toBe('Full-time');
    expect(workloadChoiceText(employment, 'part_time', 'es')).toBe('Tiempo parcial');
  });
});
