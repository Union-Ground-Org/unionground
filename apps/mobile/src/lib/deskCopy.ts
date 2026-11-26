// Copy and ordering helpers shared by the Home drawers: the Work widgets and
// the features deck. Pure functions, so tests execute them without React
// Native and every widget states a status, a date, or a default the same way.

// Every preview chapter is a fictional Massachusetts local, so its events are
// stated in Eastern time on every device: a Boston meeting at 2:00 PM reads
// 2:00 PM from a Pacific phone too, and it turns "Past" at the Boston instant.
export const EVENT_TIME_ZONE = 'America/New_York';

// Sentence-cases a stored status ("requested", "on_ballot") for a row label.
// Values that already read as labels ("Member action") pass through unchanged.
export function statusLabel(status: string): string {
  const cleaned = status.replaceAll('_', ' ').trim();
  if (!cleaned) return '';
  return `${cleaned[0]!.toUpperCase()}${cleaned.slice(1)}`;
}

// One date grammar for every event row: weekday, month and day, the year only
// when it is not the current one, then the time. "Sun, Aug 30 · 2:00 PM" and
// "Sun, Aug 24, 2025 · 6:00 PM" therefore differ only by the year they need.
// The input is an offset-aware instant; the output is read in the event zone.
export function formatEventWhen(startsAt: string, now: Date = new Date(), timeZone: string = EVENT_TIME_ZONE): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return startsAt;
  // Hermes' iOS formatter does not reliably supply formatToParts fields.
  // Use its supported format API, keeping both date and clock in the event
  // zone. Never parse a localized calendar date back through device time.
  const years = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' });
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    ...(years.format(date) === years.format(now) ? {} : { year: 'numeric' as const }),
  }).format(date);
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: false,
  }).format(date).trim();
  const digits = /^(\d{1,2}):(\d{2})$/.exec(clock);
  // Preserve a readable native clock if an engine varies the en-US pattern.
  if (!digits || Number(digits[1]) > 24 || Number(digits[2]) > 59) return `${dateLabel} · ${clock}`;
  const nativeHour = Number(digits[1]);
  // h24 locales return 24 at midnight; h23 locales return 0.
  const hour = nativeHour % 24;
  return `${dateLabel} · ${hour % 12 || 12}:${digits[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}

export type DatedEvent = { startsAt?: string };

function eventStamp(event: DatedEvent): number {
  return event.startsAt ? new Date(event.startsAt).getTime() : Number.NaN;
}

// Upcoming events first, soonest at the top; past events after them, most
// recent first. An event without a parseable date keeps its fixture position
// among the upcoming rows rather than being guessed into the past.
export function orderEventsForDesk<T extends DatedEvent>(events: readonly T[], now: number = Date.now()): { upcoming: T[]; past: T[] } {
  const dated = (event: T) => !Number.isNaN(eventStamp(event));
  const upcoming = events.filter((event) => dated(event) && eventStamp(event) >= now).sort((a, b) => eventStamp(a) - eventStamp(b));
  const undated = events.filter((event) => !dated(event));
  const past = events.filter((event) => dated(event) && eventStamp(event) < now).sort((a, b) => eventStamp(b) - eventStamp(a));
  return { upcoming: [...upcoming, ...undated], past };
}

export function isPastEvent(event: DatedEvent, now: number = Date.now()): boolean {
  const stamp = eventStamp(event);
  return !Number.isNaN(stamp) && stamp < now;
}

// Task statuses that mean the work is finished; everything else is open.
const TERMINAL_TASK_STATUS = /^(done|completed?|closed|resolved|cancell?ed|archived)$/i;

export function isOpenTaskStatus(status: string): boolean {
  return !TERMINAL_TASK_STATUS.test(status.trim());
}

// Default deck shortcuts take one destination from each group before filling
// from the first group, so the row never mirrors the first four rows of the
// list directly beneath it.
export function defaultShortcutKeys(groups: readonly { items: readonly { key: string }[] }[], max: number): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const take = (key: string) => {
    if (seen.has(key) || keys.length >= max) return;
    seen.add(key);
    keys.push(key);
  };
  for (const group of groups) {
    const first = group.items.find((item) => !seen.has(item.key));
    if (first) take(first.key);
  }
  for (const group of groups) for (const item of group.items) take(item.key);
  return keys;
}

// Reconciles a stored shortcut selection with the current catalog: unknown
// and duplicate keys are dropped, and each slot they occupied is backfilled
// from the defaults so a release that renames a destination never empties the
// row. A member who removed every shortcut keeps an empty row; no stored
// selection at all means the defaults.
export function reconcileShortcutKeys(
  stored: readonly string[] | null,
  catalogKeys: readonly string[],
  defaults: readonly string[],
  max: number,
): string[] {
  if (!stored) return defaults.slice(0, max);
  const known = new Set(catalogKeys);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const key of stored) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  const target = Math.min(max, stored.length);
  for (const key of defaults) {
    if (kept.length >= target) break;
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  return kept.slice(0, max);
}
