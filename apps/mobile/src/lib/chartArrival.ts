// Charts arrive once (Union Ground theme,;
// REQ-UG-NATIVE-CHARTS-ARRIVE-ONCE-THEME-DECISION-4-20261113).
// The first time a chart is seen its bars rise, its line draws across and its
// numbers count up; never again in that app session, never when its data
// refreshes, and not at all under Reduce Motion. This is the timing half,
// dependency-free so vitest can execute it (chartArrival.test.ts); the hook
// that decides when a chart is seen is useChartArrival.ts.
//
// Values are the theme library's MOTION["chart"] (promo package tools,
// ug_theme_lib.py), the same numbers the guide's own charts and the web app's
// ChartArrival run on. Times are milliseconds.
import { ANDROID_NATIVE_TAB_BAR_HEIGHT, IOS_NATIVE_TAB_BAR_HEIGHT } from './chromeGeometry';

export const CHART_ARRIVAL = Object.freeze({
  /** Share of the chart (or of the screen, for a chart taller than the screen) that must be on screen. */
  seen: 0.35,
  /** Horizontal bars grow across. */
  bar: 700,
  barStagger: 70,
  /** Columns grow upward. */
  column: 750,
  columnStagger: 60,
  /** A line or area draws across after a short beat... */
  line: 950,
  lineDelay: 80,
  /** ...and its dots and labels fade in as the line reaches them. */
  label: 260,
  /** Numbers count up from zero. */
  count: 800,
  countStagger: 90,
  /** A long run of bars spreads its stagger over at most this. */
  staggerTotal: 560,
});

/** The theme's motion ease, tokens.json motion.ease: cubic-bezier(.23, 1, .32, 1). */
export const CHART_ARRIVAL_EASE: readonly [number, number, number, number] = Object.freeze([0.23, 1, 0.32, 1]);

/** Rings and donuts sweep round over a line and a bit, and the sweep overshoots the circle so its end lands whole. */
export const CHART_SWEEP = Object.freeze({ duration: CHART_ARRIVAL.line + 200, degrees: 400 });

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (t: number, a: number, b: number) => (1 - 3 * b + 3 * a) * t * t * t + (3 * b - 6 * a) * t * t + 3 * a * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 40; i += 1) {
      const v = at(t, x1, x2);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return at(t, y1, y2);
  };
}

export const arrivalEase = bezier(...CHART_ARRIVAL_EASE);

/** Time between neighbours in a run of n, spread over at most staggerTotal. */
export function staggerGap(count: number, each: number): number {
  return count > 1 ? Math.min(each, CHART_ARRIVAL.staggerTotal / (count - 1)) : 0;
}

/**
 * Eased progress 0..1 of one step that starts `delay` ms into the arrival and
 * lasts `duration` ms. `elapsed` null means the chart is finished (arrived
 * before, Reduce Motion, a test, an exported picture): every step is whole.
 */
export function stepProgress(elapsed: number | null, delay: number, duration: number): number {
  if (elapsed === null) return 1;
  if (duration <= 0) return elapsed >= delay ? 1 : 0;
  return arrivalEase((elapsed - delay) / duration);
}

/** Column `index` of `count`, growing upward from its base. */
export function columnProgress(elapsed: number | null, index: number, count: number): number {
  return stepProgress(elapsed, index * staggerGap(count, CHART_ARRIVAL.columnStagger), CHART_ARRIVAL.column);
}

/** Bar `index` of `count`, growing across from its start. */
export function barProgress(elapsed: number | null, index: number, count: number): number {
  return stepProgress(elapsed, index * staggerGap(count, CHART_ARRIVAL.barStagger), CHART_ARRIVAL.bar);
}

/** How far a line or area has drawn across, 0..1 of its width. */
export function lineProgress(elapsed: number | null): number {
  return stepProgress(elapsed, CHART_ARRIVAL.lineDelay, CHART_ARRIVAL.line);
}

/** Opacity of a dot or label at `at` (0..1 across the line) as the line reaches it. */
export function followProgress(elapsed: number | null, at: number): number {
  const clamped = Math.min(1, Math.max(0, at));
  return stepProgress(elapsed, CHART_ARRIVAL.lineDelay + clamped * CHART_ARRIVAL.line, CHART_ARRIVAL.label);
}

/** Share of the circle a ring or donut has swept, 0..1. */
export function sweepProgress(elapsed: number | null): number {
  return Math.min(1, (stepProgress(elapsed, 0, CHART_SWEEP.duration) * CHART_SWEEP.degrees) / 360);
}

/** Progress of the `index`th number counting up. */
export function countProgress(elapsed: number | null, index = 0): number {
  return stepProgress(elapsed, index * CHART_ARRIVAL.countStagger, CHART_ARRIVAL.count);
}

/** Total length of an arrival, so the hook knows when the chart is finished. */
export function arrivalLength(parts: { columns?: number; bars?: number; line?: boolean; sweep?: boolean; counts?: number }): number {
  const lengths = [0];
  if (parts.columns) lengths.push(CHART_ARRIVAL.column + staggerGap(parts.columns, CHART_ARRIVAL.columnStagger) * (parts.columns - 1));
  if (parts.bars) lengths.push(CHART_ARRIVAL.bar + staggerGap(parts.bars, CHART_ARRIVAL.barStagger) * (parts.bars - 1));
  if (parts.line) lengths.push(CHART_ARRIVAL.lineDelay + CHART_ARRIVAL.line + CHART_ARRIVAL.label);
  if (parts.sweep) lengths.push(CHART_SWEEP.duration + CHART_ARRIVAL.label);
  if (parts.counts) lengths.push(CHART_ARRIVAL.count + CHART_ARRIVAL.countStagger * (parts.counts - 1));
  return Math.max(...lengths);
}

const COUNTABLE = /^(\s*)(\$?)(\d[\d,]*)(\.\d+)?(.*)$/s;

/**
 * The text a counting number shows at `progress`. It counts only a value that
 * starts with one number (an optional "$", separators and decimals kept as the
 * caller wrote them, any unit after it), as the guide's count-up does; any
 * other text, and the finished count, is exactly the caller's own text.
 */
export function countText(value: string, progress: number): string {
  if (progress >= 1) return value;
  const match = COUNTABLE.exec(value);
  if (!match) return value;
  const [, lead = '', currency = '', whole = '', fraction = '', rest = ''] = match;
  const target = Number.parseFloat((whole + fraction).replace(/,/g, ''));
  if (!(target > 0)) return value;
  const decimals = fraction ? fraction.length - 1 : 0;
  let shown = (target * Math.max(0, progress)).toFixed(decimals);
  if (whole.includes(',')) {
    const [int = '', dec] = shown.split('.');
    shown = [int.replace(/\B(?=(\d{3})+(?!\d))/g, ','), ...(dec === undefined ? [] : [dec])].join('.');
  }
  return lead + currency + shown + rest;
}

/**
 * Style for a bar drawn as a View while it grows from its base: across from
 * the left, or up from the bottom. A transform only, so nothing around the bar
 * moves; null once whole, so a finished bar carries no transform at all.
 */
export function growStyle(progress: number, axis: 'x' | 'y'): { transform: ({ scaleX: number } | { scaleY: number })[]; transformOrigin: string } | null {
  if (progress >= 1) return null;
  // A zero scale can leave a native view unpainted after it grows; a thousandth is invisible.
  const scale = Math.max(progress, 0.001);
  return axis === 'x'
    ? { transform: [{ scaleX: scale }], transformOrigin: 'left' }
    : { transform: [{ scaleY: scale }], transformOrigin: 'bottom' };
}

export type Point = { x: number; y: number };

/**
 * The part of a left-to-right polyline drawn so far: every point up to the
 * cut, plus the point where the cut crosses the next segment. Lines and areas
 * draw across this way, so the drawing never needs a clip path.
 */
export function drawnPoints(points: readonly Point[], progress: number): Point[] {
  if (progress >= 1 || points.length < 2) return points.slice();
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const cut = first.x + (last.x - first.x) * Math.max(0, progress);
  const drawn: Point[] = [first];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]!;
    const point = points[i]!;
    if (point.x <= cut) {
      drawn.push(point);
      continue;
    }
    const span = point.x - previous.x;
    const t = span > 0 ? (cut - previous.x) / span : 0;
    drawn.push({ x: cut, y: previous.y + (point.y - previous.y) * t });
    break;
  }
  return drawn;
}

/** Where a point sits across a line, 0 at its first point and 1 at its last. */
export function acrossLine(x: number, first: number, last: number): number {
  return last > first ? (x - first) / (last - first) : 1;
}

export type WindowRect = { x: number; y: number; width: number; height: number };

// Room at the bottom of the window where a chart is still hidden: the native
// tab bar over the system navigation area (a three-button bar on Android, the
// home indicator on iOS). A screen without a tab bar loses nothing but a
// slightly later start; without the band, a chart below the fold arrived
// behind the tab bar and was already whole when it scrolled into view (seen on
// the Android emulator, Nov 13, 2026).
const SYSTEM_NAVIGATION: Readonly<Record<string, number>> = Object.freeze({ ios: 34, android: 48 });

// A screen that is pushed is laid out before it is shown, then slides or fades
// in; on the Android emulator a channel's poll had arrived before its screen
// appeared (Nov 13, 2026). A chart therefore starts arriving no sooner than
// this long after its screen is focused. A chart scrolled into view later,
// long after its screen opened, starts as soon as it is seen.
export const SCREEN_SETTLE_MS = 600;

export function hiddenBottomBand(platform: string): number {
  const bar = platform === 'ios' ? IOS_NATIVE_TAB_BAR_HEIGHT : platform === 'android' ? ANDROID_NATIVE_TAB_BAR_HEIGHT : 0;
  return bar + (SYSTEM_NAVIGATION[platform] ?? 0);
}

/**
 * Seen: at least `seen` of the chart's height is in the open part of the
 * screen, above `hiddenBottom` (or that share of the open part, for a chart
 * taller than it), and part of it is across the screen. A chart with no size
 * yet, or on a screen that is not showing, is not seen.
 */
export function seenEnough(chart: WindowRect, screen: { width: number; height: number }, hiddenBottom = 0): boolean {
  const open = screen.height - Math.max(0, hiddenBottom);
  if (!(chart.width > 0 && chart.height > 0 && screen.width > 0 && open > 0)) return false;
  if (chart.x >= screen.width || chart.x + chart.width <= 0) return false;
  const visible = Math.min(chart.y + chart.height, open) - Math.max(chart.y, 0);
  return visible > 0 && visible >= CHART_ARRIVAL.seen * Math.min(chart.height, open);
}

// Charts that have arrived in this app session, by the name their screen gives
// them. A name never carries data, so a refresh, a new period or a filter
// draws the same chart whole instead of arriving again.
const arrived = new Set<string>();

export function chartArrived(key: string): boolean {
  return arrived.has(key);
}

export function markChartArrived(key: string): void {
  arrived.add(key);
}

/** Tests only: start a new app session. */
export function forgetChartArrivals(): void {
  arrived.clear();
}
