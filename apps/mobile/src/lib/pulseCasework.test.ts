import { describe, expect, it } from 'vitest';
import { CASEWORK_CHARTS, CASEWORK_COPY, CASEWORK_WITHHELD, caseworkCard, caseworkTitle, isCaseworkKey, weekMark } from './pulseCasework';

const starts = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'];
const weeks = (fill: (index: number) => Record<string, unknown>) => starts.map((weekStart, index) => ({ weekStart, ...fill(index) }));

describe('Issue work chart answers', () => {
  it('names the four Issue work charts by their server keys and reads', () => {
    expect(CASEWORK_CHARTS.map((chart) => [chart.key, chart.read])).toEqual([
      ['ready:open-overdue', 'get_pulse_open_overdue'], ['ready:resolution-rate', 'get_pulse_resolution_rate'],
      ['ready:days-to-resolve', 'get_pulse_days_to_resolve'], ['ready:casework', 'get_pulse_casework'],
    ]);
    expect(isCaseworkKey('ready:notice-reach')).toBe(false);
    expect(weekMark('2026-11-09')).toEqual({ axis: '11/9', name: 'week of Nov 9', spoken: 'Week of November 9' });
    expect(weekMark('11/9/2026')).toBeNull();
  });

  it('keeps withheld, unavailable, zero and not-loaded apart for open and overdue', () => {
    const shown = caseworkCard('ready:open-overdue', { state: 'ready', open: 26, overdue: 25, resolvedThisMonth: 3, inReview: { state: 'unavailable' } });
    expect(shown.rows).toEqual([{ label: 'Open', value: 26 }, { label: 'Overdue', value: 25 }, { label: 'Resolved this month', value: 3 }]);
    expect(shown.message).toBeUndefined();
    expect(shown.notCounted).toContain('“In review” is not shown');
    const withheld = caseworkCard('ready:open-overdue', { state: 'withheld', open: null, overdue: null });
    expect(withheld).toMatchObject({ rows: [], message: CASEWORK_WITHHELD });
    expect(withheld.unavailable).toBeUndefined();
    const zero = caseworkCard('ready:open-overdue', { state: 'no_eligible_records', open: 0, overdue: 0, resolvedThisMonth: 0 });
    expect(zero.rows.map((row) => row.value)).toEqual([0, 0, 0]);
    expect(zero.message).toBe('No open issues and none resolved this month.');
    expect(caseworkCard('ready:open-overdue', { state: 'unavailable', reason: 'no_grievance_procedure' })).toMatchObject({ unavailable: true, rows: [], message: expect.stringContaining('No issue process') });
    expect(caseworkCard('ready:open-overdue', { state: 'unavailable' })).toMatchObject({ unavailable: true, message: 'These figures are not available for your current role.' });
    expect(caseworkCard('ready:open-overdue', null)).toMatchObject({ unavailable: true, message: 'These figures didn’t load. Refresh to try again.' });
    // A malformed answer is not a figure: overdue above open, or a missing count.
    expect(caseworkCard('ready:open-overdue', { state: 'ready', open: 1, overdue: 2, resolvedThisMonth: 0 }).unavailable).toBe(true);
    expect(caseworkCard('ready:open-overdue', { state: 'ready', open: 1, overdue: 0 }).unavailable).toBe(true);
    // Old cases are named by a standing line on every card, never by a per-read flag (Grok pre-final).
    for (const chart of CASEWORK_CHARTS) expect(caseworkCard(chart.key, { state: 'withheld', historyComplete: false }).notCounted).toContain('before issue history was kept');
    expect(caseworkCard('ready:open-overdue', { state: 'ready', open: 26, overdue: 25, resolvedThisMonth: 0, historyComplete: false }).message).toBeUndefined();
  });

  it('draws only released weeks of the resolution rate, never a withheld or empty week as zero', () => {
    const card = caseworkCard('ready:resolution-rate', { state: 'ready', days: 60, weeks: weeks((index) => index === 7 ? { state: 'ready', cohort: 51, resolved: 25, percentage: 49 } : index === 6 ? { state: 'withheld', percentage: null } : { state: 'no_eligible_records', percentage: null }) });
    expect(card.rows).toEqual([{ label: 'Week of November 16', value: 49 }]);
    expect(card.trend?.marks).toEqual([{ axis: '11/16', name: 'week of Nov 16', spoken: 'Week of November 16' }]);
    expect(card.message).toBe('One week is withheld: a group of people behind it is too small to share safely. 6 weeks have no eligible records.');
    const all = caseworkCard('ready:resolution-rate', { state: 'ready', weeks: weeks(() => ({ state: 'withheld' })) });
    expect(all).toMatchObject({ rows: [], message: CASEWORK_WITHHELD });
    expect(all.trend).toBeUndefined();
    expect(caseworkCard('ready:resolution-rate', { state: 'ready', weeks: weeks(() => ({ state: 'no_eligible_records' })) }).message).toBe('No issue reached its sixtieth day in these weeks.');
    expect(caseworkCard('ready:resolution-rate', { state: 'ready', weeks: weeks(() => ({ state: 'ready', percentage: 140 })) }).unavailable).toBe(true);
    expect(caseworkCard('ready:resolution-rate', { state: 'ready', weeks: weeks(() => ({ state: 'ready', percentage: 1 })).slice(1) }).unavailable).toBe(true);
  });

  it('shows the days-to-resolve comparison only when the server released it', () => {
    const answer = { state: 'ready', weeks: weeks((index) => ({ state: 'ready', resolved: 25, meanDays: index < 4 ? 20 : 10.4 })) };
    const card = caseworkCard('ready:days-to-resolve', { ...answer, comparison: { earlierMeanDays: 20, laterMeanDays: 10.4 } });
    expect(card.rows.map((row) => row.value)).toEqual([20, 20, 20, 20, 10.4, 10.4, 10.4, 10.4]);
    expect(card.subtitle).toBe('Average 10.4 days in the later four weeks, 20 in the earlier four');
    expect(caseworkCard('ready:days-to-resolve', { ...answer, comparison: null }).subtitle).toBeUndefined();
  });

  it('totals Issue work only when every week is released, and checks the cohort status against it', () => {
    const ready = weeks((index) => ({ state: 'ready', opened: index === 7 ? 25 : 0, resolved: index === 7 ? 2 : 0 }));
    const card = caseworkCard('ready:casework', { state: 'ready', weeks: ready, status: { state: 'ready', open: 23, resolved: 2 }, tags: { state: 'unavailable' } });
    expect(card.rows).toEqual([{ label: 'Opened', value: 25 }, { label: 'Resolved', value: 2 }, { label: 'Opened then, still open', value: 23 }, { label: 'Opened then, now resolved', value: 2 }]);
    expect(card.notCounted).toContain('Tags are not shown');
    const gap = caseworkCard('ready:casework', { state: 'ready', weeks: ready.map((week, index) => index === 3 ? { weekStart: week.weekStart, state: 'withheld' } : week), status: { state: 'withheld' } });
    expect(gap.rows).toEqual([]);
    expect(gap.message).toContain('no eight-week total is shown');
    const statusHidden = caseworkCard('ready:casework', { state: 'ready', weeks: ready, status: { state: 'withheld', open: null } });
    expect(statusHidden.rows).toHaveLength(2);
    expect(statusHidden.message).toContain('status of the issues opened in these weeks is withheld');
    expect(caseworkCard('ready:casework', { state: 'ready', weeks: ready, status: { state: 'ready', open: 20, resolved: 2 } }).unavailable).toBe(true);
  });

  it('speaks Spanish in a Spanish workspace: titles, states, rows, comparison and week names', () => {
    expect(CASEWORK_CHARTS.map((chart) => caseworkTitle(chart.key, 'es'))).toEqual(['Asuntos abiertos y vencidos', 'Tasa de resolución', 'Días para resolver un asunto', 'Gestión de asuntos']);
    expect(weekMark('2026-11-09', 'es')).toEqual({ axis: '9/11', name: 'semana del 9 de nov', spoken: 'Semana del 9 de noviembre' });
    const withheld = caseworkCard('ready:open-overdue', { state: 'withheld' }, 'es');
    expect(withheld).toMatchObject({ title: 'Asuntos abiertos y vencidos', message: CASEWORK_COPY.es.withheld, privacy: CASEWORK_COPY.es.privacy, period: 'Campaña · hoy' });
    expect(caseworkCard('ready:casework', { state: 'unavailable', reason: 'no_grievance_procedure' }, 'es').message).toBe(CASEWORK_COPY.es.noProcedure);
    expect(caseworkCard('ready:casework', null, 'es').message).toBe('Estas cifras no se cargaron. Actualiza para intentarlo de nuevo.');
    expect(caseworkCard('ready:open-overdue', { state: 'ready', open: 26, overdue: 25, resolvedThisMonth: 3 }, 'es').rows.map((row) => row.label)).toEqual(['Abiertas', 'Vencidas', 'Resueltas este mes']);
    const days = caseworkCard('ready:days-to-resolve', { state: 'ready', comparison: { earlierMeanDays: 20, laterMeanDays: 10.4 }, weeks: weeks((index) => index === 7 ? { state: 'ready', resolved: 25, meanDays: 10.4 } : { state: 'withheld' }) }, 'es');
    expect(days.subtitle).toBe('Promedio de 10.4 días en las cuatro semanas más recientes, 20 en las cuatro anteriores');
    expect(days.rows).toEqual([{ label: 'Semana del 16 de noviembre', value: 10.4 }]);
    expect(days.trend).toMatchObject({ series: 'días en promedio', latest: 'semana más reciente mostrada' });
    expect(days.message).toBe('7 semanas están ocultas: un grupo de personas detrás es demasiado pequeño para compartirlo con seguridad.');
    // Every English line has a Spanish line, and none is left in English.
    const flat = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? (value as unknown[]).flatMap(flat) : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(flat) : [];
    const english = flat(CASEWORK_COPY.en), spanish = flat(CASEWORK_COPY.es);
    expect(spanish).toHaveLength(english.length);
    for (const [index, line] of english.entries()) if (line.length > 3) expect(spanish[index], line).not.toBe(line);
  });
});
