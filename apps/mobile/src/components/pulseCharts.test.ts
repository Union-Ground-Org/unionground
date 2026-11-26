import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  averagePledgeDollars,
  formatCompactDollars,
  formatWholeDollars,
  pledgeDriveRing,
  pledgeDriveRows,
  pledgeDriveTotals,
  trendBars,
  trendChangePercent,
  trendDirection,
  trendDirectionPhrase,
  trendEndpoints,
} from '../lib/pulseFigures';

const charts = readFileSync(fileURLToPath(new URL('./charts.tsx', import.meta.url)), 'utf8');
const pulse = readFileSync(fileURLToPath(new URL('../features/PulseScreen.tsx', import.meta.url)), 'utf8');

const CHART_COMPONENTS = [
  'ActivityRings',
  'DualLineChart',
  'StackedAreaChart',
  'DonutChart',
  'TrendSpotlight',
  'ClusterBadges',
  'PledgeRing',
  'PeriodBarChart',
];

describe('Campaign pulse SVG charts (union-ground-redesign.html chart generators)', () => {
  it('draws with react-native-svg primitives, not stacked Views', () => {
    expect(charts).toContain("from 'react-native-svg'");
    // react-native-svg's Text is aliased so React Native's own Text cannot shadow it.
    expect(charts).toContain('Text as SvgText');
    // A bare identifier is already present on the import line, so matching one
    // proves nothing about the drawing. Every primitive must appear as a JSX
    // open tag, the same shape the PulseScreen case below uses.
    for (const primitive of ['Circle', 'Defs', 'LinearGradient', 'Path', 'Rect', 'Stop', 'SvgText']) {
      expect(charts, `<${primitive} is imported but never drawn`).toContain(`<${primitive}`);
    }
  });

  it('exports every ported chart form', () => {
    for (const name of CHART_COMPONENTS) {
      expect(charts).toContain(`export function ${name}(`);
    }
  });

  it('keeps the prototype geometry for each chart', () => {
    // ringsChart: r = size/2 - 9 - i*20, 14pt strokes at .18 track opacity.
    expect(charts).toContain('size / 2 - 9 - index * 20');
    expect(charts).toContain('strokeOpacity={0.18}');
    // dualLine: hollow markers r=4.5 with 2.5 rings and per-point value labels.
    expect(charts).toContain('r={4.5}');
    expect(charts).toContain('strokeWidth={2.5}');
    // areaStack: per-layer vertical gradients .95 -> .5 with a bright topline.
    // iab G1: flat band fill — one opacity, so the stacked seams render the
    // raw CHART_SERIES_ORDER floor instead of compositing into each other.
    expect(charts).toContain('stopOpacity={0.92}');
    expect(charts).not.toContain('stopOpacity={0.5}');
    // trendSpot: real computed trend line between the two half-averages.
    expect(charts).toContain('const start = (first + second) / 2;');
    expect(charts).toContain('const end = (penultimate + last) / 2;');
    // clusterBadges: r=12 badges on a dashed connector.
    expect(charts).toContain('r={12}');
    expect(charts).toContain('strokeDasharray={[3, 4]}');
    // donut: segmented ring, quarter-turn start offset, 16pt stroke.
    expect(charts).toContain('circumference * 0.25');
    expect(charts).toContain('stroke = 16');
    // pledgeRing: gradient stroke plus the star handle at the progress point.
    expect(charts).toContain('const radians = ((-90 + 360 * pct) * Math.PI) / 180;');
    expect(charts).toContain('★');
  });
});

describe('Campaign pulse screen composition', () => {
  it('derives every Pulse surface from the selected semantic theme', () => {
    expect(pulse).toContain("import { useTheme } from '../theme/ThemeProvider'");
    expect(pulse).toContain('bg: theme.background');
    expect(pulse).toContain('card: theme.card');
    expect(pulse).toContain('track: theme.muted');
    expect(pulse).toContain('grid: theme.border');
    expect(pulse).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('renders the SVG charts instead of View-based fakes', () => {
    expect(pulse).toContain("from '../components/charts'");
    for (const name of CHART_COMPONENTS) {
      // The generic pledge primitive still serves other features; Pulse
      // retired its money card on the owner's October 31 decision.
      if (name === 'PledgeRing') continue;
      expect(pulse).toContain(`<${name}`);
    }
    // The rotated-View trend line and hand-built bar columns are retired.
    expect(pulse).not.toContain("rotate: '4deg'");
    expect(pulse).not.toContain('styles.trendBar');
    expect(pulse).not.toContain('styles.turnoutBadge');
  });

  it('groups the card roster under the four filed sections, in order (b02b-8)', () => {
    // b02b-8: fourteen equal chart cards arrived as one undifferentiated
    // scroll. The roster is unchanged in content and order — every prototype
    // chart still ships — but it now sits under four named sections, and the
    // three casework charts are merged into one card with the case tags folded
    // into it, which is the other half of the finding.
    const order = [
      'Campaign pulse',
      'PARTICIPATION',
      // The period card's title is the caption of whichever period is
      // selected, so the chart itself is the stable marker for its slot.
      '<PeriodBarChart',
      "Today's organizing rings",
      'Engagement mix',
      'ISSUES',
      'Issues',
      'Issues opened versus resolved',
      'Issue status donut',
      'Issue tags · this quarter',
      'Days to resolve an issue',
      'CAMPAIGN LIFE',
      'Meeting turnout',
      'Meeting night poll',
      'Last committee meeting',
      'CONTRIBUTORS',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = pulse.indexOf(marker, cursor + 1);
      expect(at, `${marker} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(pulse).toContain('TREND DETECTED');
    // Each section header is a real header for VoiceOver, not styled text.
    expect(pulse).toContain('<Text accessibilityRole="header" style={styles.sectionLabel}>{label}</Text>');
    // The three casework cards became one, so the two retired card titles must
    // not reappear as separate NightCards.
    expect(pulse).not.toContain('<NightCard title="Issue status"');
    expect(pulse).not.toContain('<NightCard title="Issue tags"');
    expect(pulse).not.toContain('<NightCard title="Issues opened vs resolved"');
  });

  it('takes chart series from the shared trio and keeps the status ramp on state dots', () => {
    expect(pulse).toContain("import { chartPalette } from '../theme/chartPalette'");
    expect(pulse).toContain('const SERIES = statusRamp(theme);');
    expect(pulse).toContain('const [SERIES_1, SERIES_2, SERIES_3] = chartPalette(theme);');
    expect(pulse).not.toContain('chartSeries(theme)');
    expect(pulse).not.toMatch(/(?:accent|colorA|colorB|bar|line)=\{SERIES\./);
    expect(pulse).toContain('color: SERIES.done');
    // The own-cases donut that took SERIES[index] is retired (#6817); the
    // casework donut left on this screen takes the same trio.
    expect(pulse).toContain('color: chartPalette(theme)[index]!');
    // The drifted literals are gone from the screen's own palette.
    for (const retired of ["gold: '#D9A441'", "sky: '#7E5A84'", "coral: '#6B3B73'", "amber: '#8A6414'", 'NIGHT.gold', 'NIGHT.sky', 'NIGHT.coral', 'NIGHT.amber']) {
      expect(pulse, `${retired} must resolve through the ramp`).not.toContain(retired);
    }
    // `mint` survives as a text colour only — the aubergine wave-1
    // photographed on STRONG — and is never handed to a chart.
    expect(pulse).toMatch(/heroStatus: \{ color: NIGHT\.mint/);
    expect(pulse).not.toMatch(/color(A|B)=\{NIGHT\.mint\}/);
  });

  it('derives the trend footnote and the average pledge from the data beside them', () => {
    // The footnote printed the 22-day drop (78 - 56) as "down 22%", and the
    // pledge card printed a "$34" average beside $8,420 over 63 members. Both
    // figures are computed from the fixtures now, so the copy cannot drift.
    expect(trendBars[0]).toBe(78);
    expect(trendBars[trendBars.length - 1]).toBe(56);
    expect(trendChangePercent(trendBars)).toBe(-Math.round(((78 - 56) / 78) * 100));
    expect(trendChangePercent(trendBars)).toBe(-28);
    expect(trendDirectionPhrase(trendBars)).toBe('down 28%');
    expect(pulse).toContain('Average resolution time is {trendDirectionPhrase(trendBars)} over eight weeks');
    expect(pulse).not.toContain('down 22%');
    // The chart takes the same series; the percentage reads its first and last
    // values (the drawn line keeps the prototype's pair averages).
    expect(pulse).toContain('values={trendBars}');
    expect(trendEndpoints(trendBars)).toEqual({ start: 78, end: 56 });
    // The generic chart primitives do not import the Pulse fixtures module.
    expect(charts).not.toContain('pulseFigures');
    // The arrow, the spoken label and the causal clause follow the derived
    // direction instead of assuming a fall.
    expect(trendDirection(trendBars)).toBe('down');
    expect(pulse).toContain('}[trendDirection(trendBars)];');
    expect(pulse).toContain('days — ${trendCopy.spoken}.`}');
    expect(pulse).toContain('<Text style={styles.trendCaps}>{trendCopy.caps}</Text>');
    expect(pulse).toContain('over eight weeks{trendCopy.cause}.</Text>');
    expect(pulse).not.toContain('days — trending down.`}');

    expect(pledgeDriveTotals).toMatchObject({ pledgedDollars: 8420, membersGiving: 63 });
    expect(averagePledgeDollars(8420, 63)).toBe(Math.round(8420 / 63));
    expect(averagePledgeDollars(8420, 63)).toBe(134);
    expect(pledgeDriveRows(pledgeDriveTotals)).toEqual([
      ['Pledged', '$8,420'],
      ['Coworkers giving', '63'],
      ['Average pledge', '$134'],
      ['Days left', '41'],
    ]);
    // October 31 owner decision: Pulse contains no money figures. Generic
    // pledge formatting remains tested for callers outside Pulse.
    expect(pulse).not.toContain('pledgeDrive');
    // The ring, its goal caption and its spoken label read the same totals.
    expect(pledgeDriveTotals.goalDollars).toBe(12000);
    expect(pledgeDriveRing(pledgeDriveTotals)).toEqual({ progress: 8420 / 12000, value: '$8.4k', label: 'OF $12K GOAL', goal: '$12,000' });
    expect(Math.round(pledgeDriveRing(pledgeDriveTotals).progress * 100)).toBe(70);
    expect(pulse).not.toContain('Hardship fund drive');
    expect(pulse).not.toContain('serifFamily');
    expect(pulse).not.toContain('progress: 0.7');
    expect(pulse).not.toContain('$12,000');
    expect(pulse).not.toContain("'$34'");
    // The screen keeps no second copy of either fixture to disagree with.
    expect(pulse).not.toMatch(/const trendBars\s*=/);
  });

  it('never prints a figure the inputs cannot support', () => {
    expect(trendChangePercent([50, 60])).toBe(20);
    expect(trendDirectionPhrase([50, 60])).toBe('up 20%');
    expect(trendDirectionPhrase([60, 60])).toBe('flat');
    expect(trendChangePercent([])).toBeNull();
    expect(trendChangePercent([0, 12])).toBeNull();
    // A non-positive first value has no percentage, but the series still rises
    // or falls: the caption names the direction and prints no figure.
    expect(trendDirection([0, 12])).toBe('up');
    expect(trendDirectionPhrase([0, 12])).toBe('up');
    expect(trendDirectionPhrase([-5, -10])).toBe('down');
    expect(trendDirectionPhrase([0, 0])).toBe('flat');
    expect(trendDirectionPhrase([78])).toBe('flat');
    expect(averagePledgeDollars(8420, 0)).toBeNull();
    expect(pledgeDriveRows({ pledgedDollars: 0, membersGiving: 0, daysLeft: 41 })[2]).toEqual(['Average pledge', '—']);
    expect(formatWholeDollars(1234567.4)).toBe('$1,234,567');
    expect(formatWholeDollars(133.65)).toBe('$134');
    // Falls and rises round the same way at the half, and never to -0.
    expect(trendDirectionPhrase([200, 199])).toBe('down 1%');
    expect(trendDirectionPhrase([200, 201])).toBe('up 1%');
    expect(Object.is(trendChangePercent([1000, 996]), 0)).toBe(true);
    expect(trendDirection([1000, 996])).toBe('flat');
    expect(formatWholeDollars(-1234.5)).toBe('-$1,235');
    expect(formatWholeDollars(1234.5)).toBe('$1,235');
    expect(formatWholeDollars(-0.4)).toBe('$0');
    // Input that is not a printable number is a dash, never a made-up figure.
    expect(formatWholeDollars(Number.NaN)).toBe('—');
    expect(formatWholeDollars(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatWholeDollars(1e21)).toBe('—');
    expect(pledgeDriveRows({ pledgedDollars: Number.NaN, membersGiving: Number.NaN, daysLeft: Number.NaN })).toEqual([
      ['Pledged', '—'],
      ['Coworkers giving', '—'],
      ['Average pledge', '—'],
      ['Days left', '—'],
    ]);
    expect(trendEndpoints([78, Number.NaN, 56])).toBeNull();
    expect(trendDirectionPhrase([78, Number.NaN, 56])).toBe('flat');
    expect(formatCompactDollars(950)).toBe('$950');
    expect(formatCompactDollars(1250000)).toBe('$1.3m');
    expect(formatCompactDollars(Number.NaN)).toBe('—');
    expect(pledgeDriveRing({ pledgedDollars: 500, goalDollars: 0 }).progress).toBe(0);
    expect(pledgeDriveRing({ pledgedDollars: 15000, goalDollars: 12000 }).progress).toBe(1);
    expect(pledgeDriveRing({ pledgedDollars: Number.NaN, goalDollars: 12000 })).toMatchObject({ progress: 0, value: '—' });
  });

  it('keeps the live channel poll link and the D/W/M/Y period plumbing', () => {
    expect(pulse).toContain('useSyncExternalStore(channelStore.subscribe, channelStore.getVersion)');
    expect(pulse).toContain('channelStore.poll()');
    expect(pulse).toContain('channelStore.pollTotal()');
    expect(pulse).toContain('Linked to the poll in #meeting-planning');
    expect(pulse).toContain('setPeriod(key)');
    expect(pulse).toContain('const data = periods[period];');
    expect(pulse).toContain('dashboardMetrics(dashboard)');
  });

  it('never fabricates metrics for authenticated workers and keeps auth guards', () => {
    expect(pulse).toContain('<Redirect href="/sign-in" />');
    expect(pulse).toContain('<Redirect href="/mfa-challenge" />');
    expect(pulse).not.toContain('Campaign pulse is coming soon');
    expect(pulse).toContain("|| mode === 'authenticated') return <MemberPulseScreen />;");
    expect(pulse).toContain('<StateMessage');
    expect(pulse.indexOf("mode === 'authenticated'")).toBeLessThan(pulse.lastIndexOf('const metrics = dashboardMetrics'));
  });

  it('labels every chart card for screen readers and clears the floating tab bar', () => {
    // Campaign pulse is a pushed screen; it clears the bare safe area.
    expect(pulse).toContain('const bottomInset = screenBottomInset(insets.bottom)');
    expect(pulse).toContain('paddingBottom: bottomInset');
    const labels = pulse.match(/accessibilityLabel=\{`/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(8);
  });
});

// UX-UG-NATIVE-PULSE-TAB-COMING-SOON-20261018 gave a signed-in member
// a LivePulse of their own case counts. The per-hat Pulse screens replaced it,
// and TEST-UG-NATIVE-OWN-CASES-DONUT-PROOF-20261102 retired the
// unreachable branch; the routing itself is pinned in pulseRouting.test.ts.
describe('live Pulse for an authenticated worker (UX-UG-NATIVE-PULSE-TAB-COMING-SOON-20261018)', () => {
  const pulse = readFileSync(fileURLToPath(new URL('../features/PulseScreen.tsx', import.meta.url)), 'utf8');

  it('sends every signed-in worker to Worker Pulse, never a coming-soon placeholder or sampled figures', () => {
    expect(pulse).not.toMatch(/LivePulse|livePulseFigures|coming soon/);
    expect(pulse.indexOf("|| mode === 'authenticated') return <MemberPulseScreen />;")).toBeLessThan(pulse.indexOf('const metrics = dashboardMetrics(dashboard)'));
  });
});

