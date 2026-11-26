import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHART_ARRIVAL,
  CHART_ARRIVAL_EASE,
  CHART_SWEEP,
  SCREEN_SETTLE_MS,
  acrossLine,
  arrivalEase,
  arrivalLength,
  barProgress,
  chartArrived,
  columnProgress,
  countProgress,
  countText,
  drawnPoints,
  followProgress,
  forgetChartArrivals,
  growStyle,
  hiddenBottomBand,
  lineProgress,
  markChartArrived,
  seenEnough,
  staggerGap,
  stepProgress,
  sweepProgress,
} from './chartArrival';

// REQ-UG-NATIVE-CHARTS-ARRIVE-ONCE-THEME-DECISION-4-20261113:
// f the Union Ground theme, Nov 13, 2026. Charts arrive once.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

afterEach(() => forgetChartArrivals());

describe('chart arrival timings', () => {
  it('are the theme library MOTION chart values', () => {
    expect(CHART_ARRIVAL).toEqual({
      seen: 0.35,
      bar: 700,
      barStagger: 70,
      column: 750,
      columnStagger: 60,
      line: 950,
      lineDelay: 80,
      label: 260,
      count: 800,
      countStagger: 90,
      staggerTotal: 560,
    });
    expect(CHART_SWEEP).toEqual({ duration: 1150, degrees: 400 });
    // Not a theme value: how long a pushed screen takes to be shown on a phone.
    expect(SCREEN_SETTLE_MS).toBe(600);
  });

  it('run on the theme ease, tokens.json motion.ease cubic-bezier(.23, 1, .32, 1)', () => {
    expect(CHART_ARRIVAL_EASE).toEqual([0.23, 1, 0.32, 1]);
    expect(arrivalEase(0)).toBe(0);
    expect(arrivalEase(1)).toBe(1);
    // A fast start that settles: well past halfway at a quarter of the time.
    expect(arrivalEase(0.25)).toBeGreaterThan(0.6);
    expect(arrivalEase(0.5)).toBeGreaterThan(arrivalEase(0.25));
    expect(arrivalEase(0.75)).toBeLessThan(1);
  });

  it('spread a long run of bars over at most 560 ms', () => {
    expect(staggerGap(1, 60)).toBe(0);
    expect(staggerGap(5, 60)).toBe(60);
    expect(staggerGap(24, 60)).toBeCloseTo(560 / 23);
    expect(arrivalLength({ columns: 24 })).toBeCloseTo(750 + 560);
    expect(arrivalLength({ bars: 3 })).toBe(700 + 140);
    expect(arrivalLength({ line: true })).toBe(80 + 950 + 260);
    expect(arrivalLength({ sweep: true, counts: 1 })).toBe(1150 + 260);
    expect(arrivalLength({})).toBe(0);
  });

  it('draw every mark whole once a chart is finished', () => {
    for (const progress of [stepProgress(null, 500, 700), columnProgress(null, 7, 8), barProgress(null, 3, 4), lineProgress(null), followProgress(null, 1), sweepProgress(null), countProgress(null, 2)]) {
      expect(progress).toBe(1);
    }
  });

  it('start empty, stagger neighbours and end whole', () => {
    expect(columnProgress(0, 0, 8)).toBe(0);
    expect(columnProgress(60, 1, 8)).toBe(0);
    expect(columnProgress(400, 0, 8)).toBeGreaterThan(columnProgress(400, 1, 8));
    expect(columnProgress(750, 0, 8)).toBe(1);
    expect(barProgress(70 + 700, 1, 2)).toBe(1);
    expect(lineProgress(80)).toBe(0);
    expect(lineProgress(80 + 950)).toBe(1);
    // A marker at the end of the line fades in after the line reaches it.
    expect(followProgress(80 + 950, 1)).toBe(0);
    expect(followProgress(80 + 950 + 260, 1)).toBe(1);
    expect(countProgress(90, 1)).toBe(0);
    expect(countProgress(890, 1)).toBe(1);
    expect(sweepProgress(0)).toBe(0);
    expect(sweepProgress(1150)).toBe(1);
  });
});

describe('numbers count up', () => {
  it('to exactly the text the caller wrote', () => {
    expect(countText('42', 0)).toBe('0');
    expect(countText('42', 0.5)).toBe('21');
    expect(countText('42', 1)).toBe('42');
    expect(countText('$8.4k', 0.5)).toBe('$4.2k');
    expect(countText('1,204 votes', 0.5)).toBe('602 votes');
    expect(countText('12,000', 0.5)).toBe('6,000');
  });

  it('leaves text that is not one leading number alone', () => {
    for (const value of ['—', 'Hidden', '0', 'Sep 12']) {
      expect(countText(value, 0.3)).toBe(value);
    }
  });
});

describe('lines draw across', () => {
  const points = [{ x: 0, y: 10 }, { x: 10, y: 20 }, { x: 20, y: 0 }];

  it('stop at the cut, with the crossing point interpolated', () => {
    expect(drawnPoints(points, 0)).toEqual([{ x: 0, y: 10 }, { x: 0, y: 10 }]);
    expect(drawnPoints(points, 0.25)).toEqual([{ x: 0, y: 10 }, { x: 5, y: 15 }]);
    expect(drawnPoints(points, 0.75)).toEqual([{ x: 0, y: 10 }, { x: 10, y: 20 }, { x: 15, y: 10 }]);
    expect(drawnPoints(points, 1)).toEqual(points);
  });

  it('place markers across the line', () => {
    expect(acrossLine(5, 0, 20)).toBe(0.25);
    expect(acrossLine(3, 3, 3)).toBe(1);
  });
});

describe('a chart is seen', () => {
  const phone = { width: 390, height: 844 };

  it('when 35% of it is on screen, or 35% of the screen for a tall chart', () => {
    expect(seenEnough({ x: 16, y: 844 - 52, width: 358, height: 150 }, phone)).toBe(false);
    expect(seenEnough({ x: 16, y: 844 - 53, width: 358, height: 150 }, phone)).toBe(true);
    expect(seenEnough({ x: 16, y: -97, width: 358, height: 150 }, phone)).toBe(true);
    expect(seenEnough({ x: 16, y: 844 - 296, width: 358, height: 2000 }, phone)).toBe(true);
    expect(seenEnough({ x: 16, y: 844 - 290, width: 358, height: 2000 }, phone)).toBe(false);
  });

  it('not while it sits behind the tab bar and system navigation at the bottom', () => {
    expect(hiddenBottomBand('android')).toBe(64 + 48);
    expect(hiddenBottomBand('ios')).toBe(49 + 34);
    expect(hiddenBottomBand('web')).toBe(0);
    const band = hiddenBottomBand('android');
    // 66% of the chart is inside the window, but all of that is under the bar.
    expect(seenEnough({ x: 16, y: 844 - 100, width: 358, height: 150 }, phone)).toBe(true);
    expect(seenEnough({ x: 16, y: 844 - 100, width: 358, height: 150 }, phone, band)).toBe(false);
    expect(seenEnough({ x: 16, y: 844 - band - 52, width: 358, height: 150 }, phone, band)).toBe(false);
    expect(seenEnough({ x: 16, y: 844 - band - 53, width: 358, height: 150 }, phone, band)).toBe(true);
    // A tall chart needs 35% of the open part of the screen.
    expect(seenEnough({ x: 16, y: 844 - band - 257, width: 358, height: 2000 }, phone, band)).toBe(true);
    expect(seenEnough({ x: 16, y: 844 - band - 250, width: 358, height: 2000 }, phone, band)).toBe(false);
  });

  it('never while it has no size or sits off to the side', () => {
    expect(seenEnough({ x: 0, y: 0, width: 0, height: 150 }, phone)).toBe(false);
    expect(seenEnough({ x: 0, y: 0, width: 300, height: 0 }, phone)).toBe(false);
    expect(seenEnough({ x: 390, y: 100, width: 300, height: 150 }, phone)).toBe(false);
    expect(seenEnough({ x: -300, y: 100, width: 300, height: 150 }, phone)).toBe(false);
  });
});

describe('a chart arrives once per app session', () => {
  it('by its name, never its data', () => {
    expect(chartArrived('pulse:participation')).toBe(false);
    markChartArrived('pulse:participation');
    expect(chartArrived('pulse:participation')).toBe(true);
    forgetChartArrivals();
    expect(chartArrived('pulse:participation')).toBe(false);
  });

  it('and View bars carry no transform once whole', () => {
    expect(growStyle(1, 'x')).toBeNull();
    expect(growStyle(0.5, 'x')).toEqual({ transform: [{ scaleX: 0.5 }], transformOrigin: 'left' });
    expect(growStyle(0, 'y')).toEqual({ transform: [{ scaleY: 0.001 }], transformOrigin: 'bottom' });
  });
});

describe('every phone chart is wired to arrive', () => {
  const charts = read('../components/charts.tsx');
  const pulse = read('../features/PulseScreen.tsx');

  it('each chart form runs the shared arrival and keeps its frame', () => {
    const forms = ['PeriodBarChart', 'ActivityRings', 'DualLineChart', 'StackedAreaChart', 'TrendSpotlight', 'ClusterBadges', 'DonutChart', 'PledgeRing'];
    expect(charts.match(/useChartArrival\(arrivalKey \?\? null,/g)).toHaveLength(forms.length);
    expect(charts.match(/frameRef=\{ref\}/g)).toHaveLength(forms.length);
  });

  it('Campaign pulse names every chart, spark and bar group', () => {
    for (const key of ['pulse:participation', 'pulse:organizing-rings', 'pulse:engagement-mix', 'pulse:casework-flow', 'pulse:case-status', 'pulse:days-to-resolve', 'pulse:meeting-turnout', 'pulse:meeting-poll', 'pulse:contributors']) {
      expect(pulse).toContain(`"${key}"`);
    }
    expect(pulse).toContain('arrivalKey={`pulse:kpi:${kpi.label}`}');
  });

  it('the catalogue, saved charts and channel polls arrive, and a sent picture never moves', () => {
    expect(read('../components/PulseCatalog.tsx')).toContain('arrivalKey={`pulse-card:${card.id}${expanded ?');
    const saved = read('../components/SavedChartGraphic.tsx');
    expect(saved).toContain("useChartArrival(picture || form === 'table' ? null : arrivalKey ?? null,");
    const savedScreens = read('../features/SavedPulseCharts.tsx');
    for (const key of ['saved-chart:${chart.id}', "saved-chart-preview:${chart?.id ?? 'new'}", 'saved-chart-live:${id}']) {
      expect(savedScreens).toContain(`arrivalKey={\`${key}\`}`);
    }
    expect(savedScreens).toMatch(/<SavedChartGraphic ref=\{svg\}[^>]* picture \/>/);
    expect(read('../components/ChannelPollCard.tsx')).toContain('arrivalKey={`channel-poll:${poll.question}`}');
  });
});
