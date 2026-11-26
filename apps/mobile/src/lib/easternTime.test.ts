import { describe, expect, it, vi } from 'vitest';

import { EASTERN_INSTANTS, atEasternInstant, inDeviceZone } from '../../../../tests/helpers/easternClock.js';
import { easternDay, easternZoneLabel, formatEasternInstant, nextEasternMidnight } from './easternTime';
import { easternDateTime } from './evidenceTimestamp';

const { evening, daylightEvening, fallBack } = EASTERN_INSTANTS;

describe('native Eastern time is the shared module', () => {
  it('counts the Eastern day on a phone in another zone in the evening', async () => {
    const day = await inDeviceZone('Asia/Tokyo', () => atEasternInstant(vi, evening.at, () => easternDay(new Date())));
    expect(day).toBe(evening.easternDay);
  });

  it('labels instants and crosses the fall-back day by date', () => {
    expect(formatEasternInstant(daylightEvening.at)).toBe('Jul 14, 2026, 8:30 PM EDT');
    expect(easternZoneLabel(fallBack.after)).toBe('EST');
    expect(nextEasternMidnight(fallBack.before).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('keeps the evidence stamp on the same Eastern day', () => {
    expect(easternDateTime(evening.at)).toBe('Nov 12, 2026 · 7:30 PM ET');
  });
});
