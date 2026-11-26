import { describe, expect, it } from 'vitest';
import { nextStewardDeadline, normalizePulsePeople, pulseBarAxisLabels, pulseCount, pulseDate, pulseDeadlineLabel, pulseObject, pulseRows, pulseText, pulseTier, pulseUpdated, type PulseRow } from './pulseCatalog';
import { pulsePalette } from '../theme/pulsePalette';
import { contrast } from '../theme/chartPalette';
import { resolveTheme } from '../theme/tokens';

describe('shared Pulse catalogue values', () => {
  it('rejects malformed values without invented counts', () => {
    for (const value of [null, '', -1, NaN, Infinity, 'bad', {}, 1.5]) expect(pulseCount(value)).toBeNull();
    expect(pulseCount('0')).toBe(0); expect(pulseCount(4)).toBe(4);
    expect(pulseObject(null)).toEqual({}); expect(pulseObject([])).toEqual({});
    expect(pulseRows(null)).toEqual([]); expect(pulseRows([null, { id: 'a' }])).toEqual([{}, { id: 'a' }]);
    expect(pulseText(null)).toBe(''); expect(pulseText('record')).toBe('record');
    expect(pulseDate('bad')).toBeNull(); expect(pulseDate('2026-11-01')).toBe('2026-11-01');
  });
  it('keeps the shared People shape private even on malformed or aggregate payloads', () => {
    const payload = { level: 'steward', floor: 10, members: [{ id: 'a', name: 'Fictional A', score: 88, scoreHidden: true, lastActivity: '2026-11-01' }, { id: 'b', name: 'Fictional B', score: 63, scoreHidden: false, lastActivity: '2026-11-01' }], groups: [] };
    expect(normalizePulsePeople(payload, 'steward').members).toMatchObject([{ score: null, lastActivity: null }, { score: 63 }]);
    expect(() => normalizePulsePeople(null, 'steward')).toThrow();
    expect(() => normalizePulsePeople(payload, 'chapter')).toThrow();
    const chapter = normalizePulsePeople({ ...payload, level: 'chapter', groups: [{ id: 'x', name: 'Fictional campaign', count: 9, score: 80, withheld: false }] }, 'chapter');
    expect(chapter.members).toEqual([]); expect(chapter.groups[0]).toMatchObject({ count: null, score: null, withheld: true });
    expect(normalizePulsePeople({ ...payload, members: [{ id: 'a', name: 'Fictional A', score: 101, scoreHidden: false, lastActivity: 'bad' }] }, 'steward').members[0]).toMatchObject({ score: null, lastActivity: null });
    expect(normalizePulsePeople({ ...payload, level: 'local', floor: null, groups: [{ id: 'x', name: 'Fictional campaign', count: 12, score: 75, withheld: false }] }, 'local').groups[0]).toMatchObject({ count: 12, score: 75, withheld: false });
  });
  it('labels health boundaries and time zones consistently', () => {
    for (const value of [null, NaN, -1, 101]) expect(pulseTier(value).index).toBe(-1);
    for (const [score, index] of [[0, 0], [24, 0], [25, 1], [44, 1], [45, 2], [64, 2], [65, 3], [84, 3], [85, 4], [100, 4]] as const) expect(pulseTier(score).index).toBe(index);
    expect(pulseDeadlineLabel('2027-01-06T02:00:00+00:00')).toBe('Jan 5, 2027 · 9:00 PM ET');
    expect(pulseDeadlineLabel('2027-01-06')).toBe('Jan 6, 2027'); expect(pulseDeadlineLabel('bad')).toContain('unavailable');
    expect(pulseUpdated(new Date('2026-11-01T18:40:00-05:00'))).toBe('Updated 6:40 PM ET');
    expect(pulseUpdated(new Date('bad'))).toContain('unavailable');
  });
  it('ranks the earliest unresolved deadline without depending on the phone zone', () => {
    const cases = [{ id: 'b', reference: 'B', title: 'Fictional B', deadline: '2026-11-04', status: 'active' }, { id: 'a', reference: 'A', title: 'Fictional A', deadline: '2026-11-02', status: 'active' }];
    const now = Date.parse('2026-11-01T12:00:00-05:00');
    expect(nextStewardDeadline(cases, [], now)?.item.id).toBe('a');
    expect(nextStewardDeadline(cases, [{ caseID: 'b', label: 'Response', dueAt: '2026-10-31T12:00:00-04:00' }], now)?.item.id).toBe('b');
    expect(nextStewardDeadline([{ ...cases[0]!, status: 'resolved' }], [], now)).toBeNull();
    for (const deadline of [null, 'bad', '2027-02-01']) expect(nextStewardDeadline([{ ...cases[0]!, deadline }], [], now)).toBeNull();
    expect(nextStewardDeadline([{ ...cases[0]!, deadline: '2026-07-04' }], [], Date.parse('2026-07-01T12:00:00-04:00'))?.item.id).toBe('b');
  });
  it('names every Staff access bar whole, and refuses names that cannot fit (#9341)', () => {
    const staffAccess: PulseRow[] = [
      { label: 'Staff accounts', value: 66 },
      { label: 'Two-step enrolled', value: 33 },
      { label: 'Two-step enrollment needed', value: 33 },
    ];
    const labels = pulseBarAxisLabels(staffAccess);
    expect(labels).not.toBeNull();
    expect(labels).toHaveLength(staffAccess.length);
    labels!.forEach((lines, index) => {
      // The wrapped lines rebuild the category name: no word is split or lost.
      expect(lines.join(' ')).toBe(staffAccess[index]!.label);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(17);
    });
    // The Spanish Staff access names fit the same slots whole (R-K10), so
    // choosing Spanish does not silently drop every axis name.
    const spanish = pulseBarAxisLabels([
      { label: 'Cuentas del personal', value: 66 },
      { label: 'Con verificación en dos pasos', value: 33 },
      { label: 'Sin verificación en dos pasos', value: 33 },
    ]);
    expect(spanish!.map((lines) => lines.join(' '))).toEqual(['Cuentas del personal', 'Con verificación en dos pasos', 'Sin verificación en dos pasos']);
    expect(pulseBarAxisLabels([
      { label: 'Campaign workers', value: 120 },
      { label: 'Joined this year', value: 30 },
    ])!.map((lines) => lines.join(' '))).toEqual(['Campaign workers', 'Joined this year']);
    expect(pulseBarAxisLabels([{ label: 'Recorded meetings', value: 4 }])!.map((lines) => lines.join(' ')))
      .toEqual(['Recorded meetings']);
    const dense = Array.from({ length: 8 }, (_, index) => ({ label: `Category number ${index} with a long name`, value: index + 1 }));
    expect(pulseBarAxisLabels(dense)).toBeNull();
    expect(pulseBarAxisLabels([
      { label: 'Antidisestablishmentarianism', value: 1 },
      { label: 'Short', value: 2 },
      { label: 'Also short', value: 3 },
    ])).toBeNull();
    expect(pulseBarAxisLabels([])).toBeNull();
  });
  it.each(['union-ground', 'union-ground-dark'] as const)('holds the worker surfaces, choices and chart marks to contrast floors in %s', (key) => {
    const theme = resolveTheme('union-ground', key === 'union-ground-dark'), colors = pulsePalette(theme);
    for (const surface of [theme.card, theme.background, theme.secondary]) {
      expect(contrast(theme.foreground, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.mutedForeground, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of [theme.card, theme.background]) for (const mark of colors.series) expect(contrast(mark, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.primary, theme.primaryForeground)).toBeGreaterThanOrEqual(4.5);
  });
});
