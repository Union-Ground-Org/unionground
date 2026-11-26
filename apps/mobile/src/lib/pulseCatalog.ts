import type { NativeLanguage } from './nativeUiCopy';

export type PulseRow = { label: string; value: number };

export const PULSE_WORKLOAD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  priority: 'Priority work',
  pending: 'Pending work',
  unread_docs: 'Unread documents',
  todos: 'To-dos',
  referrals: 'Referrals',
  ce_activities: 'Continuing education',
  assistance_requests: 'Assistance requests',
  aged_cases: 'Aged issues',
});
/**
 * A run of periods, oldest first, ending with the newest (the Pulse design's
 * Mock A, UX-UG-NATIVE-MEMBER-PULSE-CARDS-AS-MOCK-A-20261115). The
 * card frame draws the newest column in ink, writes its figure above it and
 * leads the card with that figure and its period's name. `marks` follow the
 * rows one for one: the axis letter, the headline name and the spoken name.
 */
export type PulseTrend = {
  /** The key's word for the columns (Mock A: "actions"). */
  series: string;
  /** The key's word for the newest column (Mock A: "this month"). */
  latest: string;
  marks: { axis: string; name: string; spoken: string }[];
};
export type PulseCard = {
  id: string;
  number: string;
  title: string;
  /** Voice holds the chapter poll and notices (#8926). */
  category: 'cases' | 'chapter' | 'meetings' | 'voice';
  period: string;
  /** The line under the title; the period is shown there when this is absent. */
  subtitle?: string;
  trend?: PulseTrend;
  countedFrom: string;
  notCounted: string;
  privacy?: string;
  rows: PulseRow[];
  unavailable?: boolean;
  message?: string;
};

export type PulseCase = { id: string; reference: string; title: string; deadline: string | null; status: string };
export type PulseDeadline = { caseID: string; label: string; dueAt: string };
export type PulsePerson = { id: string; name: string; score: number | null; scoreHidden: boolean; lastActivity: string | null };
export type PulsePeople = {
  level: 'steward' | 'chapter' | 'local';
  members: PulsePerson[];
  groups: { id: string; name: string; count: number | null; score: number | null; withheld: boolean }[];
  floor: number;
};

export function pulseObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function pulseRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(pulseObject) : [];
}
export function pulseCount(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
export function pulseText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function pulseDate(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : null;
}

export function normalizePulsePeople(value: unknown, level: PulsePeople['level']): PulsePeople {
  const root = pulseObject(value);
  if (root.level !== level || !Array.isArray(root.members) || !Array.isArray(root.groups)) throw new Error('People could not be verified.');
  const floor = Math.max(10, pulseCount(root.floor) ?? 10);
  return {
    level, floor,
    // Defense in depth: aggregate responses can never render a person, even
    // if a future server version accidentally includes a members property.
    members: level !== 'steward' ? [] : pulseRows(root.members).filter((row) => pulseText(row.id) && pulseText(row.name)).map((row) => {
      const scoreHidden = row.scoreHidden !== false;
      const score = pulseCount(row.score);
      return {
        id: pulseText(row.id), name: pulseText(row.name), scoreHidden,
        score: !scoreHidden && score !== null && score <= 100 ? score : null,
        lastActivity: scoreHidden ? null : pulseDate(row.lastActivity),
      };
    }),
    groups: pulseRows(root.groups).map((row) => {
      const count = pulseCount(row.count);
      const withheld = row.withheld !== false || count === null || count < floor;
      const score = pulseCount(row.score);
      return { id: pulseText(row.id), name: pulseText(row.name), withheld, count: withheld ? null : count, score: !withheld && score !== null && score <= 100 ? score : null };
    }),
  };
}

export const PULSE_HEALTH_BANDS: readonly {
  min: number;
  max: number;
  label: Readonly<Record<NativeLanguage, string>>;
}[] = [
  { min: 0, max: 24, label: { en: 'Critical', es: 'Crítico' } },
  { min: 25, max: 44, label: { en: 'Concerning', es: 'Preocupante' } },
  { min: 45, max: 64, label: { en: 'Moderate', es: 'Moderado' } },
  { min: 65, max: 84, label: { en: 'Healthy', es: 'Saludable' } },
  { min: 85, max: 100, label: { en: 'Excellent', es: 'Excelente' } },
];

export function pulseTier(score: number | null, language: NativeLanguage = 'en'): { index: number; label: string } {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 100) {
    return { index: -1, label: language === 'es' ? 'Actividad insuficiente' : 'Not enough activity' };
  }
  const index = PULSE_HEALTH_BANDS.findIndex(({ max }) => score <= max);
  return { index, label: PULSE_HEALTH_BANDS[index]!.label[language] };
}

/** The axis names under Pulse bars are drawn at this size (PulseCatalog). */
export const PULSE_BAR_AXIS_FONT_SIZE = 8.5;
const PULSE_BAR_AXIS_MAX_LINES = 2;
// Average glyph advance as a share of the font size, kept wide so a name
// the helper accepts still fits its slot in the bundled typefaces.
const PULSE_BAR_AXIS_CHAR_WIDTH = 0.58;

/**
 * Category names for the axis under a breakdown's bars (#9341), wrapped by
 * whole words into at most two lines per bar slot. Returns null when any
 * name cannot fit whole: those charts keep their labelled list under the
 * bars instead of showing clipped or split words. Trend cards do not use
 * this; their period marks already name the axis.
 */
export function pulseBarAxisLabels(rows: readonly PulseRow[], plotWidth = 270): string[][] | null {
  if (!rows.length || !(plotWidth > 0)) return null;
  const slot = plotWidth / rows.length;
  const charsPerLine = Math.floor((slot - 6) / (PULSE_BAR_AXIS_FONT_SIZE * PULSE_BAR_AXIS_CHAR_WIDTH));
  if (charsPerLine < 1) return null;
  const wrapped: string[][] = [];
  for (const row of rows) {
    const words = row.label.split(/\s+/).filter(Boolean);
    if (!words.length || words.some((word) => word.length > charsPerLine)) return null;
    const lines: string[] = [];
    for (const word of words) {
      const current = lines[lines.length - 1];
      if (current === undefined || current.length + 1 + word.length > charsPerLine) lines.push(word);
      else lines[lines.length - 1] = `${current} ${word}`;
    }
    if (lines.length > PULSE_BAR_AXIS_MAX_LINES) return null;
    wrapped.push(lines);
  }
  return wrapped;
}

export function pulseUpdated(at: Date): string {
  if (!Number.isFinite(at.getTime())) return 'Update time unavailable';
  return `Updated ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(at)} ET`;
}

export function pulseDeadlineLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Deadline unavailable';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  return `${day} · ${time} ET`;
}

function deadlineStamp(value: string): number {
  // A case's date-only deadline lasts through the end of its Eastern day.
  // Noon chooses the correct DST offset without depending on the phone zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const noon = new Date(`${value}T12:00:00Z`);
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).format(noon).match(/GMT([+-]\d+)/)?.[1];
    return Date.parse(`${value}T23:59:59${Number(offset) === -4 ? '-04:00' : '-05:00'}`);
  }
  return Date.parse(value);
}

export function nextStewardDeadline(cases: readonly PulseCase[], deadlines: readonly PulseDeadline[], now: number): { item: PulseCase; label: string; dueAt: string } | null {
  const candidates: { item: PulseCase; label: string; dueAt: string }[] = [];
  for (const item of cases) {
    if (item.status !== 'active') continue;
    if (item.deadline) candidates.push({ item, label: 'Issue deadline', dueAt: item.deadline });
    for (const deadline of deadlines) if (deadline.caseID === item.id) candidates.push({ item, label: deadline.label, dueAt: deadline.dueAt });
  }
  return candidates.filter((row) => Number.isFinite(deadlineStamp(row.dueAt)) && deadlineStamp(row.dueAt) <= now + 7 * 86400000)
    .sort((a, b) => deadlineStamp(a.dueAt) - deadlineStamp(b.dueAt) || a.item.id.localeCompare(b.item.id))[0] ?? null;
}
