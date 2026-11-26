import { pulseCount, pulseObject, pulseRows, pulseText, type PulseCard, type PulseRow, type PulseTrend } from './pulseCatalog';

// #8927 slice 3: the Casework group of ready-made Pulse charts. The server
// (20261123141000) decides who may open them, filters cases by the Case flow
// row rule before counting, checks every person group against the
// organization's own floor and sends only released figures; this file turns
// its answer into the Pulse card frame and never invents a figure. Withheld,
// unavailable, zero and "no eligible records" stay different on screen.
// Every line a person reads or hears comes from COPY in the workspace language
// (English or Spanish), week names included (#9476 round 1, r1s4).
export type CaseworkLanguage = 'en' | 'es';
export const CASEWORK_CHARTS = [
  { key: 'ready:open-overdue', read: 'get_pulse_open_overdue' },
  { key: 'ready:resolution-rate', read: 'get_pulse_resolution_rate' },
  { key: 'ready:days-to-resolve', read: 'get_pulse_days_to_resolve' },
  { key: 'ready:casework', read: 'get_pulse_casework' },
] as const;
export type CaseworkKey = typeof CASEWORK_CHARTS[number]['key'];
export const isCaseworkKey = (key: string): key is CaseworkKey => CASEWORK_CHARTS.some((chart) => chart.key === key);

type Copy = {
  titles: Record<CaseworkKey, string>;
  privacy: string; withheld: string; notLoaded: string; partialHistory: string; noProcedure: string; notOpen: string; grievances: string;
  weeksWithheld: (count: number) => string; weeksBlank: (count: number) => string; latest: string;
  months: string[]; week: (month: number, day: number, long: boolean) => string;
  open: { period: string; counted: string; notCounted: string; rows: [string, string, string]; none: string };
  rate: { period: string; counted: string; notCounted: string; series: string; empty: string };
  days: { period: string; counted: string; notCounted: string; series: string; empty: string; comparison: (later: number, earlier: number) => string };
  casework: { period: string; counted: string; notCounted: string; gap: string; rows: [string, string, string, string]; statusWithheld: string; none: string };
};
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const CASEWORK_COPY: Record<CaseworkLanguage, Copy> = {
  en: {
    titles: { 'ready:open-overdue': 'Open and overdue issues', 'ready:resolution-rate': 'Resolution rate', 'ready:days-to-resolve': 'Days to resolve an issue', 'ready:casework': 'Issue work' },
    privacy: 'Counts issues you can open in this campaign; every group of people behind a figure must meet your organization’s privacy rule. No names and no issue details.',
    withheld: 'Withheld: a group of people behind these figures is too small to share safely.',
    notLoaded: 'These figures didn’t load. Refresh to try again.',
    partialHistory: 'Issues opened before issue history was kept are left out of the timed figures.',
    noProcedure: 'No issue process is set up for this campaign, so there are no issue figures to show.',
    notOpen: 'These figures are not available for your current role.',
    grievances: 'issues under your organization’s issue process that you can open in this campaign, each counted once.',
    weeksWithheld: (count) => `${count === 1 ? 'One week is' : `${count} weeks are`} withheld: a group of people behind it is too small to share safely.`,
    weeksBlank: (count) => `${count === 1 ? 'One week has' : `${count} weeks have`} no eligible records.`,
    latest: 'latest week shown',
    months: MONTHS_EN,
    week: (month, day, long) => long ? `Week of ${MONTHS_EN[month - 1]} ${day}` : `week of ${MONTHS_EN[month - 1]!.slice(0, 3)} ${day}`,
    open: {
      period: 'Campaign · today',
      counted: 'Overdue means a current step deadline has passed or was marked missed, or, for an issue with no step deadline, its own date has passed; resolved this month counts recorded first resolutions since the 1st (Eastern).', // fixed-zone: the #8927 Casework reads count periods on the data rules' America/New_York boundaries; the Nov 22 group-zone ruling has not reached them yet
      notCounted: 'Issues you cannot open, issues outside this campaign and your own issue. “In review” is not shown: no review stage is recorded for the issue process.',
      rows: ['Open', 'Overdue', 'Resolved this month'],
      none: 'No open issues and none resolved this month.',
    },
    rate: {
      period: 'Resolved within 60 days · last 8 completed weeks',
      counted: 'Each week holds the issues whose sixtieth day after recorded intake fell in it, still-open issues included; the figure is the share resolved by that day.',
      notCounted: 'Issues without a recorded intake and first resolution, issues you cannot open and your own issue. No eight-week total is shown.',
      series: 'share resolved in 60 days (%)', empty: 'No issue reached its sixtieth day in these weeks.',
    },
    days: {
      period: 'Spotlight · last 8 completed weeks',
      counted: 'The average calendar days from recorded intake to the first recorded resolution, for issues first resolved in each week.',
      notCounted: 'Issues open now (an issue reopened after its first resolution included), issues without a recorded intake and first resolution, issues you cannot open and your own issue. A change between weeks says nothing about why.',
      series: 'average days', empty: 'No issue was first resolved in these weeks.',
      comparison: (later, earlier) => `Average ${later} days in the later four weeks, ${earlier} in the earlier four`,
    },
    casework: {
      period: 'Opened and resolved · last 8 completed weeks',
      counted: 'Opened counts recorded intakes and resolved counts first recorded resolutions in the eight weeks; the status line covers the issues opened in those weeks.',
      notCounted: 'Issues without a recorded intake, issues you cannot open and your own issue. Tags are not shown: no approved list of issue categories is recorded.',
      gap: 'At least one week is withheld, so no eight-week total is shown.',
      rows: ['Opened', 'Resolved', 'Opened then, still open', 'Opened then, now resolved'],
      statusWithheld: 'The status of the issues opened in these weeks is withheld: a group of people behind it is too small to share safely.',
      none: 'No issues were opened or resolved in these weeks.',
    },
  },
  es: {
    titles: { 'ready:open-overdue': 'Asuntos abiertos y vencidos', 'ready:resolution-rate': 'Tasa de resolución', 'ready:days-to-resolve': 'Días para resolver un asunto', 'ready:casework': 'Gestión de asuntos' },
    privacy: 'Cuenta los asuntos que puedes abrir en esta campaña; cada grupo de personas detrás de una cifra debe cumplir la regla de privacidad de tu organización. Sin nombres ni detalles de asuntos.',
    withheld: 'Oculto: un grupo de personas detrás de estas cifras es demasiado pequeño para compartirlo con seguridad.',
    notLoaded: 'Estas cifras no se cargaron. Actualiza para intentarlo de nuevo.',
    partialHistory: 'Los asuntos abiertos antes de que se guardara el historial de asuntos no entran en las cifras de tiempo.',
    noProcedure: 'Esta campaña no tiene un proceso de asuntos configurado, así que no hay cifras de asuntos que mostrar.',
    notOpen: 'Estas cifras no están disponibles para tu función actual.',
    grievances: 'asuntos del proceso de tu organización que puedes abrir en esta campaña, cada uno contado una vez.',
    weeksWithheld: (count) => `${count === 1 ? 'Una semana está oculta' : `${count} semanas están ocultas`}: un grupo de personas detrás es demasiado pequeño para compartirlo con seguridad.`,
    weeksBlank: (count) => `${count === 1 ? 'Una semana no tiene' : `${count} semanas no tienen`} registros que cumplan los criterios.`,
    latest: 'semana más reciente mostrada',
    months: MONTHS_ES,
    week: (month, day, long) => long ? `Semana del ${day} de ${MONTHS_ES[month - 1]}` : `semana del ${day} de ${MONTHS_ES[month - 1]!.slice(0, 3)}`,
    open: {
      period: 'Campaña · hoy',
      counted: 'Vencido significa que pasó un plazo de etapa vigente o que se marcó como no cumplido, o, en un asunto sin plazos de etapa, que pasó su propia fecha; resueltos este mes cuenta las primeras resoluciones registradas desde el día 1 (hora del Este).', // fixed-zone: the #8927 Casework reads count periods on the data rules' America/New_York boundaries; the Nov 22 group-zone ruling has not reached them yet
      notCounted: 'Los asuntos que no puedes abrir, los asuntos de otras campañas y tu propio asunto. «En revisión» no se muestra: el proceso de asuntos no registra una etapa de revisión.',
      rows: ['Abiertas', 'Vencidas', 'Resueltas este mes'],
      none: 'No hay asuntos abiertos ni resueltos este mes.',
    },
    rate: {
      period: 'Resueltas en 60 días · últimas 8 semanas completas',
      counted: 'Cada semana reúne los asuntos cuyo día sesenta después de la admisión registrada cayó en ella, incluidos los que siguen abiertos; la cifra es la parte resuelta para ese día.',
      notCounted: 'Los asuntos sin admisión y primera resolución registradas, los asuntos que no puedes abrir y tu propio asunto. No se muestra un total de ocho semanas.',
      series: 'parte resuelta en 60 días (%)', empty: 'Ningún asunto llegó a su día sesenta en estas semanas.',
    },
    days: {
      period: 'En detalle · últimas 8 semanas completas',
      counted: 'El promedio de días naturales desde la admisión registrada hasta la primera resolución registrada, para los asuntos resueltos por primera vez en cada semana.',
      notCounted: 'Los asuntos abiertos ahora (incluido un asunto reabierto después de su primera resolución), los asuntos sin admisión y primera resolución registradas, los asuntos que no puedes abrir y tu propio asunto. Un cambio entre semanas no dice nada sobre su causa.',
      series: 'días en promedio', empty: 'Ningún asunto se resolvió por primera vez en estas semanas.',
      comparison: (later, earlier) => `Promedio de ${later} días en las cuatro semanas más recientes, ${earlier} en las cuatro anteriores`,
    },
    casework: {
      period: 'Abiertos y resueltos · últimas 8 semanas completas',
      counted: 'Abiertos cuenta las admisiones registradas y resueltos cuenta las primeras resoluciones registradas en las ocho semanas; la línea de estado cubre los asuntos abiertos en esas semanas.',
      notCounted: 'Los asuntos sin admisión registrada, los asuntos que no puedes abrir y tu propio asunto. Las etiquetas no se muestran: no hay una lista aprobada de categorías de asuntos.',
      gap: 'Al menos una semana está oculta, así que no se muestra un total de ocho semanas.',
      rows: ['Abiertos', 'Resueltos', 'Abiertos entonces, siguen abiertos', 'Abiertos entonces, ya resueltos'],
      statusWithheld: 'El estado de los asuntos abiertos en estas semanas está oculto: un grupo de personas detrás es demasiado pequeño para compartirlo con seguridad.',
      none: 'No se abrieron ni resolvieron asuntos en estas semanas.',
    },
  },
};
export const caseworkTitle = (key: string, language: CaseworkLanguage = 'en') => isCaseworkKey(key) ? CASEWORK_COPY[language].titles[key] : null;
export const CASEWORK_WITHHELD = CASEWORK_COPY.en.withheld;

type Answer = Record<string, unknown>;
// Cases opened before the case history was kept never enter a timed figure;
// every card says so in a standing line rather than a per-read flag, so the
// line itself tells no one when such a case appears or leaves (Grok pre-final).
function frame(copy: Copy, key: CaseworkKey, period: string, counted: string, notCounted: string): PulseCard {
  return { id: key, number: '', title: copy.titles[key], category: 'cases', period, countedFrom: `${copy.grievances} ${counted}`, notCounted: `${notCounted} ${copy.partialHistory}`, privacy: copy.privacy, rows: [] };
}
/** A share or a mean the server rounded: finite and not negative, else not a figure. */
function measure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function unavailable(copy: Copy, card: PulseCard, answer: Answer | null): PulseCard {
  const message = answer === null ? copy.notLoaded : answer.reason === 'no_grievance_procedure' ? copy.noProcedure : copy.notOpen;
  return { ...card, unavailable: true, message };
}
function join(...lines: (string | null | false | undefined)[]): string | undefined {
  const text = lines.filter(Boolean).join(' ');
  return text || undefined;
}

/** Monday-start weeks as the server counts them, named by their Monday's calendar date. */
export function weekMark(weekStart: string, language: CaseworkLanguage = 'en'): PulseTrend['marks'][number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!match) return null;
  const month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const copy = CASEWORK_COPY[language];
  return { axis: language === 'es' ? `${day}/${month}` : `${month}/${day}`, name: copy.week(month, day, false), spoken: copy.week(month, day, true) };
}

type Week = { mark: PulseTrend['marks'][number]; state: 'ready' | 'withheld' | 'no_eligible_records'; row: Answer };
function weeks(value: unknown, language: CaseworkLanguage): Week[] | null {
  if (!Array.isArray(value) || value.length !== 8) return null;
  const result: Week[] = [];
  for (const row of pulseRows(value)) {
    const mark = weekMark(pulseText(row.weekStart), language);
    if (!mark || (row.state !== 'ready' && row.state !== 'withheld' && row.state !== 'no_eligible_records')) return null;
    result.push({ mark, state: row.state, row });
  }
  return result;
}
// A run of weeks draws only the released weeks, each named by its date, so a
// withheld or empty week leaves a visible gap in the dates and never a zero.
function weekTrend(copy: Copy, card: PulseCard, list: Week[], figure: (row: Answer) => number | null, series: string, empty: string): PulseCard {
  const shown: { row: PulseRow; mark: PulseTrend['marks'][number] }[] = [];
  for (const week of list) {
    if (week.state !== 'ready') continue;
    const value = figure(week.row);
    if (value === null) return unavailable(copy, card, null);
    shown.push({ row: { label: week.mark.spoken, value }, mark: week.mark });
  }
  const withheld = list.filter((week) => week.state === 'withheld').length;
  const blank = list.filter((week) => week.state === 'no_eligible_records').length;
  const message = join(
    withheld ? (withheld === list.length ? copy.withheld : copy.weeksWithheld(withheld)) : null,
    blank ? (blank === list.length ? empty : copy.weeksBlank(blank)) : null,
  );
  if (!shown.length) return { ...card, rows: [], message };
  return { ...card, rows: shown.map((item) => item.row), trend: { series, latest: copy.latest, marks: shown.map((item) => item.mark) }, message };
}

export function caseworkCard(key: CaseworkKey, value: unknown, language: CaseworkLanguage = 'en'): PulseCard {
  const copy = CASEWORK_COPY[language];
  const answer = value === null || value === undefined ? null : pulseObject(value);
  if (key === 'ready:open-overdue') {
    const card = frame(copy, key, copy.open.period, copy.open.counted, copy.open.notCounted);
    if (!answer || answer.state === 'unavailable') return unavailable(copy, card, answer);
    if (answer.state === 'withheld') return { ...card, message: copy.withheld };
    const open = pulseCount(answer.open), overdue = pulseCount(answer.overdue), resolved = pulseCount(answer.resolvedThisMonth);
    if (open === null || overdue === null || resolved === null || overdue > open || (answer.state !== 'ready' && answer.state !== 'no_eligible_records')) return unavailable(copy, card, null);
    const [openLabel, overdueLabel, resolvedLabel] = copy.open.rows;
    const rows = [{ label: openLabel, value: open }, { label: overdueLabel, value: overdue }, { label: resolvedLabel, value: resolved }];
    return { ...card, rows, message: join(answer.state === 'no_eligible_records' ? copy.open.none : null) };
  }
  if (key === 'ready:resolution-rate') {
    const card = frame(copy, key, copy.rate.period, copy.rate.counted, copy.rate.notCounted);
    if (!answer || answer.state === 'unavailable') return unavailable(copy, card, answer);
    const list = weeks(answer.weeks, language);
    if (answer.state !== 'ready' || !list) return unavailable(copy, card, null);
    const result = weekTrend(copy, card, list, (row) => { const share = measure(row.percentage); return share !== null && share <= 100 ? share : null; }, copy.rate.series, copy.rate.empty);
    return { ...result, message: result.message };
  }
  if (key === 'ready:days-to-resolve') {
    const card = frame(copy, key, copy.days.period, copy.days.counted, copy.days.notCounted);
    if (!answer || answer.state === 'unavailable') return unavailable(copy, card, answer);
    const list = weeks(answer.weeks, language);
    if (answer.state !== 'ready' || !list) return unavailable(copy, card, null);
    const result = weekTrend(copy, card, list, (row) => measure(row.meanDays), copy.days.series, copy.days.empty);
    const comparison = answer.comparison ? pulseObject(answer.comparison) : null;
    const earlier = comparison ? measure(comparison.earlierMeanDays) : null, later = comparison ? measure(comparison.laterMeanDays) : null;
    const subtitle = earlier !== null && later !== null ? copy.days.comparison(later, earlier) : undefined;
    return { ...result, subtitle, message: result.message };
  }
  const card = frame(copy, key, copy.casework.period, copy.casework.counted, copy.casework.notCounted);
  if (!answer || answer.state === 'unavailable') return unavailable(copy, card, answer);
  const list = weeks(answer.weeks, language);
  const status = pulseObject(answer.status);
  if (answer.state !== 'ready' || !list) return unavailable(copy, card, null);
  if (list.some((week) => week.state !== 'ready')) {
    return { ...card, message: join(`${copy.withheld} ${copy.casework.gap}`) };
  }
  let opened = 0, resolved = 0;
  for (const week of list) {
    const a = pulseCount(week.row.opened), b = pulseCount(week.row.resolved);
    if (a === null || b === null) return unavailable(copy, card, null);
    opened += a; resolved += b;
  }
  const [openedLabel, resolvedLabel, stillOpenLabel, nowResolvedLabel] = copy.casework.rows;
  const rows: PulseRow[] = [{ label: openedLabel, value: opened }, { label: resolvedLabel, value: resolved }];
  let statusLine: string | null = null;
  if (status.state === 'ready') {
    const open = pulseCount(status.open), closed = pulseCount(status.resolved);
    if (open === null || closed === null || open + closed !== opened) return unavailable(copy, card, null);
    rows.push({ label: stillOpenLabel, value: open }, { label: nowResolvedLabel, value: closed });
  } else if (status.state === 'withheld') statusLine = copy.casework.statusWithheld;
  else if (status.state !== 'no_eligible_records') return unavailable(copy, card, null);
  return { ...card, rows, message: join(opened === 0 && resolved === 0 ? copy.casework.none : null, statusLine) };
}
