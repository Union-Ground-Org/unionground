import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_CARD_ACCESSIBILITY_HINT,
  appointmentCardAccessibilityLabel,
  appointmentCardDetailLine,
  humanizeAppointmentValue,
} from './appointmentCardAccessibility';

const when = 'Sep 28, 2026, 10:00 AM';

describe('one-on-one card accessible name', () => {
  it('speaks type, lifecycle status and the painted start time for a worker card', () => {
    expect(appointmentCardAccessibilityLabel(
      { appointmentType: 'office_hours', status: 'confirmed', startsAt: '2026-09-28T14:00:00Z', reasonCategory: 'dues_question' },
      false,
      when,
    )).toBe(`office hours, confirmed, ${when}, dues question`);
  });

  it('keeps every lifecycle state distinct as text, never by pill colour alone', () => {
    const labels = (['confirmed', 'cancelled', 'completed', 'no_show'] as string[]).map((status) =>
      appointmentCardAccessibilityLabel({ appointmentType: 'office_hours', status, startsAt: '2026-09-28T14:00:00Z' }, false, when));
    expect(labels).toEqual([
      `office hours, confirmed, ${when}, One-on-one`,
      `office hours, cancelled, ${when}, One-on-one`,
      `office hours, completed, ${when}, One-on-one`,
      `office hours, no show, ${when}, One-on-one`,
    ]);
    expect(new Set(labels).size).toBe(4);
  });

  it('names the worker and committee member for a supervising staff card and falls back to role nouns', () => {
    expect(appointmentCardAccessibilityLabel(
      { appointmentType: 'office_hours', status: 'confirmed', startsAt: '2026-09-28T14:00:00Z', memberName: 'Ana Ruiz', stewardName: 'Sam Lee' },
      true,
      when,
    )).toBe(`office hours, confirmed, ${when}, Ana Ruiz · Sam Lee`);
    expect(appointmentCardDetailLine({ appointmentType: 'office_hours', status: 'confirmed', startsAt: '' }, true)).toBe('Worker · Committee member');
  });

  it('never leaks a private reason into a supervising card and never names people on a worker card', () => {
    const shared = { appointmentType: 'office_hours', status: 'confirmed', startsAt: '2026-09-28T14:00:00Z', memberName: 'Ana Ruiz', stewardName: 'Sam Lee', reasonCategory: 'discipline' };
    expect(appointmentCardAccessibilityLabel(shared, true, when)).not.toContain('discipline');
    expect(appointmentCardAccessibilityLabel(shared, false, when)).not.toContain('Ana Ruiz');
  });

  it('keeps the verb in the hint so the facts are spoken before the action', () => {
    expect(APPOINTMENT_CARD_ACCESSIBILITY_HINT).toBe('Opens the one-on-one history');
    expect(humanizeAppointmentValue('no_show')).toBe('no show');
  });
});
