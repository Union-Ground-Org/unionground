import { describe, expect, it } from 'vitest';
import { chartFigures, chartReference, chartShareable, chartSpec, NEW_CHART, savedChart } from './savedPulseCharts';
const ID = '11111111-1111-4111-8111-111111111111';
const spec = { ...NEW_CHART, measure: 'published_actions' as const };
const data = { rows: [{ label: '2026-11', value: 27 }], privacyFloor: 25, withheld: false, countedFrom: 'Recorded sign-ups.' };
describe('portable chart figures', () => {
  it('fails closed on malformed data, missing privacy receipts, small cells and locked reads', () => {
    expect(chartFigures(data, spec).rows).toHaveLength(1);
    for (const value of [null, {}, { ...data, privacyFloor: 5 }, { ...data, rows: [{ label: 'month', value: -1 }] }, { ...data, rows: [{ value: 27 }] }, { ...data, rows: Array.from({ length: 401 }, () => ({ label: 'x', value: 27 })) }]) expect(chartFigures(value, spec).rows).toEqual([]);
    expect(chartFigures({ ...data, rows: [{ label: 'month', value: 2 }] }, spec)).toMatchObject({ rows: [], withheld: true });
    expect(chartFigures({ ...data, locked: true }, spec)).toMatchObject({ rows: [], locked: true });
    expect(chartFigures({ ...data, withheld: true }, spec)).toMatchObject({ rows: [], withheld: true, unavailable: false });
    expect(chartFigures({ ...data, rows: [{ label: 'month', value: 1 }] }, NEW_CHART).rows).toHaveLength(1);
  });
  it('validates specs and does not let saved metadata make person charts shareable', () => {
    expect(chartSpec({ ...spec, unitID: ID, caseType: 'Safety', level: 'local' })).toMatchObject({ unitID: ID, caseType: 'Safety', level: 'local' });
    for (const change of [{ version: 2 }, { measure: 'unknown' }, { form: 'unknown' }, { period: '2026-01-01' }, { breakdown: 'person' }, { level: 'unknown' }]) expect(() => chartSpec({ ...spec, ...change })).toThrow();
    expect(() => savedChart({ id: 'bad', title: 'x', spec, scope: 'personal' })).toThrow();
    const chart = savedChart({ id: ID, title: 'Recorded', spec, scope: 'chapter', pinned: false, home: true, owned: true, figures: data });
    expect(chart.home).toBe(false); expect(chartShareable(chart)).toBe(true);
    expect(chartShareable({ ...chart, spec: NEW_CHART })).toBe(false);
    expect(chartShareable({ ...chart, scope: 'personal' })).toBe(false);
    expect(chartShareable({ ...chart, owned: false })).toBe(false);
    expect(chartShareable({ ...chart, figures: { ...chart.figures, locked: true } })).toBe(false);
  });
  it('accepts only the exact opaque marker, never embedded text, URLs or expressions', () => {
    expect(chartReference(`[pulse-chart:${ID}]`)).toBe(ID);
    for (const value of [`before [pulse-chart:${ID}]`, `[pulse-chart:${ID}] after`, `[pulse-chart:${ID}\n]`, 'https://example.invalid/chart', '[pulse-chart:person]']) expect(chartReference(value)).toBeNull();
  });
});
