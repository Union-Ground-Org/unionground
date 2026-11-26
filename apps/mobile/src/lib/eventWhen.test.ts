import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LivedInEvent } from '../services/livedIn';
import { eventCheckInClosed, eventWhenLabel, splitEventsByTime } from './eventWhen';

const base: LivedInEvent = {
  id: 'e1', chapterID: null, title: 'Campaign meeting', summary: '', startsAt: '2026-11-10T23:00:00Z', endsAt: '2026-11-11T00:30:00Z',
  eventKind: 'meeting', eventDate: null, seriesId: null, location: 'Hall', cancelled: false, cancellationReason: null,
  rsvp: null, checkedInAt: null, checkInOffered: true,
};
const NOW = Date.parse('2026-11-04T04:00:00Z');

afterEach(() => { vi.unstubAllEnvs(); });

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103, audit
// MOB-STEWARD-09, MOB-COORDINATOR-07/-08, MOB-VP-08.
describe('meeting times', () => {
  it('gives a meeting a year and names the zone its time is shown in', () => {
    const label = eventWhenLabel(base);
    expect(label).toMatch(/2026/);
    expect(label).toMatch(/\b[A-Z]{2,5}\b|GMT[+-]?\d*/);
    expect(label).not.toMatch(/[\u202F\u00A0]/);
  });

  // BUG-UG-NATIVE-EVENT-TIME-ZONE-NAMED-TWICE-20261118 (#9138): the
  // shared clock label already ends each clock with its zone (#7820), so the
  // phone label names the zone once per clock, never "4:00 PM EST EST".
  const languages: Array<'en' | 'es'> = ['en', 'es'];
  it.each(languages)('names the zone once per clock (%s)', (lang) => {
    const zones = (label: string) => label.match(/\b(?:EST|EDT)\b/g) ?? [];
    const single = eventWhenLabel({ ...base, endsAt: null }, lang);
    expect(single).toMatch(/6:00\s?p\.?\s?m\.? EST$/i);
    expect(zones(single)).toHaveLength(1);
    const sameDay = eventWhenLabel(base, lang);
    expect(sameDay).toMatch(/6:00\s?p\.?\s?m\.? EST – 7:30\s?p\.?\s?m\.? EST$/i);
    expect(zones(sameDay)).toHaveLength(2);
    const nextDay = eventWhenLabel({ ...base, endsAt: '2026-11-11T06:00:00Z' }, lang);
    expect(nextDay).toMatch(/6:00\s?p\.?\s?m\.? EST – .*\b11\b.*, 1:00\s?a\.?\s?m\.? EST$/i);
    expect(zones(nextDay)).toHaveLength(2);
    for (const label of [single, sameDay, nextDay]) expect(label).not.toMatch(/\b(EST|EDT) (EST|EDT)\b/);
  });

  // BUG-UG-NATIVE-EVENT-DATE-IN-PHONE-ZONE-CLOCK-IN-EASTERN-20261119
  // (#9209): the clock is Eastern, so the date is the Eastern date too, on a
  // phone set to any zone; a date-only event keeps its own calendar date.
  const thursday: Record<'en' | 'es', string> = { en: 'Thu, Nov 19, 2026', es: 'jue, 19 de nov de 2026' };
  const phoneZones = ['America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York'];
  const zoneCases = phoneZones.flatMap((zone) => languages.map((lang) => [zone, lang] as [string, 'en' | 'es']));
  it.each(zoneCases)('dates a meeting by its Eastern day on a phone set to %s (%s)', (zone, lang) => {
    vi.stubEnv('TZ', zone);
    const prefix = (label: string) => label.split(' · ')[0];
    // 12:00 AM EST and 11:30 PM EST on Thu Nov 19: the two ends of the Eastern day.
    const midnight = eventWhenLabel({ ...base, startsAt: '2026-11-19T05:00:00Z', endsAt: null }, lang);
    expect(prefix(midnight)).toBe(thursday[lang]);
    expect(midnight).toMatch(/12:00\s?a\.?\s?m\.? EST$/i);
    const lateNight = eventWhenLabel({ ...base, startsAt: '2026-11-20T04:30:00Z', endsAt: null }, lang);
    expect(prefix(lateNight)).toBe(thursday[lang]);
    expect(lateNight).toMatch(/11:30\s?p\.?\s?m\.? EST$/i);
    const dateOnly = eventWhenLabel({ ...base, startsAt: '', eventKind: 'deadline', eventDate: '2026-11-19', checkInOffered: false }, lang);
    expect(prefix(dateOnly)).toBe(thursday[lang]);
  });

  it('gives a date-only item its year and its kind, with no clock time', () => {
    const label = eventWhenLabel({ ...base, startsAt: '', eventKind: 'deadline', eventDate: '2027-02-01', checkInOffered: false });
    expect(label).toContain('2027');
    expect(label).not.toMatch(/\d:\d\d/);
  });

  it('lists upcoming meetings in schedule order, then past meetings newest first', () => {
    const events = [
      { ...base, id: 'old', startsAt: '2026-10-01T23:00:00Z', endsAt: null },
      { ...base, id: 'recent', startsAt: '2026-10-20T23:00:00Z', endsAt: null },
      { ...base, id: 'next', startsAt: '2026-11-05T23:00:00Z', endsAt: null },
      { ...base, id: 'later', startsAt: '2026-11-20T23:00:00Z', endsAt: null },
    ];
    const split = splitEventsByTime(events, NOW);
    expect(split.upcoming.map((event) => event.id)).toEqual(['next', 'later']);
    expect(split.past.map((event) => event.id)).toEqual(['recent', 'old']);
    // The same order whatever order the rows arrive in.
    const reversed = splitEventsByTime([...events].reverse(), NOW);
    expect(reversed.upcoming.map((event) => event.id)).toEqual(['next', 'later']);
    expect(reversed.past.map((event) => event.id)).toEqual(['recent', 'old']);
  });

  it('says check-in is closed only after the check-in window of an offered meeting', () => {
    const start = Date.parse(base.startsAt);
    expect(eventCheckInClosed(base, start + 3 * 3_600_000)).toBe(false);
    expect(eventCheckInClosed(base, start + 5 * 3_600_000)).toBe(true);
    expect(eventCheckInClosed({ ...base, checkedInAt: '2026-11-10T23:05:00Z' }, start + 5 * 3_600_000)).toBe(false);
    expect(eventCheckInClosed({ ...base, checkInOffered: false }, start + 5 * 3_600_000)).toBe(false);
  });
});
