import { Redirect } from 'expo-router';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { contentStartInset, screenBottomInset } from '../lib/chrome';
import { usePinnedHeaderChrome, useScreenNameAlreadySpoken } from '../components/PinnedHeader';
import {
  ActivityRings,
  ClusterBadges,
  DonutChart,
  DualLineChart,
  PeriodBarChart,
  StackedAreaChart,
  TrendSpotlight,
} from '../components/charts';
import { ArrivingBars } from '../components/ArrivingBars';
import { NumberFlow } from '../components/NumberFlow';
import { SparkBars, StateMessage, Screen } from '../components/ui';
import { channelStore, pollShares } from '../data/demoChannels';
import { trendBars, trendDirection, trendDirectionPhrase } from '../lib/pulseFigures';
import { explicitLiveStaffHat } from '../lib/hatFunctions';
import { caseStepInReview } from '../lib/caseStepLabels';
import { dashboardMetrics } from '../models/member';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { chartPalette } from '../theme/chartPalette';
import { statusRamp } from '../theme/statusRamp';
import { minimumTouchTarget, radii, spacing, type ThemeTokens } from '../theme/tokens';
import { NativeFeatureGuide } from './guideLayers/GuideLayers';
import StewardPulseScreen from './StewardPulseScreen';
import MemberPulseScreen from './MemberPulseScreen';
import LeadershipPulseScreen from './LeadershipPulseScreen';
import { leadershipHat } from '../lib/leadershipPulse';
import { typeface } from '../theme/typeface';

// Pulse uses the system sans and the selected semantic theme.
function pulseColors(theme: ThemeTokens) {
  return {
    bg: theme.background,
    card: theme.card,
    card2: theme.secondary,
    track: theme.muted,
    ink: theme.foreground,
    sub: theme.mutedForeground,
    cream: theme.secondary,
    grid: theme.border,
    bar: theme.border,
    badgeInk: theme.secondaryForeground,
    mint: theme.primary,
  };
}

// The owner's October 31 trio supplies chart series. Status colors stay on
// state dots and badges; labels and legends identify each chart's categories.

type PeriodKey = 'D' | 'W' | 'M' | 'Y';
const periods: Record<PeriodKey, { label: string; caption: string; values: number[]; labels: string[] }> = {
  D: { label: 'Day', caption: 'Worker actions today', values: [2, 5, 8, 4, 9, 3, 6], labels: ['8a', '10a', '12p', '2p', '4p', '6p', '8p'] },
  W: { label: 'Week', caption: 'Worker actions this week', values: [12, 18, 9, 22, 31, 15, 24], labels: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] },
  M: { label: 'Month', caption: 'Worker actions in August', values: [96, 124, 88, 142], labels: ['W1', 'W2', 'W3', 'W4'] },
  Y: { label: 'Year', caption: 'Worker actions · 12 months', values: [210, 180, 260, 190, 240, 280, 310, 290, 330, 300, 360, 410], labels: ['S', 'O', 'N', 'D', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A'] },
};

const caseFlow = {
  opened: [6, 9, 7, 11, 8, 10, 7, 9],
  resolved: [4, 7, 8, 9, 9, 11, 8, 10],
  labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'],
};
// Everything the trend card says about direction hangs off the one derived
// direction, so the arrow, the spoken label and the footnote cannot disagree.
// Only a fall has a cause to name.
const trendCopy = {
  down: { caps: '↘  TREND DETECTED', spoken: 'trending down', cause: ' — faster committee hand-offs after intake are carrying the trend' },
  up: { caps: '↗  TREND DETECTED', spoken: 'trending up', cause: '' },
  flat: { caps: '→  NO CLEAR TREND', spoken: 'holding steady', cause: '' },
}[trendDirection(trendBars)];

const turnout = { attended: [48, 52, 61, 74], rsvps: [55, 58, 66, 80], labels: ['May', 'Jun', 'Jul', 'Aug'] };
// Four periods of one metric are one series, so they take one hue; the months
// under the bars are what tells them apart, not four colours.
const caseTags: [string, number][] = [['Scheduling', 12], ['Pay', 9], ['Health & safety', 6], ['Discipline', 4], ['Out-of-title', 3]];

function usePulseStyles() {
  const theme = useTheme();
  return useMemo(() => stylesForPulseTheme(theme), [theme]);
}

const pulseStylesByTheme = new WeakMap<ThemeTokens, ReturnType<typeof createStyles>>();

function stylesForPulseTheme(theme: ThemeTokens) {
  const cached = pulseStylesByTheme.get(theme);
  if (cached) return cached;
  const styles = createStyles(theme);
  pulseStylesByTheme.set(theme, styles);
  return styles;
}

function NightCard({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  const styles = usePulseStyles();
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
      </View>
      {children}
    </View>
  );
}

// b02b-8: fourteen equal chart cards arrived as one undifferentiated scroll, so
// nothing said which question a card answered. They are grouped under four
// section headers now — PARTICIPATION, ISSUES, CAMPAIGN LIFE, CONTRIBUTORS —
// and the issue charts are merged into one card with the issue tags folded
// into it, which is the other half of the finding.
function PulseSection({ label }: { label: string }) {
  const styles = usePulseStyles();
  return <Text accessibilityRole="header" style={styles.sectionLabel}>{label}</Text>;
}

// A hairline rule inside a merged card: the two charts stay one object without
// growing a second card edge around each half.
function CardRule() {
  const styles = usePulseStyles();
  return <View style={styles.cardRule} />;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  const styles = usePulseStyles();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function LegendRing({ color, label }: { color: string; label: string }) {
  const styles = usePulseStyles();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendRing, { borderColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

export default function PulseScreen() {
  const theme = useTheme();
  const styles = usePulseStyles();
  const NIGHT = pulseColors(theme);
  const SERIES = statusRamp(theme);
  const [SERIES_1, SERIES_2, SERIES_3] = chartPalette(theme);
  const insets = useSafeAreaInsets();
  const pinned = usePinnedHeaderChrome();
  // Pushed hosts may announce the name; a tab root owns its visible heading.
  const pulseEcho = useScreenNameAlreadySpoken('Campaign pulse');
  const bottomInset = screenBottomInset(insets.bottom);
  const { dashboard, mode, previewDesk, previewHat, authorizedRoles, refreshing, refresh } = useApp();
  const [period, setPeriod] = useState<PeriodKey>('W');
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const pulseHat = mode === 'preview' ? previewHat : explicitLiveStaffHat(authorizedRoles);
  if (pulseHat === 'steward') return <StewardPulseScreen />;
  const leadership = leadershipHat(mode === 'preview' ? previewHat ? [previewHat] : [] : authorizedRoles);
  if (leadership) return <LeadershipPulseScreen hat={leadership} />;
  // TEST-UG-NATIVE-OWN-CASES-DONUT-PROOF-20261102: every signed-in
  // person who is not a sole steward or leadership hat wears the member hat.
  // The own-cases screen that once followed this line was unreachable after
  // role normalization and is retired. The sampled charts below are
  // demo-workspace visualizations and never render for a live account.
  if ((mode === 'preview' && previewHat === 'member') || mode === 'authenticated') return <MemberPulseScreen />;
  if (!dashboard) return <Screen bottomInset={bottomInset}><StateMessage title="Campaign pulse is loading" body="Charts appear once your workspace loads." /></Screen>;

  const metrics = dashboardMetrics(dashboard);
  const data = periods[period];
  const maxValue = Math.max(...data.values);
  const peakIndex = data.values.indexOf(maxValue);
  const periodTotal = data.values.reduce((sum, value) => sum + value, 0);
  const poll = channelStore.poll();
  const pollTotal = channelStore.pollTotal();
  // b05-13: the same apportioned whole percentages the channel card shows, so
  // the two surfaces of one poll can never print different numbers.
  const pollPercent = pollShares(poll.options);
  const contributors = [
    { label: 'Survey responses', status: 'Optimal', share: 0.71 },
    { label: 'Meeting attendance', status: 'Good', share: 0.58 },
    { label: 'Open issues resolved', status: 'Good', share: 0.64 },
    { label: 'New worker sign-ups', status: 'Pay attention', share: 0.45 },
  ].map((row) => ({ ...row, color: SERIES_1 }));
  const ringItems = [
    { label: 'Actions logged', value: 26, goal: 30, color: SERIES_1 },
    { label: '1-on-1 conversations', value: 8, goal: 12, color: SERIES_2 },
    { label: 'New sign-ups', value: 3, goal: 5, color: SERIES_3 },
  ];
  const engagement = {
    labels: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    layers: [
      { name: 'Issues', color: SERIES_1, values: [5, 6, 4, 8, 9, 5, 7] },
      { name: 'Meetings', color: SERIES_2, values: [3, 5, 2, 6, 10, 3, 5] },
      { name: 'Messages and trainings', color: SERIES_3, values: [10, 13, 7, 15, 18, 11, 14] },
    ],
  };
  const CLUSTER_COLORS = turnout.labels.map(() => SERIES_1);
  const segments = [
    { n: '1', article: 'Wage survey results', time: '00:52', status: 'Decided ✓', color: SERIES.done },
    { n: '2', article: 'Healthcare costs', time: '00:38', status: 'Open', color: SERIES.active },
    { n: '3', article: 'Scheduling & OT', time: '00:47', status: 'Decided ✓', color: SERIES.done },
    { n: '4', article: 'Health & safety', time: '00:28', status: 'Open', color: SERIES.active },
  ];
  const isActive = (status: string) => status.toLowerCase() === 'active';
  const inReview = dashboard.cases.filter((item) => isActive(item.status) && caseStepInReview(item)).length;
  const activeCases = dashboard.cases.filter((item) => isActive(item.status)).length - inReview;
  const settledCases = dashboard.cases.filter((item) => !isActive(item.status)).length;
  // The chart legend uses the same series hue as its corresponding segment.
  const statusRows = [
    { label: 'Active', value: activeCases },
    { label: 'Needs attention', value: inReview },
    { label: 'Resolved', value: settledCases },
  ].map((row, index) => ({ ...row, color: chartPalette(theme)[index]! }));
  // Four live campaign metrics, not four states: one hue across the band, so the
  // dot is decoration on a tile and never reads as a status the tile does not
  // have (the old four-hue grid is half of the b02b-3 drift).
  const kpis = [
    { c: SERIES_1, label: 'OPEN ISSUES', value: String(metrics.openCases), series: [9, 11, 10, 13, Math.max(1, metrics.openCases)] },
    { c: SERIES_1, label: 'SURVEY RESPONSES', value: '214', series: [80, 120, 150, 180, 214] },
    { c: SERIES_1, label: 'MEETING RSVPS', value: '96', series: [20, 35, 50, 70, 96] },
    { c: SERIES_1, label: 'ACTIONS THIS WEEK', value: String(dashboard.weeklyActions.length), series: [3, 4, 6, 7, Math.max(1, dashboard.weeklyActions.length)] },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: pinned?.contentInset ?? contentStartInset(insets.top), paddingBottom: bottomInset }]}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.ptop}>
          <View>
            <Text {...pulseEcho.hiddenProps} style={styles.ptitle}>Campaign pulse</Text>
            {/* The workspace's own campaign name, never a hard-coded organization or place. */}
            <Text style={styles.psub}>{previewDesk?.chapterName || 'Your campaign'}</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroNumber}>84</Text>
          <Text style={styles.heroStatus}>STRONG</Text>
          <Text style={styles.heroBlurb}>Engagement is up 9 points this month. Survey participation is carrying the score — keep tabling through Friday.</Text>
        </View>

        <View style={styles.segPill} accessibilityRole="tablist">
          {(Object.keys(periods) as PeriodKey[]).map((key) => {
            const selected = key === period;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Show ${periods[key].label.toLowerCase()} data`}
                onPress={() => { void haptics.select(); setPeriod(key); }}
                style={[styles.segButton, selected ? styles.segButtonOn : null]}
              >
                <Text style={[styles.segText, selected ? styles.segTextOn : null]}>{periods[key].label}</Text>
              </Pressable>
            );
          })}
        </View>

        <PulseSection label="PARTICIPATION" />
        <NightCard title={data.caption} meta={`total ${periodTotal}`}>
          <PeriodBarChart
            arrivalKey="pulse:participation"
            values={data.values}
            labels={data.labels}
            accent={SERIES_1}
            grid={NIGHT.grid}
            text={NIGHT.sub}
            selectedIndex={peakIndex}
            selectedColor={NIGHT.ink}
            accessibilityLabel={`${data.caption}: ${periodTotal} total, peaking at ${maxValue} on ${data.labels[peakIndex]}.`}
          />
        </NightCard>

        <View style={styles.kpiGrid}>
          {kpis.map((kpi) => (
            <View key={kpi.label} style={styles.kpiCard}>
              <View style={styles.kpiLabelRow}>
                <View style={[styles.kpiDot, { backgroundColor: kpi.c }]} />
                <Text style={styles.kpiLabel}>{kpi.label}</Text>
              </View>
              <View style={styles.kpiBody}>
                <NumberFlow value={String(kpi.value)} style={styles.kpiValue} />
                <View style={styles.kpiSpark}><SparkBars values={kpi.series} color={kpi.c} height={28} track={NIGHT.track} arrivalKey={`pulse:kpi:${kpi.label}`} /></View>
              </View>
            </View>
          ))}
        </View>

        <NightCard title="Today's organizing rings" meta="26 of 30 actions">
          <View style={styles.ringRow}>
            <ActivityRings
              arrivalKey="pulse:organizing-rings"
              items={ringItems}
              accessibilityLabel={`Organizing rings: ${ringItems.map((ring) => `${ring.label} ${ring.value} of ${ring.goal}`).join(', ')}.`}
            />
            <View style={styles.ringList}>
              {ringItems.map((ring) => (
                <View key={ring.label} style={styles.ringItem}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: ring.color }]} />
                    <Text style={styles.ringLabel}>{ring.label}</Text>
                  </View>
                  <Text style={styles.ringValue}>{ring.value}<Text style={styles.ringGoal}>/{ring.goal}</Text></Text>
                </View>
              ))}
            </View>
          </View>
        </NightCard>

        <NightCard title="Engagement mix" meta="worker actions by channel">
          <StackedAreaChart
            arrivalKey="pulse:engagement-mix"
            layers={engagement.layers}
            labels={engagement.labels}
            text={NIGHT.sub}
            grid={NIGHT.grid}
            line={NIGHT.ink}
            accessibilityLabel={`Engagement mix by channel this week. ${engagement.layers.map((layer) => `${layer.name} ${layer.values.reduce((sum, value) => sum + value, 0)}`).join(', ')}.`}
          />
          <View style={styles.legendInline}>
            {engagement.layers.map((layer) => (
              <LegendSwatch key={layer.name} color={layer.color} label={layer.name} />
            ))}
          </View>
        </NightCard>

        {/* b02b-8, second half: the three issue charts were three equal
            cards, so "how many", "what state" and "about what" each read as an
            unrelated question. They are one card — the flow chart, the state
            breakdown under a hairline, and the campaign's own tags folded in
            beneath both. */}
        <PulseSection label="ISSUES" />
        <NightCard title="Issues" meta={`${dashboard.cases.length} on file · last 8 weeks`}>
          <DualLineChart
            arrivalKey="pulse:casework-flow"
            a={caseFlow.opened}
            b={caseFlow.resolved}
            labels={caseFlow.labels}
            colorA={SERIES_1}
            colorB={SERIES_2}
            text={NIGHT.sub}
            background={NIGHT.card}
            grid={NIGHT.grid}
            accessibilityLabel={`Issues opened versus resolved over eight weeks. Opened: ${caseFlow.opened.join(', ')}. Resolved: ${caseFlow.resolved.join(', ')}.`}
          />
          <View style={styles.legendInline}>
            <LegendRing color={SERIES_1} label="Opened" />
            <LegendRing color={SERIES_2} label="Resolved" />
          </View>
          <CardRule />
          <View style={styles.donutRow}>
            <DonutChart
              arrivalKey="pulse:case-status"
              segments={statusRows.map((row) => ({ value: row.value, color: row.color }))}
              total={dashboard.cases.length}
              label="ISSUES"
              text={NIGHT.ink}
              sub={NIGHT.sub}
              accessibilityLabel={`Issue status donut, ${dashboard.cases.length} issues on file: ${statusRows.map((row) => `${row.label} ${row.value}`).join(', ')}.`}
            />
            <View style={styles.donutLegend}>
              {statusRows.map((row) => (
                <View accessible key={row.label} style={styles.legendRow} accessibilityLabel={`${row.label}: ${row.value}`}>
                  <View style={[styles.legendDot, { backgroundColor: row.color }]} />
                  <Text style={styles.legendLabel}>{row.label}</Text>
                  <NumberFlow decorative value={String(row.value)} style={styles.legendValue} />
                </View>
              ))}
            </View>
          </View>
          <CardRule />
          <Text style={styles.cardMeta}>Issue tags · this quarter</Text>
          <View style={styles.tagWrap}>
            <View style={[styles.tag, styles.tagAdd]}><Text style={styles.tagText}>Campaign-assigned tags</Text></View>
            {caseTags.map(([name, count]) => (
              <View key={name} style={styles.tag}>
                <Text style={styles.tagText}>{name}</Text>
                <View style={styles.tagCount}><Text style={styles.tagCountText}>{count}</Text></View>
              </View>
            ))}
          </View>
        </NightCard>

        <NightCard title="Days to resolve an issue" meta="spotlight · 8 weeks">
          <TrendSpotlight
            arrivalKey="pulse:days-to-resolve"
            values={trendBars}
            bar={SERIES_1}
            line={SERIES_1}
            text={NIGHT.sub}
            grid={NIGHT.grid}
            accessibilityLabel={`Days to resolve an issue over eight weeks: ${trendBars.join(', ')} days — ${trendCopy.spoken}.`}
          />
          <Text style={styles.trendCaps}>{trendCopy.caps}</Text>
          <Text style={styles.footnote}>Average resolution time is {trendDirectionPhrase(trendBars)} over eight weeks{trendCopy.cause}.</Text>
        </NightCard>

        <PulseSection label="CAMPAIGN LIFE" />
        <NightCard title="Meeting turnout" meta="badges = RSVPs">
          <ClusterBadges
            arrivalKey="pulse:meeting-turnout"
            values={turnout.attended}
            badges={turnout.rsvps}
            labels={turnout.labels}
            colors={CLUSTER_COLORS}
            text={NIGHT.sub}
            badgeBg={NIGHT.cream}
            badgeText={NIGHT.badgeInk}
            accessibilityLabel={`Meeting turnout: ${turnout.labels.map((label, index) => `${label} ${turnout.attended[index]} attended of ${turnout.rsvps[index]} RSVPs`).join(', ')}.`}
          />
          <View style={styles.legendInline}>
            <LegendSwatch color={SERIES_1} label="Attended" />
            <LegendRing color={NIGHT.cream} label="RSVPs" />
          </View>
        </NightCard>

        <NightCard title="Meeting night poll" meta={`${pollTotal} votes · live`}>
          <ArrivingBars arrivalKey="pulse:meeting-poll" count={poll.options.length} gap={spacing.sm}>{(grow) => poll.options.map((option, index) => {
            const share = pollPercent[index] ?? 0;
            const mine = poll.mine === index;
            return (
              <View accessible key={option.label} style={styles.pollRow} accessibilityLabel={`${option.label}, ${share} percent, ${option.votes} of ${pollTotal} votes`}>
                <View style={styles.pollTop}>
                  <Text style={styles.pollLabel}>{option.label}{mine ? ' · you' : ''}</Text>
                  <Text style={styles.pollValue}>{share}% · {option.votes}</Text>
                </View>
                <View style={styles.pollTrack}>
                  <View style={[styles.pollFill, { width: `${share}%`, backgroundColor: SERIES_1 }, grow(index)]} />
                </View>
              </View>
            );
          })}</ArrivingBars>
          <Text style={styles.footnote}>Linked to the poll in #meeting-planning — vote there and watch this update.</Text>
        </NightCard>

        <NightCard title="Last committee meeting" meta="Aug 14 · agenda items">
          <View style={styles.statGrid}>
            {/* Four readings of one meeting, so one hue: the dot is the tile's
                accent, not four states the session does not have. */}
            {[['Meeting time', '2:45'], ['Decisions made', '3'], ['Workers attending', '41'], ['Actions logged', '12']].map(([label, value]) => (
              <View key={label as string} style={styles.statCell}>
                <Text style={styles.statLabel}>{label}</Text>
                <View style={styles.statValueRow}>
                  <View style={[styles.kpiDot, { backgroundColor: SERIES.active }]} />
                  <NumberFlow value={String(value)} style={styles.statValue} />
                </View>
              </View>
            ))}
          </View>
          {segments.map((segment) => (
            <View key={segment.n} style={styles.segRow}>
              <Text style={styles.segN}>{segment.n}</Text>
              <Text style={styles.segArticle}>{segment.article}</Text>
              <Text style={styles.segTime}>{segment.time}</Text>
              <View style={[styles.legendDot, { backgroundColor: segment.color }]} />
              <Text style={styles.segStatus}>{segment.status}</Text>
            </View>
          ))}
        </NightCard>

        <PulseSection label="CONTRIBUTORS" />
        <ArrivingBars arrivalKey="pulse:contributors" count={contributors.length} gap={spacing.md}>{(grow) => contributors.map((row, index) => (
          <View accessible key={row.label} style={styles.contribRow} accessibilityLabel={`${row.label}: ${row.status}`}>
            <View style={styles.pollTop}>
              <Text style={styles.contribLabel}>{row.label}</Text>
              <Text style={styles.contribStatus}>{row.status}</Text>
            </View>
            <View style={styles.contribTrack}>
              <View style={[styles.contribFill, { width: `${Math.round(row.share * 100)}%`, backgroundColor: row.color }, grow(index)]} />
            </View>
          </View>
        ))}</ArrivingBars>

        <NativeFeatureGuide feature="pulse" />
      </ScrollView>
      {/* This branch builds its own scroll surface instead of Screen, so it
          mounts the shared top ramp directly. Pulse's night board is the theme
          background, so the ramp's own tint is already the right canvas. The
          native tab host owns the bottom navigation edge. */}
    </SafeAreaView>
  );
}

function createStyles(theme: ThemeTokens) {
  const NIGHT = pulseColors(theme);
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: NIGHT.bg },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md },
  ptop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ptitle: { color: NIGHT.ink, fontSize: 17, lineHeight: 22, ...typeface.heading },
  psub: { color: NIGHT.sub, fontSize: 10.5, lineHeight: 14, ...typeface.heading, letterSpacing: 1, textTransform: 'uppercase' },
  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  heroNumber: { color: NIGHT.ink, fontSize: 92, lineHeight: 96, ...typeface.control, letterSpacing: -2 },
  heroStatus: { color: NIGHT.mint, fontSize: 12, lineHeight: 16, ...typeface.heading, letterSpacing: 4 },
  heroBlurb: { color: NIGHT.sub, textAlign: 'center', maxWidth: 300, fontSize: 13.5, lineHeight: 19 },
  segPill: { flexDirection: 'row', borderRadius: radii.pill, padding: 3, gap: 2, backgroundColor: NIGHT.track },
  segButton: { flex: 1, minHeight: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  segButtonOn: { backgroundColor: NIGHT.card },
  segText: { color: NIGHT.sub, fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  segTextOn: { color: NIGHT.mint },
  card: { backgroundColor: NIGHT.card, borderColor: NIGHT.grid, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { color: NIGHT.ink, fontSize: 16, lineHeight: 21, ...typeface.controlStrong, flexShrink: 1 },
  cardMeta: { color: NIGHT.sub, fontSize: 11.5, lineHeight: 16 },
  cardRule: { height: StyleSheet.hairlineWidth, backgroundColor: NIGHT.grid, marginVertical: spacing.sm },
  ringRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingTop: spacing.xs },
  ringList: { flex: 1, gap: 2 },
  ringItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: NIGHT.grid },
  ringLabel: { color: NIGHT.ink, fontSize: 12.5, lineHeight: 17, ...typeface.control, flexShrink: 1 },
  ringValue: { color: NIGHT.ink, fontSize: 15, lineHeight: 20, ...typeface.heading },
  ringGoal: { color: NIGHT.sub, fontSize: 11, ...typeface.control },
  pledgeLabel: { color: NIGHT.sub, fontSize: 12.5, lineHeight: 17, ...typeface.control, flexShrink: 1 },
  pollRow: { gap: spacing.xs, paddingVertical: spacing.xs },
  pollTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  pollLabel: { color: NIGHT.ink, fontSize: 14, lineHeight: 19, ...typeface.control },
  pollValue: { color: NIGHT.ink, fontSize: 13.5, lineHeight: 18, ...typeface.heading },
  pollTrack: { height: 9, borderRadius: radii.pill, backgroundColor: NIGHT.track, overflow: 'hidden' },
  pollFill: { height: '100%', borderRadius: radii.pill },
  footnote: { color: NIGHT.sub, fontSize: 11.5, lineHeight: 16 },
  trendCaps: { color: NIGHT.mint, fontSize: 11, lineHeight: 15, ...typeface.heading, letterSpacing: 1.4, marginTop: spacing.xs },
  legendInline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  legendSwatch: { width: 11, height: 11, borderRadius: 3 },
  legendRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 3.5 },
  legendText: { color: NIGHT.ink, fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  sectionLabel: { color: NIGHT.sub, fontSize: 11, lineHeight: 15, ...typeface.heading, letterSpacing: 1.4, marginTop: spacing.sm },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  kpiCard: { flexBasis: '47%', flexGrow: 1, backgroundColor: NIGHT.card2, borderRadius: radii.md + 2, padding: spacing.md, gap: spacing.sm },
  kpiLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  kpiDot: { width: 8, height: 8, borderRadius: 4 },
  kpiLabel: { color: NIGHT.ink, fontSize: 10, lineHeight: 14, ...typeface.heading, letterSpacing: 1 },
  kpiBody: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.sm },
  kpiValue: { color: NIGHT.ink, fontSize: 26, lineHeight: 31, ...typeface.heading, letterSpacing: -0.5 },
  kpiSpark: { width: 62 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingTop: spacing.xs },
  donutLegend: { flex: 1 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  legendDot: { width: 11, height: 11, borderRadius: 6 },
  legendLabel: { flex: 1, color: NIGHT.ink, fontSize: 14.5, lineHeight: 20 },
  legendValue: { color: NIGHT.ink, fontSize: 15, lineHeight: 20, ...typeface.heading },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: NIGHT.card2, borderRadius: radii.md, overflow: 'hidden' },
  statCell: { flexBasis: '50%', padding: spacing.md, gap: 2 },
  statLabel: { color: NIGHT.sub, fontSize: 11, lineHeight: 15, ...typeface.control },
  statValueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statValue: { color: NIGHT.ink, fontSize: 20, lineHeight: 25, ...typeface.heading },
  segRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: NIGHT.grid, paddingVertical: spacing.sm },
  segN: { color: NIGHT.sub, width: 16, fontSize: 12.5, lineHeight: 17, ...typeface.control },
  segArticle: { flex: 1, color: NIGHT.ink, fontSize: 13.5, lineHeight: 18, ...typeface.controlStrong },
  segTime: { color: NIGHT.ink, fontSize: 12.5, lineHeight: 17, ...typeface.heading, marginRight: spacing.sm },
  segStatus: { color: NIGHT.ink, fontSize: 12.5, lineHeight: 17, ...typeface.heading },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tag: { flexDirection: 'row', alignItems: 'center', borderRadius: radii.pill, backgroundColor: NIGHT.card2, overflow: 'hidden', minHeight: 36, paddingLeft: spacing.md },
  tagAdd: { backgroundColor: 'transparent', borderWidth: 1, borderColor: NIGHT.sub, paddingRight: spacing.md },
  tagText: { color: NIGHT.ink, fontSize: 12.5, lineHeight: 17, ...typeface.control },
  tagCount: { backgroundColor: NIGHT.track, alignSelf: 'stretch', justifyContent: 'center', paddingHorizontal: spacing.sm, marginLeft: spacing.sm },
  tagCountText: { color: NIGHT.ink, fontSize: 12, lineHeight: 16, ...typeface.heading },
  contribRow: { gap: spacing.xs, paddingVertical: spacing.xs },
  contribLabel: { color: NIGHT.ink, fontSize: 14.5, lineHeight: 20 },
  contribStatus: { color: NIGHT.ink, fontSize: 13, lineHeight: 18, ...typeface.heading },
  contribTrack: { height: 4, borderRadius: radii.pill, backgroundColor: NIGHT.track, overflow: 'hidden' },
  contribFill: { height: '100%', borderRadius: radii.pill },
  });
}
