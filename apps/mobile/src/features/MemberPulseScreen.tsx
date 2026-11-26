import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { PressableScale } from '../components/PressableScale';
import { PulseCatalogCard, PulseExpandSheet } from '../components/PulseCatalog';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { useChannelStore } from '../data/useChannels';
import { useNativeTabContentInset } from '../lib/chrome';
import { memberPollCard } from '../lib/memberPulse';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { pulseUpdated, type PulseCard } from '../lib/pulseCatalog';
import { MEMBER_SURVEYS_HREF, whatMattersCopy } from '../lib/whatMattersCopy';
import { useEasternCalendarDay } from '../lib/useEasternCalendarDay';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { easternDay } from '../lib/easternTime';
import { loadMemberPulse, type MemberPulse } from '../services/memberPulse';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { NativeFeatureGuide } from './guideLayers/GuideLayers';
import { usePulseOpening } from './PulseOpeningPreference';
import { SavedChartSlot, useSavedPulseChartCount } from './SavedPulseCharts';
import { usePulseHistory } from './usePulseHistory';

import { typeface } from '../theme/typeface';
// Saved charts join this catalogue in #6692; no empty Your charts control.
// The filters are the Pulse design's Mock A (#8926): Voice holds the chapter poll.
const FILTERS: readonly { id: string; label: NativeUiKey }[] = [
  { id: 'all', label: 'All' }, { id: 'chapter', label: 'Campaign' }, { id: 'cases', label: 'Issues' },
  { id: 'meetings', label: 'Meetings' }, { id: 'voice', label: 'Voice' },
];
const YOUR_CHARTS: { id: string; label: NativeUiKey } = { id: 'your charts', label: 'Your charts' };

export default function MemberPulseScreen({ customCards = [] }: { customCards?: PulseCard[] }) {
  const { mode, session, organizationID, dashboard } = useApp();
  return <MemberPulseContent key={`${mode}:${session?.user.id}:${organizationID}:${dashboard?.member.chapterID}`} customCards={customCards} />;
}

function MemberPulseContent({ customCards }: { customCards: PulseCard[] }) {
  const { mode, session, dashboard, refresh, error } = useApp();
  const day = easternDay(useEasternCalendarDay());
  const preference = usePulseOpening();
  const hasSavedCharts = useSavedPulseChartCount() > 0 || customCards.length > 0;
  const theme = useTheme();
  const { language, t } = useNativeUi();
  const router = useRouter();
  const bottomInset = useNativeTabContentInset();
  const store = useChannelStore();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [data, setData] = useState<MemberPulse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState('all');
  const [expandedID, setExpanded] = useState<string | null>(null);
  const [showWeek, setShowWeek] = useState(false);
  const [allWeek, setAllWeek] = useState(false);
  const history = usePulseHistory('member', attempt);
  // BUG-UG-MEMBER-PULSE-RESETS-ON-CONVERSATION-POLL-20261102: the
  // conversation poll republishes the dashboard every 30 s with only its
  // conversations replaced. Pulse reads the member, cases and weekly actions,
  // so only those (or a retry) reload it; the latest dashboard is read here.
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;
  const member = dashboard?.member, dashboardCases = dashboard?.cases, weeklyActions = dashboard?.weeklyActions;
  useFocusEffect(useCallback(() => {
    const dashboard = dashboardRef.current;
    if (mode !== 'authenticated' || !session || !dashboard) return;
    // The screen's scope and the read have separate signals, so a read that
    // passed its deadline is stopped without hiding the failure it shows (#8769).
    const controller = new AbortController(), read = new AbortController();
    setData(null); setExpanded(null); setFailed(false); setBusy(true); setShowWeek(false); setAllWeek(false);
    void withReadDeadline(loadMemberPulse(session, dashboard, read.signal, language)).then((next) => { if (!controller.signal.aborted) setData(next); })
      .catch((error: unknown) => { if (error instanceof ReadDeadlineError) read.abort(); if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); read.abort(); setExpanded(null); };
  }, [mode, session, member, dashboardCases, weeklyActions, attempt, day, language]));
  const weekFirst = preference.value?.opening !== 'charts';
  const next = data?.next ? whatMattersCopy(data.next, language) : null;
  const cards = data ? [...data.cards, ...history.cards, memberPollCard(store.poll(), store.status(), language), ...customCards] : [];
  // This week (Mock A): one gold action for the most urgent item and See all
  // with the week's items, counted from the same ranking inputs the card lists:
  // the headline, each open survey and the unread notices. A headline that is
  // itself a survey or a notice is already counted in those.
  const kind = data?.next?.kind;
  const weekCount = (data?.surveys.length ?? 0) + (data?.notice ? 1 : 0)
    + (next?.action && kind !== 'open_survey' && kind !== 'unread_notice' ? 1 : 0);
  const surveyLine = data?.surveys.length ? t(data.surveys.length === 1 ? '{count} survey to answer · {title}' : '{count} surveys to answer · {title}', { count: data.surveys.length, title: data.surveys[0]! }) : null;
  const noticeLine = data?.notice ? t(data.notice.unread === 1 ? (data.notice.limited ? '{count} unread notice among your latest twenty · {title}' : '{count} unread notice · {title}') : (data.notice.limited ? '{count} unread notices among your latest twenty · {title}' : '{count} unread notices · {title}'), { count: data.notice.unread, title: data.notice.title }) : null;
  const filters = hasSavedCharts ? [...FILTERS, YOUR_CHARTS] : FILTERS;
  const pollChannel = store.channels().find((channel) => channel.messages.some((message) => message.poll));
  const retry = () => { setAttempt((value) => value + 1); void refresh('user-refresh'); void store.refresh(); };
  return <Screen tabRoot bottomInset={bottomInset} refreshing={busy} onRefresh={retry}>
    <Heading>{t('Pulse')}</Heading>
    <Body muted>{t('Your campaign and your own participation')}</Body>
    {data ? <Body muted>{pulseUpdated(data.updatedAt)}</Body> : null}
    {mode === 'preview' ? <StateMessage title="No preview records" body="This catalogue uses the signed-in workspace’s recorded figures. No statistics are invented for the preview." /> : null}
    {mode === 'authenticated' && !dashboard ? <StateMessage title={t('Pulse is getting ready')} body={t('Your worker records have not loaded yet.')} action={<Button label={t('Retry worker records')} onPress={retry} />} /> : null}
    {error ? <Body muted>{t('Some workspace records may be out of date. Refresh to recheck them.')}</Body> : null}
    {failed ? <StateMessage title={t('Pulse could not load')} body={t('Your figures didn’t load. Refresh to try again.')} action={<Button label={t('Retry Pulse')} onPress={retry} />} /> : null}
    {!data && busy ? <Body muted>{t('Loading your figures…')}</Body> : null}
    {preference.failed ? <StateMessage title={t('Opening choice unavailable')} body={t('This week is shown first until your saved choice can be checked.')} action={<Button label={t('Retry opening choice')} onPress={preference.retry} variant="secondary" />} /> : null}
    {data ? <>
      <SavedChartSlot position="pinned" />
      {!weekFirst ? <Button label={showWeek ? t('Hide This week') : t('Show This week')} variant="secondary" onPress={() => setShowWeek((value) => !value)} /> : null}
      {weekFirst || showWeek ? <Card>
        <Text accessibilityRole="header" style={[styles.kicker, { color: theme.mutedForeground }]}>{t('This week')}</Text>
        {!data.nextAvailable ? <><Body>{t('Your next action didn’t load. Try again before treating the week as caught up.')}</Body><Button label={t('Retry next action')} onPress={retry} /></> : next ? <>
          <Text style={[styles.weekLine, { color: theme.foreground }]}>{next.line}</Text>
          {next.meta ? <Body muted>{next.meta}</Body> : null}
        </> : <Body>{t('No action is due from your recorded issues, votes and meetings.')}</Body>}
        {(data.nextAvailable && next?.href && next.action) || weekCount > 1 ? <View style={styles.weekActions}>
          {data.nextAvailable && next?.href && next.action ? <WeekAction gold label={next.action} onPress={() => router.push(next.href as never)} /> : null}
          {weekCount > 1 ? <WeekAction label={allWeek ? t('Show fewer') : t('See all {count}', { count: weekCount })} expanded={allWeek} onPress={() => setAllWeek((value) => !value)} /> : null}
        </View> : null}
        {/* Folded, the week's other items are a short list; See all opens each one's action. */}
        {surveyLine ? <WeekItem line={surveyLine}>{allWeek || weekCount <= 1 ? <Button label={t('Open surveys')} variant="secondary" onPress={() => router.push(MEMBER_SURVEYS_HREF)} /> : null}</WeekItem> : null}
        {noticeLine ? <WeekItem line={noticeLine}>{allWeek || weekCount <= 1 ? <Button label={t('Open notices')} variant="secondary" onPress={() => router.push('/messages')} /> : null}</WeekItem> : null}
      </Card> : null}
      <View style={styles.pills} accessibilityRole="radiogroup">
        {filters.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={t(item.label)}
          accessibilityState={{ checked: filter === item.id }} onPress={() => setFilter(item.id)}
          style={[styles.pill, { backgroundColor: filter === item.id ? theme.primary : theme.card, borderColor: filter === item.id ? theme.primary : theme.border }]}>
          <Text style={[styles.pillText, { color: filter === item.id ? theme.primaryForeground : theme.foreground }]}>{t(item.label)}</Text>
        </Pressable>)}
      </View>
      {history.failed ? <Body muted>{t('Weekly history didn’t load. Refresh to try again.')}</Body> : null}
      {data.statisticsLocked ? <Button label={t('Complete the quarterly survey')} variant="secondary" onPress={() => router.push(MEMBER_SURVEYS_HREF)} /> : null}
      {cards.filter((card) => filter === 'all' || (filter === 'your charts' ? customCards.includes(card) : card.category === filter)).map((card) => <PulseCatalogCard key={card.id} card={card} onOpen={() => setExpanded(card.id)} />)}
      <PulseExpandSheet key={expandedID ?? 'closed'} card={cards.find((card) => card.id === expandedID) ?? null} onClose={() => setExpanded(null)} />
      {store.poll() ? <Button label={t('Open campaign poll')} variant="secondary" onPress={() => router.push(pollChannel ? `/channel/${pollChannel.id}` : '/messages')} /> : null}
      {filter === 'all' || filter === 'your charts' ? <SavedChartSlot position="catalogue" /> : null}
      <Button label={t('Refresh Pulse')} variant="secondary" onPress={retry} />
    </> : null}
    {/* Optional help follows the working content, including at large text sizes. */}
    <NativeFeatureGuide feature="pulse" />
  </Screen>;
}

/** This week's two actions (Mock A): the one gold action on the screen, and quiet ones. */
function WeekAction({ label, onPress, gold = false, expanded }: { label: string; onPress: () => void; gold?: boolean; expanded?: boolean }) {
  const theme = useTheme();
  return <PressableScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={expanded === undefined ? undefined : { expanded }} onPress={onPress}
    testID={gold ? 'pulse-week-gold-action' : undefined} resting={elevation.level1} pressedOpacity={0.82}
    style={[styles.weekAction, { backgroundColor: gold ? theme.accent : theme.secondary }]}>
    <Text style={[styles.weekActionText, { color: gold ? theme.accentForeground : theme.secondaryForeground }]}>{label}</Text>
  </PressableScale>;
}

function WeekItem({ line, children }: { line: string; children?: ReactNode }) {
  const theme = useTheme();
  return <View style={styles.weekItem}>
    <View style={styles.weekItemLine}><View style={[styles.dot, { backgroundColor: theme.mutedForeground }]} /><Text style={[styles.weekItemText, { color: theme.mutedForeground }]}>{line}</Text></View>
    {children}
  </View>;
}

const styles = StyleSheet.create({
  kicker: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 1, textTransform: 'uppercase' },
  weekLine: { fontSize: 18, lineHeight: 24, ...typeface.control },
  weekActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  weekAction: { minHeight: minimumTouchTarget, borderRadius: radii.sm + 4, paddingHorizontal: 18, justifyContent: 'center', alignItems: 'center' },
  weekActionText: { fontSize: 16, lineHeight: 20, ...typeface.controlStrong, textAlign: 'center' },
  weekItem: { gap: spacing.sm },
  weekItemLine: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 8 },
  weekItemText: { flex: 1, fontSize: 14, lineHeight: 20 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { minHeight: minimumTouchTarget, paddingHorizontal: spacing.lg, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center' },
  pillText: { fontSize: 16, lineHeight: 20, ...typeface.control },
});
