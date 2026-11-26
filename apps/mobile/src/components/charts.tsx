import { useCallback, useId, useState, type RefObject } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

import {
  acrossLine,
  arrivalLength,
  columnProgress,
  countProgress,
  countText,
  drawnPoints,
  followProgress,
  lineProgress,
  sweepProgress,
  type Point,
} from '../lib/chartArrival';
import { useChartArrival } from '../lib/useChartArrival';

// SVG chart primitives ported 1:1 from the design prototype
// (guides/MOBILE/union-ground-redesign.html, chart generators around L768-905).
// Geometry — viewBox sizes, paddings, stroke widths, font sizes — is copied from
// the prototype so the native Chapter Pulse reads as the same drawing.
//
// Each chart arrives once: given an
// `arrivalKey`, the first time it is seen its columns rise, its lines draw
// across, its rings sweep round and its numbers count up (lib/chartArrival.ts).
// Without a key, and once it has arrived, it is drawn finished. Only the
// drawing inside the fixed frame changes, and the frame's accessibility label
// always carries the finished values.

type ChartFrameProps = {
  vbWidth: number;
  vbHeight: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  frameRef?: RefObject<View | null>;
  children: React.ReactNode;
};

/**
 * The prototype sizes its wide charts with `width:100%` over a fixed viewBox.
 * React Native has no CSS percentage for SVG, so we measure the container and
 * scale the viewBox uniformly — same proportions, no distortion.
 */
function ChartFrame({ vbWidth, vbHeight, accessibilityLabel, style, frameRef, children }: ChartFrameProps) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth((previous) => (Math.abs(previous - next) > 0.5 ? next : previous));
  }, []);
  return (
    <View
      ref={frameRef}
      onLayout={onLayout}
      style={[{ width: '100%' }, style]}
      accessible={accessibilityLabel ? true : undefined}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {width > 0 ? (
        <Svg width={width} height={(vbHeight * width) / vbWidth} viewBox={`0 0 ${vbWidth} ${vbHeight}`}>
          {children}
        </Svg>
      ) : null}
    </View>
  );
}

function FixedFrame({ size, accessibilityLabel, frameRef, children }: { size: number; accessibilityLabel?: string; frameRef?: RefObject<View | null>; children: React.ReactNode }) {
  return (
    <View
      ref={frameRef}
      accessible={accessibilityLabel ? true : undefined}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {children}
      </Svg>
    </View>
  );
}

function useGradientId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

const polyPath = (points: Point[]) =>
  points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join('');

/* ------------------------------------------------------------------ bars */

export type PeriodBarChartProps = {
  values: number[];
  labels: string[];
  accent: string;
  grid: string;
  text: string;
  selectedIndex?: number;
  selectedColor?: string;
  accessibilityLabel?: string;
  /** Names the chart for its one arrival; never carries data. */
  arrivalKey?: string;
};

/** Prototype `barChart` — 325x150, right-hand value axis, rounded columns. */
export function PeriodBarChart({
  values,
  labels,
  accent,
  grid,
  text,
  selectedIndex = -1,
  selectedColor = '#FFFFFF',
  accessibilityLabel,
  arrivalKey,
}: PeriodBarChartProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ columns: values.length }));
  const w = 325;
  const h = 150;
  const max = Math.max(...values, 1) * 1.15;
  const padR = 30;
  const padB = 20;
  const padT = 8;
  const iw = w - padR;
  const ih = h - padB - padT;
  const gap = iw / values.length;
  const bw = Math.min(30, gap * 0.62);
  return (
    <ChartFrame vbWidth={w} vbHeight={h} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      {[0, 0.5, 1].map((fraction) => {
        const y = padT + ih - ih * fraction;
        return (
          <G key={`grid-${fraction}`}>
            <Line x1={0} x2={iw} y1={y} y2={y} stroke={grid} strokeWidth={1} />
            <SvgText x={w - 2} y={y + 3.5} fontSize={9.5} fill={text} textAnchor="end">
              {String(Math.round(max * fraction))}
            </SvgText>
          </G>
        );
      })}
      {values.map((value, index) => {
        const bh = Math.max(4, ih * (value / max)) * columnProgress(elapsed, index, values.length);
        const x = gap * index + (gap - bw) / 2;
        const selected = index === selectedIndex;
        return (
          <G key={`bar-${index}`}>
            <Rect
              x={x}
              y={padT + ih - bh}
              width={bw}
              height={bh}
              rx={bw * 0.32}
              fill={selected ? selectedColor : accent}
              opacity={selected ? 1 : 0.88}
            />
            <SvgText
              x={x + bw / 2}
              y={h - 6}
              fontSize={10}
              fill={selected ? selectedColor : text}
              fontWeight={selected ? '800' : '500'}
              textAnchor="middle"
            >
              {labels[index]}
            </SvgText>
          </G>
        );
      })}
    </ChartFrame>
  );
}

/* ----------------------------------------------------------------- rings */

export type RingItem = { label: string; value: number; goal: number; color: string };

/** Prototype `ringsChart` — concentric Apple-Activity rings, 14pt strokes 20pt apart. */
export function ActivityRings({ items, size = 150, accessibilityLabel, arrivalKey }: { items: RingItem[]; size?: number; accessibilityLabel?: string; arrivalKey?: string }) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ sweep: true }));
  const swept = sweepProgress(elapsed);
  const cx = size / 2;
  return (
    <FixedFrame size={size} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      {items.map((item, index) => {
        const r = size / 2 - 9 - index * 20;
        const circumference = 2 * Math.PI * r;
        const filled = Math.min(Math.min(item.goal > 0 ? item.value / item.goal : 0, 1), swept);
        return (
          <G key={item.label}>
            <Circle cx={cx} cy={cx} r={r} fill="none" stroke={item.color} strokeOpacity={0.18} strokeWidth={14} />
            <Circle
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              stroke={item.color}
              strokeWidth={14}
              strokeLinecap="round"
              strokeDasharray={[circumference * filled, circumference]}
              transform={`rotate(-90 ${cx} ${cx})`}
              // A round cap paints a dot even at zero length; the sweep has not reached this ring yet.
              opacity={filled > 0 || elapsed === null ? 1 : 0}
            />
          </G>
        );
      })}
    </FixedFrame>
  );
}

/* ------------------------------------------------------------- dual line */

export type DualLineChartProps = {
  a: number[];
  b: number[];
  labels: string[];
  colorA: string;
  colorB: string;
  text: string;
  background: string;
  grid: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `dualLine` — WHOOP-style twin lines with hollow markers + point labels. */
export function DualLineChart({ a, b, labels, colorA, colorB, text, background, grid, accessibilityLabel, arrivalKey }: DualLineChartProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ line: true }));
  const w = 325;
  const h = 175;
  const max = Math.max(...a, ...b, 1) * 1.3;
  const padT = 18;
  const padB = 20;
  const ih = h - padT - padB;
  const step = w / labels.length;
  const X = (index: number) => step * index + step / 2;
  const Y = (value: number) => padT + ih - ih * (value / max);
  const drawn = lineProgress(elapsed);
  const line = (values: number[]) => polyPath(drawnPoints(values.map((value, index) => ({ x: X(index), y: Y(value) })), drawn));
  // Each marker and its value fade in as the line reaches it.
  const shown = (index: number) => followProgress(elapsed, acrossLine(X(index), X(0), X(labels.length - 1)));
  return (
    <ChartFrame vbWidth={w} vbHeight={h} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      {[0.25, 0.6, 0.95].map((fraction) => {
        const y = padT + ih * fraction;
        return <Line key={`grid-${fraction}`} x1={0} x2={w} y1={y} y2={y} stroke={grid} strokeWidth={1} />;
      })}
      <Path d={line(a)} fill="none" stroke={colorA} strokeWidth={2} />
      <Path d={line(b)} fill="none" stroke={colorB} strokeWidth={2} />
      {a.map((value, index) => (
        <G key={`a-${index}`} opacity={shown(index)}>
          <Circle cx={X(index)} cy={Y(value)} r={4.5} fill={background} stroke={colorA} strokeWidth={2.5} />
          <SvgText x={X(index)} y={Y(value) - 9} fontSize={9.5} fontWeight="700" fill={colorA} textAnchor="middle">
            {String(value)}
          </SvgText>
        </G>
      ))}
      {b.map((value, index) => (
        <G key={`b-${index}`} opacity={shown(index)}>
          <Circle cx={X(index)} cy={Y(value)} r={4.5} fill={background} stroke={colorB} strokeWidth={2.5} />
          <SvgText x={X(index)} y={Y(value) + 17} fontSize={9.5} fontWeight="700" fill={colorB} textAnchor="middle">
            {String(value)}
          </SvgText>
        </G>
      ))}
      {labels.map((label, index) => (
        <SvgText key={`l-${index}`} x={X(index)} y={h - 3} fontSize={9} fill={text} textAnchor="middle">
          {label}
        </SvgText>
      ))}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------ area stack */

export type AreaLayer = { name: string; color: string; values: number[] };

export type StackedAreaChartProps = {
  layers: AreaLayer[];
  labels: string[];
  text: string;
  grid: string;
  line: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `areaStack` — gradient-filled stacked mountain with a bright topline. */
export function StackedAreaChart({ layers, labels, text, grid, line, accessibilityLabel, arrivalKey }: StackedAreaChartProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ line: true }));
  const drawn = lineProgress(elapsed);
  const w = 325;
  const h = 175;
  const padT = 10;
  const padB = 18;
  const padR = 36;
  const ih = h - padT - padB;
  const iw = w - padR;
  const n = labels.length;
  const uid = useGradientId('area');
  const totals = labels.map((_, index) => layers.reduce((sum, layer) => sum + (layer.values[index] ?? 0), 0));
  const max = Math.max(...totals, 1) * 1.15;
  const X = (index: number) => (n > 1 ? iw * (index / (n - 1)) : iw / 2);
  const Y = (value: number) => padT + ih - ih * (value / max);
  // Running totals per layer — the stack each band is drawn on top of.
  const cumulative = layers.map((_, li) =>
    labels.map((__, i) => layers.slice(0, li + 1).reduce((sum, layer) => sum + (layer.values[i] ?? 0), 0)),
  );
  // The stack draws across from the left: every band and the topline stop at the same cut.
  const points = (values: number[]) => drawnPoints(values.map((value, index) => ({ x: X(index), y: Y(value) })), drawn);
  const poly = (values: number[]) => polyPath(points(values));
  const top = cumulative[cumulative.length - 1] ?? [];
  const paths = layers.map((layer, li) => {
    const topLine = points(cumulative[li] ?? []);
    const below = li ? cumulative[li - 1] ?? null : null;
    let d = polyPath(topLine);
    if (below) {
      const under = points(below);
      for (let i = under.length - 1; i >= 0; i -= 1) d += `L${under[i]!.x},${under[i]!.y}`;
    } else {
      d += `L${topLine[topLine.length - 1]?.x ?? X(n - 1)},${Y(0)}L${X(0)},${Y(0)}`;
    }
    return { key: layer.name, d: `${d}Z`, li };
  });
  return (
    <ChartFrame vbWidth={w} vbHeight={h} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      <Defs>
        {layers.map((layer, li) => (
          <LinearGradient key={layer.name} id={`${uid}${li}`} x1="0" y1="0" x2="0" y2="1">
            {/* Flat fill per band (iab G1): a per-band alpha ramp composited
                adjacent ramp inks into near-identical seams, so the stacked
                bands carry one opacity and CHART_SERIES_ORDER's raw seam
                floor (1.554:1) is what actually renders. */}
            <Stop offset="0" stopColor={layer.color} stopOpacity={0.92} />
            <Stop offset="1" stopColor={layer.color} stopOpacity={0.92} />
          </LinearGradient>
        ))}
      </Defs>
      {[0, 0.33, 0.66, 1].map((fraction) => {
        const y = padT + ih - ih * fraction;
        return (
          <G key={`grid-${fraction}`}>
            <Line x1={0} x2={iw} y1={y} y2={y} stroke={grid} strokeDasharray={[3, 4]} />
            <SvgText x={w - 2} y={y + 3.5} fontSize={9} fill={text} textAnchor="end">
              {String(Math.round(max * fraction))}
            </SvgText>
          </G>
        );
      })}
      {paths
        .slice()
        .reverse()
        .map((path) => (
          <Path key={path.key} d={path.d} fill={`url(#${uid}${path.li})`} />
        ))}
      <Path d={poly(top)} fill="none" stroke={line} strokeOpacity={0.85} strokeWidth={1.5} />
      {top.map((value, index) => (
        <Circle
          key={`dot-${index}`}
          cx={X(index)}
          cy={Y(value)}
          r={index === n - 1 ? 5.5 : 2.6}
          fill={line}
          fillOpacity={index === n - 1 ? 1 : 0.9}
          opacity={followProgress(elapsed, acrossLine(X(index), X(0), X(n - 1)))}
        />
      ))}
      {labels.map((label, index) => (
        <SvgText
          key={`l-${index}`}
          x={X(index)}
          y={h - 2}
          fontSize={9.5}
          fill={text}
          textAnchor="middle"
          fontWeight={index === n - 1 ? '800' : '500'}
        >
          {label}
        </SvgText>
      ))}
    </ChartFrame>
  );
}

/* -------------------------------------------------------- trend spotlight */

export type TrendSpotlightProps = {
  values: number[];
  bar: string;
  line: string;
  text: string;
  grid: string;
  unit?: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `trendSpot` — muted bars plus a computed first-half → second-half trend line. */
export function TrendSpotlight({ values, bar, line, text, grid, unit = 'd', accessibilityLabel, arrivalKey }: TrendSpotlightProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ columns: values.length, line: true }));
  const w = 325;
  const h = 135;
  const padR = 36;
  const padB = 18;
  const padT = 10;
  const iw = w - padR;
  const ih = h - padT - padB;
  const max = Math.max(...values, 1) * 1.3;
  const gap = iw / values.length;
  const bw = Math.min(26, gap * 0.6);
  const Y = (value: number) => padT + ih - ih * (value / max);
  // The prototype draws the trend between the first-pair and last-pair averages.
  const first = values[0] ?? 0;
  const second = values[1] ?? first;
  const last = values[values.length - 1] ?? 0;
  const penultimate = values[values.length - 2] ?? last;
  const start = (first + second) / 2;
  const end = (penultimate + last) / 2;
  const x1 = gap * 0.5;
  const x2 = gap * (values.length - 0.5);
  const [, trendEnd = { x: x1, y: Y(start) }] = drawnPoints([{ x: x1, y: Y(start) }, { x: x2, y: Y(end) }], lineProgress(elapsed));
  return (
    <ChartFrame vbWidth={w} vbHeight={h} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      <Line x1={0} x2={iw} y1={Y(start)} y2={Y(start)} stroke={grid} strokeDasharray={[4, 4]} />
      <SvgText x={w - 2} y={Y(max / 1.3) + 3} fontSize={9} fill={text} textAnchor="end">
        {`${Math.round(max / 1.3)}${unit}`}
      </SvgText>
      <SvgText x={w - 2} y={Y(0) + 3} fontSize={9} fill={text} textAnchor="end">
        {`0${unit}`}
      </SvgText>
      {values.map((value, index) => {
        const x = gap * index + (gap - bw) / 2;
        const bh = (padT + ih - Y(value)) * columnProgress(elapsed, index, values.length);
        return (
          <G key={`bar-${index}`}>
            <Rect x={x} y={padT + ih - bh} width={bw} height={bh} rx={5} fill={bar} />
            <SvgText x={x + bw / 2} y={h - 4} fontSize={9.5} fill={text} textAnchor="middle">
              {String(index + 1)}
            </SvgText>
          </G>
        );
      })}
      <Line x1={x1} y1={Y(start)} x2={trendEnd.x} y2={trendEnd.y} stroke={line} strokeWidth={2.5} />
      <Circle cx={x1} cy={Y(start)} r={5} fill={line} opacity={followProgress(elapsed, 0)} />
      <Circle cx={x2} cy={Y(end)} r={5} fill={line} opacity={followProgress(elapsed, 1)} />
    </ChartFrame>
  );
}

/* --------------------------------------------------------- cluster badges */

export type ClusterBadgesProps = {
  values: number[];
  badges: number[];
  labels: string[];
  colors: readonly string[];
  text: string;
  badgeBg: string;
  badgeText: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `clusterBadges` — turnout bars with circular RSVP badges on a dashed connector. */
export function ClusterBadges({ values, badges, labels, colors, text, badgeBg, badgeText, accessibilityLabel, arrivalKey }: ClusterBadgesProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ columns: values.length, line: true }));
  const w = 325;
  const h = 160;
  const padT = 28;
  const padB = 20;
  const ih = h - padT - padB;
  const max = Math.max(...values, ...badges, 1) * 1.15;
  const gap = w / values.length;
  const bw = 30;
  const Y = (value: number) => padT + ih - ih * (value / max);
  return (
    <ChartFrame vbWidth={w} vbHeight={h} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      <Path
        d={polyPath(drawnPoints(badges.map((value, index) => ({ x: gap * index + gap / 2, y: Y(value) })), lineProgress(elapsed)))}
        fill="none"
        stroke={text}
        strokeWidth={1.5}
        strokeDasharray={[3, 4]}
      />
      {values.map((value, index) => {
        const bh = (padT + ih - Y(value)) * columnProgress(elapsed, index, values.length);
        return (
          <Rect
            key={`bar-${index}`}
            x={gap * index + (gap - bw) / 2}
            y={padT + ih - bh}
            width={bw}
            height={bh}
            rx={9}
            fill={colors[index % colors.length]}
          />
        );
      })}
      {badges.map((value, index) => {
        const cx = gap * index + gap / 2;
        return (
          <G key={`badge-${index}`} opacity={followProgress(elapsed, acrossLine(cx, gap / 2, gap * (badges.length - 0.5)))}>
            <Circle cx={cx} cy={Y(value)} r={12} fill={badgeBg} />
            <SvgText x={cx} y={Y(value) + 3.5} fontSize={10.5} fontWeight="800" fill={badgeText} textAnchor="middle">
              {String(value)}
            </SvgText>
          </G>
        );
      })}
      {labels.map((label, index) => (
        <SvgText key={`l-${index}`} x={gap * index + gap / 2} y={h - 4} fontSize={10} fill={text} textAnchor="middle">
          {label}
        </SvgText>
      ))}
    </ChartFrame>
  );
}

/* ----------------------------------------------------------------- donut */

export type DonutSegment = { value: number; color: string };

export type DonutChartProps = {
  segments: DonutSegment[];
  total: number;
  label: string;
  size?: number;
  stroke?: number;
  text: string;
  sub: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `donut` — Jira-style segmented ring with a centered total. */
export function DonutChart({ segments, total, label, size = 132, stroke = 16, text, sub, accessibilityLabel, arrivalKey }: DonutChartProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ sweep: true, counts: 1 }));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const safeTotal = total > 0 ? total : 1;
  // The ring sweeps round in segment order; each segment shows the part the sweep has passed.
  const swept = circumference * sweepProgress(elapsed);
  let offset = circumference * 0.25;
  let before = 0;
  const arcs = segments.map((segment, index) => {
    const full = (circumference * segment.value) / safeTotal;
    const length = Math.min(full, Math.max(0, swept - before));
    const arc = { key: `${segment.color}-${index}`, color: segment.color, length, offset };
    offset -= full;
    before += full;
    return arc;
  });
  return (
    <FixedFrame size={size} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      {arcs.map((arc) => (
        <Circle
          key={arc.key}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={arc.color}
          strokeWidth={stroke}
          strokeDasharray={[Math.max(arc.length - 2.5, 0), circumference - arc.length + 2.5]}
          strokeDashoffset={arc.offset}
          strokeLinecap="butt"
        />
      ))}
      <SvgText x={size / 2} y={size * 0.47} textAnchor="middle" fontSize={26} fontWeight="800" fill={text}>
        {countText(String(total), countProgress(elapsed))}
      </SvgText>
      <SvgText x={size / 2} y={size * 0.62} textAnchor="middle" fontSize={9} fontWeight="700" fill={sub} letterSpacing={1.5}>
        {label}
      </SvgText>
    </FixedFrame>
  );
}

/* ------------------------------------------------------------ pledge ring */

export type PledgeRingProps = {
  progress: number;
  size?: number;
  from: string;
  to: string;
  track: string;
  text: string;
  sub: string;
  handle: string;
  value: string;
  label: string;
  valueFontFamily?: string;
  accessibilityLabel?: string;
  arrivalKey?: string;
};

/** Prototype `pledgeRing` — gradient goal ring with a star handle at the progress point. */
export function PledgeRing({
  progress,
  size = 165,
  from,
  to,
  track,
  text,
  sub,
  handle,
  value,
  label,
  valueFontFamily,
  accessibilityLabel,
  arrivalKey,
}: PledgeRingProps) {
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ sweep: true, counts: 1 }));
  const uid = useGradientId('pledge');
  const pct = Math.min(Math.max(progress, 0), 1);
  const swept = Math.min(pct, sweepProgress(elapsed));
  const r = (size - 30) / 2;
  const circumference = 2 * Math.PI * r;
  const cx = size / 2;
  const radians = ((-90 + 360 * pct) * Math.PI) / 180;
  const hx = cx + r * Math.cos(radians);
  const hy = cx + r * Math.sin(radians);
  return (
    <FixedFrame size={size} accessibilityLabel={accessibilityLabel} frameRef={ref}>
      <Defs>
        <LinearGradient id={uid} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Circle cx={cx} cy={cx} r={r} fill="none" stroke={track} strokeWidth={15} />
      <Circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke={`url(#${uid})`}
        strokeWidth={15}
        strokeLinecap="round"
        strokeDasharray={[circumference * swept, circumference]}
        transform={`rotate(-90 ${cx} ${cx})`}
        opacity={swept > 0 || elapsed === null ? 1 : 0}
      />
      {/* The handle appears where the sweep stops. */}
      <G opacity={elapsed === null || swept >= pct ? 1 : 0}>
        <Circle cx={hx} cy={hy} r={11} fill={handle} stroke={to} strokeWidth={3} />
        <SvgText x={hx} y={hy + 3.5} fontSize={10} textAnchor="middle" fill={to}>
          ★
        </SvgText>
      </G>
      <SvgText
        x={cx}
        y={size * 0.47}
        textAnchor="middle"
        fontSize={28}
        fontWeight="600"
        fill={text}
        fontFamily={valueFontFamily}
      >
        {countText(value, countProgress(elapsed))}
      </SvgText>
      <SvgText x={cx} y={size * 0.6} textAnchor="middle" fontSize={9} fontWeight="700" letterSpacing={1.5} fill={sub}>
        {label}
      </SvgText>
    </FixedFrame>
  );
}
