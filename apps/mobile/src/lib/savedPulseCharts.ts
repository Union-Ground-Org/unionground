import { pulseCount, pulseObject, pulseRows, pulseText, type PulseRow } from './pulseCatalog';

// One bounded native PNG, also removed by startup/session-loss/sign-out cleanup.
export const PULSE_CHART_EXPORT_CACHE_KEY = 'ug-pulse-chart-export-v1';
export const CHART_MEASURES = ['my_actions', 'published_actions', 'meeting_turnout', 'visible_cases'] as const;
export const CHART_FORMS = ['bars', 'line', 'stack', 'meter', 'table'] as const;
export type ChartMeasure = typeof CHART_MEASURES[number];
export type ChartForm = typeof CHART_FORMS[number];
export type ChartSpec = { version: 1; measure: ChartMeasure; breakdown: 'month' | 'meeting' | 'unit'; period: '3m' | '6m' | '12m'; form: ChartForm; level?: 'chapter' | 'local'; unitID?: string; caseType?: string };
export type SavedChart = { id: string; title: string; scope: 'personal' | 'chapter' | 'organization'; spec: ChartSpec; pinned: boolean; home: boolean; owned: boolean; figures: ChartFigures };
export type ChartFigures = { rows: PulseRow[]; countedFrom: string; floor: number; person: boolean; withheld: boolean; locked: boolean; unavailable: boolean };
export const MEASURE_LABELS: Record<ChartMeasure, string> = { my_actions: 'Your action sign-ups', published_actions: 'Campaign action sign-ups', meeting_turnout: 'Meeting check-ins', visible_cases: 'Issues your role may read' };
export const NEW_CHART: ChartSpec = { version: 1, measure: 'my_actions', breakdown: 'month', period: '12m', form: 'bars' };
export function chartSpec(value: unknown): ChartSpec {
  const row = pulseObject(value);
  if (row.version !== 1 || !CHART_MEASURES.includes(row.measure as ChartMeasure) || !CHART_FORMS.includes(row.form as ChartForm)
    || !['month', 'meeting', 'unit'].includes(pulseText(row.breakdown)) || !['3m', '6m', '12m'].includes(pulseText(row.period))
    || (row.level !== undefined && row.level !== 'chapter' && row.level !== 'local')) throw new Error('Chart specification unavailable.');
  return { version: 1, measure: row.measure as ChartMeasure, form: row.form as ChartForm,
    breakdown: row.breakdown as ChartSpec['breakdown'], period: row.period as ChartSpec['period'],
    ...(row.level === 'chapter' || row.level === 'local' ? { level: row.level } : {}),
    ...(pulseText(row.unitID) ? { unitID: pulseText(row.unitID) } : {}), ...(pulseText(row.caseType) ? { caseType: pulseText(row.caseType) } : {}) };
}
export function chartFigures(value: unknown, spec: ChartSpec): ChartFigures {
  const row = pulseObject(value);
  const floor = Math.max(10, pulseCount(row.privacyFloor) ?? 10);
  const person = spec.measure === 'my_actions';
  const rows = pulseRows(row.rows).map((item) => ({ label: pulseText(item.label), value: pulseCount(item.value) }));
  const unavailable = !Array.isArray(row.rows) || !pulseText(row.countedFrom) || rows.length > 400
    || rows.some((item) => !item.label || item.value === null)
    || (!person && row.locked !== true && ((row.withheld !== false && row.withheld !== true) || (pulseCount(row.privacyFloor) ?? 0) < 10));
  const withheld = row.withheld === true || (!person && rows.some((item) => item.value !== null && item.value > 0 && item.value < floor));
  const locked = row.locked === true;
  return { floor, person, withheld, locked, unavailable,
    countedFrom: pulseText(row.countedFrom), rows: unavailable || withheld || locked ? [] : rows.map((item) => ({ label: item.label, value: item.value! })) };
}
export function savedChart(value: unknown): SavedChart {
  const row = pulseObject(value), spec = chartSpec(row.spec);
  if (!/^[0-9a-f-]{36}$/i.test(pulseText(row.id)) || !pulseText(row.title) || !['personal', 'chapter', 'organization'].includes(pulseText(row.scope))) throw new Error('Saved chart unavailable.');
  return { id: pulseText(row.id), title: pulseText(row.title), scope: row.scope as SavedChart['scope'], spec,
    pinned: row.pinned === true, home: row.pinned === true && row.home === true, owned: row.owned === true, figures: chartFigures(row.figures, spec) };
}
export function chartShareable(chart: SavedChart): boolean {
  return chart.owned && chart.scope !== 'personal' && chart.spec.measure !== 'my_actions' && !chart.figures.locked && !chart.figures.unavailable;
}
export function chartReference(body: string): string | null {
  return /^\[pulse-chart:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/i.exec(body)?.[1] ?? null;
}
