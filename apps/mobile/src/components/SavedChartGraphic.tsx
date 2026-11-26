import { forwardRef } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { Body } from './ui';
import { acrossLine, arrivalLength, barProgress, columnProgress, drawnPoints, followProgress, lineProgress } from '../lib/chartArrival';
import type { ChartFigures, ChartForm } from '../lib/savedPulseCharts';
import { nativeUiText, type NativeLanguage, type NativeUiKey } from '../lib/nativeUiCopy';
import { useChartArrival } from '../lib/useChartArrival';
import { useNativeUi } from '../lib/useNativeUi';
import { useTheme } from '../theme/ThemeProvider';
import { chartPalette } from '../theme/chartPalette';

import { typeface } from '../theme/typeface';
const chartSourceDescriptions: readonly NativeUiKey[] = [
  'Recorded sign-ups.',
  'Your recorded collective-action sign-ups, grouped by {zone} calendar month. Other people and product analytics are excluded.',
  'Recorded sign-ups to published collective actions for this campaign. Private drafts, cancelled actions and product analytics are excluded.',
  'Recorded sign-ups to published collective actions for your local. Private drafts, cancelled actions and product analytics are excluded.',
  'Recorded check-ins at non-cancelled campaign meetings that have started. RSVPs and unrecorded attendance are excluded.',
  'Recorded check-ins at non-cancelled authorized meetings in your local that have started. RSVPs and unrecorded attendance are excluded.',
  'Recorded issues in this campaign that your current staff role may read. Restricted or hidden issues outside that scope are excluded. Counts describe filings, not outcomes.',
  'Recorded issues in your local that your current staff role may read. Restricted or hidden issues outside that scope are excluded. Counts describe filings, not outcomes.',
];
const chartSourceUnitNote = 'Units use current workplace details shared with administrators; private or unmatched details remain unassigned.';

// Match the known RPC descriptions as whole sentences, with its optional
// scope prefix and unit note. Names in the prefix and unknown source copy are
// supplied data and retain their wording.
export function savedChartSourceText(source: string, language: NativeLanguage): string {
  if (language === 'en') return source;
  const english = nativeUiText('en');
  const t = nativeUiText(language);
  const suffix = ` ${chartSourceUnitNote}`;
  const hasUnitNote = source.endsWith(suffix);
  const main = hasUnitNote ? source.slice(0, -suffix.length) : source;

  for (const description of chartSourceDescriptions) {
    const original = english(description, { zone: 'Eastern' }); // fixed-zone: matches wording from the existing saved-chart RPC.
    if (main !== original && !main.endsWith(`. ${original}`)) continue;
    const prefix = main.slice(0, -original.length);
    const scope = /^(?:Case type: (.+?)\. )?(?:Unit: (.+)\. )?$/s.exec(prefix);
    if (!scope) return source;
    return [
      scope[1] ? t('Issue type: {name}.', { name: scope[1] }) : '',
      scope[2] ? t('Unit: {name}.', { name: scope[2] }) : '',
      t(description, { zone: 'ET' }), // fixed-zone: matches the RPC's month buckets.
      hasUnitNote ? t(chartSourceUnitNote) : '',
    ].filter(Boolean).join(' ');
  }
  return source;
}

// arrivalKey names the chart for its one arrival (
// 2026; lib/chartArrival.ts). A picture made to be sent is always drawn
// finished, so the image never captures a chart halfway in.
export const SavedChartGraphic = forwardRef<Svg, { figures: ChartFigures; form: ChartForm; title: string; period?: string; level?: 'chapter' | 'local'; picture?: boolean; arrivalKey?: string }>(function SavedChartGraphic({ figures, form, title, period, level, picture = false, arrivalKey }, ref) {
  const { t, language } = useNativeUi();
  const theme = useTheme();
  const [series] = chartPalette(theme);
  const marks = Math.min(figures.rows.length, 24);
  const arrival = useChartArrival(picture || form === 'table' ? null : arrivalKey ?? null,
    arrivalLength(form === 'line' ? { line: true } : form === 'bars' ? { columns: marks } : { bars: marks }));
  const { elapsed } = arrival;
  if (figures.locked) return <Body fitWords>{t('Complete the quarterly survey to see these figures.')}</Body>;
  if (figures.withheld) return <Body fitWords>{t('Withheld: at least one group has fewer than {floor} people.', { floor: figures.floor })}</Body>;
  if (figures.unavailable) return <Body fitWords>{t('Figures didn’t load. Refresh to try again.')}</Body>;
  const all = figures.rows;
  const rows = all.slice(0, form === 'table' ? 9 : 24);
  const max = Math.max(1, ...all.map((row) => row.value));
  const total = all.reduce((sum, row) => sum + row.value, 0);
  const gap = 280 / Math.max(1, rows.length);
  const y = (value: number) => 250 - 140 * value / max;
  const points = rows.map((row, index) => ({ x: 12 + (index + 0.5) * gap, y: y(row.value) }));
  const caption = figures.person
    ? t('Your own figures · personal · sharing disabled')
    : t('Each count covers at least {floor} people · a breakdown with a smaller part is hidden', { floor: figures.floor });
  const spokenFigures = all.length ? all.map((row) => `${row.label}: ${row.value}`).join('. ') : t('No recorded figures');
  const periodLabel = period ? t('Last {months} calendar months · {zone} · {scope}', {
    months: period.replace('m', ''),
    zone: 'ET', // Matches the calendar-month buckets returned by the saved-chart RPC.
    scope: t(figures.person ? 'You' : level === 'local' ? 'Local' : 'Campaign'),
  }) : null;
  const privacyLabel = figures.person
    ? t('Personal · sharing disabled')
    : t('At least {floor} people per count · smaller groups hidden', { floor: figures.floor });
  const privacyLines = language === 'es' && !figures.person ? privacyLabel.replace(' · ', ' ·\n').split('\n') : [privacyLabel];
  const resultLabel = !total ? t('No recorded figures in this period.')
    : form === 'meter' ? t('Each bar relative to the largest category ({max})', { max })
      : t('{total} recorded entries · {count} categories', { total, count: all.length });
  const resultLines = language === 'es' && form === 'meter'
    ? resultLabel.match(/.{1,45}(?:\s|$)/g) ?? [resultLabel]
    : [resultLabel];
  const source = savedChartSourceText(figures.countedFrom, language);
  return <View>
    <View ref={arrival.ref} accessible accessibilityRole="image" accessibilityLabel={`${title}. ${spokenFigures}. ${caption}`} style={{ width: '100%', aspectRatio: 320 / 480 }}>
      <Svg ref={ref} width="100%" height="100%" viewBox="0 0 320 480" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Rect width={320} height={480} fill={theme.card} />
        <SvgText x={12} y={32} fill={theme.foreground} fontSize={20} fontWeight="700">{title.slice(0, 26)}</SvgText>
        {privacyLines.map((line, index) => <SvgText key={index} x={12} y={privacyLines.length === 1 ? 58 : 51 + index * 14} fill={theme.mutedForeground} fontSize={12}>{line}</SvgText>)}
        {periodLabel ? <SvgText x={12} y={80} fill={theme.foreground} fontSize={12}>{periodLabel}</SvgText> : null}
        {form === 'table' ? rows.slice(0, 9).map((row, index) => <SvgText key={index} x={12} y={100 + index * 22} fill={theme.foreground} fontSize={14}>{row.label.slice(0, 38)}: {row.value}</SvgText>) : form === 'stack' ? rows.map((row, index) => {
          const before = rows.slice(0, index).reduce((sum, item) => sum + item.value, 0);
          return <Rect key={index} x={12 + 280 * before / Math.max(1, total)} y={145} width={Math.max(0, 280 * row.value / Math.max(1, total) - 2) * barProgress(elapsed, index, rows.length)} height={64} fill={series} />;
        }) : form === 'line' ? <>
          <Polyline fill="none" stroke={series} strokeWidth={4} points={drawnPoints(points, lineProgress(elapsed)).map((point) => `${point.x},${point.y}`).join(' ')} />
          {points.map((point, index) => <Circle key={index} cx={point.x} cy={point.y} r={5} fill={series} opacity={followProgress(elapsed, acrossLine(point.x, points[0]!.x, points[points.length - 1]!.x))} />)}
        </> : rows.map((row, index) => form === 'meter'
          ? <Rect key={index} x={12} y={90 + index * 7} width={280 * row.value / max * barProgress(elapsed, index, rows.length)} height={5} fill={series} />
          : <Rect key={index} x={12 + index * gap + gap * 0.15} y={250 - (250 - y(row.value)) * columnProgress(elapsed, index, rows.length)} width={gap * 0.7} height={(250 - y(row.value)) * columnProgress(elapsed, index, rows.length)} fill={series} />)}
        {form !== 'table' ? <><Line x1={12} x2={292} y1={254} y2={254} stroke={theme.foreground} /><SvgText x={12} y={278} fill={theme.foreground} fontSize={13}>{rows[0]?.label ?? t('No recorded figures')}</SvgText><SvgText x={292} y={298} textAnchor="end" fill={theme.foreground} fontSize={13}>{rows.at(-1)?.label ?? ''}</SvgText></> : null}
        {resultLines.map((line, index) => <SvgText key={index} x={12} y={resultLines.length === 1 ? 325 : 313 + index * 16} fill={theme.foreground} fontSize={13}>{line.trimEnd()}</SvgText>)}
        <SvgText x={12} y={348} fill={theme.mutedForeground} fontSize={12}>{all.length > rows.length ? t('Chart shows the first {shown} of {count} categories.', { shown: rows.length, count: all.length }) : picture ? t('Recorded chart picture · values as drawn') : t('Values are also listed in the table.')}</SvgText>
        {(source.match(/.{1,38}(?:\s|$)/g) ?? [source]).slice(0, 4).map((line, index) => <SvgText key={index} x={12} y={380 + index * 20} fill={theme.mutedForeground} fontSize={12}>{index === 0 ? t('Counted from: {source}', { source: line.trim() }) : line.trim()}</SvgText>)}
      </Svg>
    </View>
    {!picture ? <View>{all.map((row, index) => <View key={index} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 }}><Text style={{ color: theme.foreground, flex: 1 }}>{row.label}</Text><Text style={{ color: theme.foreground, ...typeface.controlStrong }}>{row.value}</Text></View>)}</View> : null}
  </View>;
});
