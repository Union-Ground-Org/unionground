import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from './Text';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Body, Button, Card, Heading } from './ui';
import { arrivalLength, columnProgress } from '../lib/chartArrival';
import type { NativeUiText } from '../lib/nativeUiCopy';
import { PULSE_BAR_AXIS_FONT_SIZE, pulseBarAxisLabels, type PulseCard, type PulseRow, type PulseTrend } from '../lib/pulseCatalog';
import { useNativeUi } from '../lib/useNativeUi';
import { useReduceMotion } from '../lib/reduceMotion';
import { useChartArrival } from '../lib/useChartArrival';
import { useTheme } from '../theme/ThemeProvider';
import { pulsePalette } from '../theme/pulsePalette';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
// The Pulse card frame, as the Pulse design's Mock A draws it
// (UX-UG-NATIVE-MEMBER-PULSE-CARDS-AS-MOCK-A-20261115): the number,
// the title and its line, a headline figure for a run of periods, columns in
// series green with the newest one in ink, every number in ink, the privacy
// line and a key. The member, steward and leadership Pulse share it.

const PLOT = 270;
const AXIS = 22;

/** One column, rounded at the top only, standing on the baseline. */
function columnPath(x: number, base: number, width: number, height: number): string {
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  return `M${x},${base} v${-(height - r)} a${r},${r} 0 0 1 ${r},${-r} h${width - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${height - r} z`;
}

/** Grid steps a reader can say: whole numbers when the data is whole. */
function tick(value: number): string {
  return String(Number.isInteger(value) ? value : Number(value.toFixed(1)));
}

export function PulseBars({ rows, trend, expanded = false, arrivalKey }: { rows: readonly PulseRow[]; trend?: PulseTrend; expanded?: boolean; arrivalKey?: string }) {
  const theme = useTheme();
  const { catalogLabel } = useNativeUi();
  // Arrives once, the first time it is seen ( lib/chartArrival.ts).
  const { ref, elapsed } = useChartArrival(arrivalKey ?? null, arrivalLength({ columns: rows.length }));
  const colors = pulsePalette(theme);
  const marks = trend && trend.marks.length === rows.length ? trend.marks : null;
  const h = expanded ? 220 : 140;
  // A run of periods writes its newest figure above its column: leave it room.
  const top = marks ? 22 : 12;
  // App-owned category names are localized before layout, so the axis, the
  // values list and the spoken name agree; member-authored names (chapter
  // and event titles inside composite labels) are not catalogue keys and
  // pass through unchanged (R-K10).
  const names = rows.map((row, index) => marks ? marks[index]!.spoken : catalogLabel(row.label));
  // A breakdown names each bar on the axis when the names fit whole .
  const axisLabels = marks ? null : pulseBarAxisLabels(rows.map((row, index) => ({ ...row, label: names[index]! })), PLOT);
  const axisLines = axisLabels ? Math.max(...axisLabels.map((lines) => lines.length)) : 0;
  const base = h - (axisLabels ? 14 + axisLines * 10 : AXIS);
  const peak = Math.max(1, ...rows.map((row) => row.value));
  const max = marks ? Math.max(peak + 1, Math.ceil(peak * 1.12)) : peak;
  const gap = PLOT / Math.max(1, rows.length);
  const bar = Math.min(22, gap * (marks ? 0.56 : 0.65));
  const last = rows.length - 1;
  const label = rows.map((row, index) => `${names[index]!}: ${row.value}`).join('. ');
  return <View ref={ref} accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: '100%', aspectRatio: 320 / h }}>
    <Svg viewBox={`0 0 320 ${h}`} width="100%" height="100%" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 0.5, 1].map((part) => {
        const y = base - part * (base - top);
        const value = marks ? Math.round(max * part) : max * part;
        return <Grid key={part} y={y} value={tick(value)} />;
      })}
      {rows.map((row, index) => {
        const x = index * gap + (gap - bar) / 2;
        const height = (base - top) * row.value / max * columnProgress(elapsed, index, rows.length);
        const newest = Boolean(marks) && index === last;
        return <Path key={`${row.label}-${index}`} d={columnPath(x, base, bar, height)} fill={newest ? theme.foreground : colors.series[0]} />;
      })}
      {marks ? <>
        <SvgText x={last * gap + gap / 2} y={base - (base - top) * rows[last]!.value / max * columnProgress(elapsed, last, rows.length) - 6} fontSize={11} fontWeight="600" fill={theme.foreground} textAnchor="middle">{rows[last]!.value}</SvgText>
        {marks.map((mark, index) => <SvgText key={`axis-${index}`} x={index * gap + gap / 2} y={h - 6} fontSize={10} fill={theme.mutedForeground} textAnchor="middle">{mark.axis}</SvgText>)}
      </> : axisLabels ? axisLabels.map((lines, index) => lines.map((line, lineIndex) => <SvgText key={`axis-${index}-${lineIndex}`} x={index * gap + gap / 2} y={base + 13 + lineIndex * 10} fontSize={PULSE_BAR_AXIS_FONT_SIZE} fill={theme.mutedForeground} textAnchor="middle">{line}</SvgText>)) : null}
    </Svg>
  </View>;
}

function Grid({ y, value }: { y: number; value: string }) {
  const theme = useTheme();
  // A light grid, as Mock A draws it. The package's grid is fill-2 #E3DED1; the
  // phone palette has no fill-2 token, so this uses the app's muted #E2DCCB, a
  // near match and not the same value.
  return <><Line x1={0} x2={PLOT} y1={y} y2={y} stroke={theme.muted} strokeWidth={1} /><SvgText x={318} y={y + 4} fontSize={11} fill={theme.foreground} textAnchor="end">{value}</SvgText></>;
}

function Values({ rows, trend }: { rows: readonly PulseRow[]; trend?: PulseTrend }) {
  const theme = useTheme();
  const { catalogLabel } = useNativeUi();
  const marks = trend && trend.marks.length === rows.length ? trend.marks : null;
  return <View style={styles.values}>{rows.map((row, index) => {
    const name = marks ? marks[index]!.spoken : catalogLabel(row.label);
    return <View key={`${row.label}-${index}`} style={styles.valueRow} accessible accessibilityLabel={`${name}: ${row.value}`}>
      <Text style={[styles.valueLabel, { color: theme.foreground }]}>{name}</Text>
      <Text style={[styles.value, { color: theme.foreground }]}>{row.value}</Text>
    </View>;
  })}</View>;
}

/** The newest period's figure and name, when the rows are a run of periods. */
function headline(card: PulseCard): { figure: number; name: string } | null {
  const marks = card.trend?.marks;
  const row = card.rows[card.rows.length - 1];
  if (card.unavailable || !row || !marks || marks.length !== card.rows.length) return null;
  return { figure: row.value, name: marks[marks.length - 1]!.name };
}

function CardFigures({ card, expanded, t }: { card: PulseCard; expanded?: boolean; t: NativeUiText }) {
  if (card.unavailable) return <Body muted>{card.message ?? t('These figures could not be loaded. Refresh to try again.')}</Body>;
  // A run of periods reads from its columns (Mock A); any other breakdown
  // keeps its labelled list, and names each bar on the axis when the names
  // fit whole under their columns .
  return <>
    {card.rows.length ? <>
      <PulseBars rows={card.rows} trend={card.trend} expanded={expanded} arrivalKey={`pulse-card:${card.id}${expanded ? ':expanded' : ''}`} />
      {headline(card) ? null : <Values rows={card.rows} />}
    </> : null}
    {card.message ? <Body muted>{card.message}</Body> : null}
  </>;
}

function Key({ color, label }: { color: string; label: string }) {
  const theme = useTheme();
  return <View style={styles.key}><View style={[styles.swatch, { backgroundColor: color }]} /><Text style={[styles.small, { color: theme.mutedForeground }]}>{label}</Text></View>;
}

/** Large text sizes put the figure under the title, so the title keeps its width. */
const STACK_FONT_SCALE = 1.3;

function Headline({ figure, name, stacked }: { figure: number; name: string; stacked: boolean }) {
  const theme = useTheme();
  return <View style={stacked ? styles.heroStacked : styles.hero}>
    <Text style={[styles.heroFigure, { color: theme.foreground }]}>{figure}</Text>
    <Text style={[styles.small, stacked ? null : styles.heroName, { color: theme.mutedForeground }]}>{name}</Text>
  </View>;
}

export function PulseCatalogCard({ card, onOpen }: { card: PulseCard; onOpen: () => void }) {
  const theme = useTheme();
  const { t, catalogLabel } = useNativeUi();
  const stacked = useWindowDimensions().fontScale > STACK_FONT_SCALE;
  const lead = headline(card);
  const colors = pulsePalette(theme);
  const name = lead
    ? t('{number}. {title}. {figure} in {period}. Expand chart', { number: card.number, title: card.title, figure: lead.figure, period: lead.name })
    : t('{number}. {title}. Expand chart', { number: card.number, title: card.title });
  return <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onOpen} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.99 : 1 }] })}>
    <Card>
      <View style={styles.heading}>
        <Text style={[styles.number, { color: theme.secondaryForeground, backgroundColor: theme.secondary }]}>{card.number}</Text>
        <View style={styles.title}>
          {/* No word breaks mid-word beside the number at large sizes . */}
          <Heading level={3} fitWords>{card.title}</Heading><Text style={[styles.small, { color: theme.mutedForeground }]}>{card.subtitle ?? catalogLabel(card.period)}</Text>
          {lead && stacked ? <Headline figure={lead.figure} name={lead.name} stacked /> : null}
        </View>
        {lead && !stacked ? <Headline figure={lead.figure} name={lead.name} stacked={false} /> : null}
      </View>
      <CardFigures card={card} t={t} />
      {card.privacy ? <Text style={[styles.small, { color: theme.mutedForeground }]}>{card.privacy}</Text> : null}
      <View style={styles.foot}>
        {lead && card.trend ? <><Key color={colors.series[0]} label={card.trend.series} /><Key color={theme.foreground} label={card.trend.latest} /></> : null}
        <Text style={[styles.small, styles.expand, { color: theme.mutedForeground }]}>{t('tap to expand ›')}</Text>
      </View>
    </Card>
  </Pressable>;
}

export function PulseExpandSheet({ card, onClose }: { card: PulseCard | null; onClose: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { t, catalogLabel } = useNativeUi();
  const [table, setTable] = useState(false);
  if (!card) return null;
  const lead = headline(card);
  return <Modal visible animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose} accessibilityViewIsModal>
    <ScrollView style={{ backgroundColor: theme.card }} contentContainerStyle={[styles.sheet, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}>
      <Button label={t('Close chart')} variant="secondary" onPress={onClose} />
      <Body muted>{card.number} · {catalogLabel(card.period)}</Body>
      <Heading>{card.title}</Heading>
      {card.subtitle ? <Body muted>{card.subtitle}</Body> : null}
      {lead ? <Text style={[styles.heroFigure, { color: theme.foreground }]}>{lead.figure} <Text style={[styles.small, { color: theme.mutedForeground }]}>{lead.name}</Text></Text> : null}
      {table && !card.unavailable ? <Values rows={card.rows} trend={card.trend} /> : <CardFigures card={card} expanded t={t} />}
      <Button label={table ? t('Chart view') : t('Table view')} variant="secondary" onPress={() => setTable((value) => !value)} />
      <Heading level={3}>{t('Counted from')}</Heading><Body>{card.countedFrom}</Body>
      <Heading level={3}>{t('What this does not count')}</Heading><Body>{card.notCounted}</Body>
      {card.privacy ? <Body muted>{card.privacy}</Body> : null}
    </ScrollView>
  </Modal>;
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  title: { flex: 1, minWidth: 0, gap: 2 },
  number: { borderRadius: radii.sm - 2, paddingHorizontal: 7, paddingVertical: 6, fontSize: 13, ...typeface.controlStrong, fontVariant: ['tabular-nums'] },
  hero: { flexShrink: 0, maxWidth: '40%', alignItems: 'flex-end' },
  heroStacked: { marginTop: spacing.xs },
  heroFigure: { fontSize: 28, lineHeight: 32, ...typeface.controlStrong, fontVariant: ['tabular-nums'] },
  heroName: { textAlign: 'right' },
  small: { fontSize: 13, lineHeight: 18 },
  foot: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  expand: { marginLeft: 'auto' },
  values: { gap: spacing.xs },
  valueRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, minHeight: 32, alignItems: 'center' },
  valueLabel: { flex: 1, fontSize: 14, lineHeight: 20 },
  value: { fontSize: 18, ...typeface.controlStrong, fontVariant: ['tabular-nums'] },
  sheet: { padding: spacing.lg, gap: spacing.md, minHeight: minimumTouchTarget },
});
