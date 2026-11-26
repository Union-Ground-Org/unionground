// Campaign Pulse preview fixtures whose figures are quoted in copy. The copy is
// derived from the numbers here, so a fixture edit can never leave the screen
// printing a percentage or an average its own data contradicts.

export const pledgeDriveTotals = { pledgedDollars: 8420, goalDollars: 12000, membersGiving: 63, daysLeft: 41 };

// Days to resolve a workplace issue, one value per week, oldest first.
export const trendBars = [78, 74, 70, 64, 72, 58, 60, 56];

const NO_FIGURE = '—';

// Rounds the magnitude, so a fall and a rise of the same size round the same
// way at the half. A value that is not a printable whole number is a dash,
// never "$NaN" or "$1e+21".
export function formatWholeDollars(dollars: number): string {
  const rounded = Math.round(Math.abs(dollars));
  if (!Number.isSafeInteger(rounded)) return NO_FIGURE;
  const digits = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${dollars < 0 && rounded > 0 ? '-' : ''}$${digits}`;
}

// The ring's short figure: "$8.4k", "$12k", "$1.2m". Whole dollars under $1,000.
export function formatCompactDollars(dollars: number): string {
  const rounded = Math.round(Math.abs(dollars));
  if (!Number.isSafeInteger(rounded) || rounded < 1000) return formatWholeDollars(dollars);
  const thousands = Math.round(rounded / 100) / 10;
  const short = thousands < 1000 ? `${thousands}k` : `${Math.round(rounded / 100000) / 10}m`;
  return `${dollars < 0 ? '-' : ''}$${short}`;
}

function formatCount(count: number): string {
  return Number.isFinite(count) ? String(count) : NO_FIGURE;
}

// Whole dollars, like every other figure on the pledge card. Null when nobody
// has given, so the row never prints a division by zero.
export function averagePledgeDollars(pledgedDollars: number, membersGiving: number): number | null {
  if (!Number.isFinite(pledgedDollars) || !Number.isFinite(membersGiving) || membersGiving <= 0) return null;
  return Math.round(pledgedDollars / membersGiving);
}

// The first and last values of a series: the two operands of the percentage
// under the chart. Null unless every value is a finite number, so the caption
// cannot describe data the bars and their spoken label do not show.
export function trendEndpoints(values: readonly number[]): { start: number; end: number } | null {
  const start = values[0];
  const end = values[values.length - 1];
  if (values.length < 2 || start === undefined || end === undefined || !values.every(Number.isFinite)) return null;
  return { start, end };
}

// Signed change from the first value to the last as a whole percentage of the
// first: 78 -> 56 is -28, not the 22-day difference.
export function trendChangePercent(values: readonly number[]): number | null {
  const ends = trendEndpoints(values);
  if (ends === null || ends.start <= 0) return null;
  const magnitude = Math.round((Math.abs(ends.end - ends.start) / ends.start) * 100);
  if (magnitude === 0) return 0;
  return ends.end < ends.start ? -magnitude : magnitude;
}

export type TrendDirection = 'down' | 'up' | 'flat';

// The one place direction is decided; the phrase, the arrow and the spoken
// label all read it. "flat" means the endpoints are level, the change rounds
// to 0%, or the series has no endpoints (too short, or a non-finite value the
// chart cannot plot either). A non-positive first value has no percentage but
// still has a direction, so the caption never says "flat" over a sloping line.
export function trendDirection(values: readonly number[]): TrendDirection {
  const ends = trendEndpoints(values);
  if (ends === null) return 'flat';
  const change = trendChangePercent(values) ?? ends.end - ends.start;
  if (change === 0) return 'flat';
  return change < 0 ? 'down' : 'up';
}

// "down 28%"; the bare direction when the first value supports no percentage.
export function trendDirectionPhrase(values: readonly number[]): string {
  const direction = trendDirection(values);
  const change = trendChangePercent(values);
  if (direction === 'flat' || change === null) return direction;
  return `${direction} ${Math.abs(change)}%`;
}

export function pledgeDriveRows(totals: Omit<typeof pledgeDriveTotals, 'goalDollars'>): [string, string][] {
  const average = averagePledgeDollars(totals.pledgedDollars, totals.membersGiving);
  return [
    ['Pledged', formatWholeDollars(totals.pledgedDollars)],
    ['Coworkers giving', formatCount(totals.membersGiving)],
    ['Average pledge', average === null ? NO_FIGURE : formatWholeDollars(average)],
    ['Days left', formatCount(totals.daysLeft)],
  ];
}

// The ring beside the rows: its fill, its short figure, its goal caption and
// the goal its spoken label names, all from the same totals as the rows.
export function pledgeDriveRing(totals: Pick<typeof pledgeDriveTotals, 'pledgedDollars' | 'goalDollars'>) {
  const share = totals.goalDollars > 0 ? totals.pledgedDollars / totals.goalDollars : 0;
  return {
    progress: Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0,
    value: formatCompactDollars(totals.pledgedDollars),
    label: `OF ${formatCompactDollars(totals.goalDollars).toUpperCase()} GOAL`,
    goal: formatWholeDollars(totals.goalDollars),
  };
}
