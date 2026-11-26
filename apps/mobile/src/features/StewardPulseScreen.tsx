import { useNativeUi } from '../lib/useNativeUi';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { PulseCatalogCard, PulseExpandSheet } from '../components/PulseCatalog';
import { useNativeTabContentInset } from '../lib/chrome';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { nextStewardDeadline, pulseDeadlineLabel, pulseTier, pulseUpdated, type PulseCard, type PulsePeople } from '../lib/pulseCatalog';
import { loadPulsePeople, loadStewardPulse, type StewardPulse } from '../services/stewardPulse';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { pulsePalette } from '../theme/pulsePalette';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { SavedChartSlot } from './SavedPulseCharts';
import { usePulseOpening } from './PulseOpeningPreference';

import { typeface } from '../theme/typeface';
export default function StewardPulseScreen() {
  const { mode, session, organizationID, dashboard } = useApp();
  // Every authorization boundary remounts all data, sheets and requests.
  return <StewardPulseContent key={`${mode}:${session?.user.id}:${organizationID}:${dashboard?.member.chapterID}`} />;
}

function StewardPulseContent() {
  const { catalogLabel } = useNativeUi();
  const { mode, session, dashboard, sessionRestricted } = useApp();
  const router = useRouter();
  const bottomInset = useNativeTabContentInset();
  const [data, setData] = useState<StewardPulse | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<'all' | PulseCard['category']>('all');
  const [expanded, setExpanded] = useState<PulseCard | null>(null);
  const [showWeek, setShowWeek] = useState(false);
  const preference = usePulseOpening();

  useFocusEffect(useCallback(() => {
    if (mode !== 'authenticated' || !session || sessionRestricted) return;
    // The screen's scope and the read have separate signals, so a read that
    // passed its deadline is stopped without hiding the failure it shows (#8769).
    const controller = new AbortController(), read = new AbortController();
    setRefreshing(true); setFailed(false); setData(null); setExpanded(null); setShowWeek(false);
    void withReadDeadline(loadStewardPulse(session.user.id, read.signal)).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((error: unknown) => { if (error instanceof ReadDeadlineError) read.abort(); if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => { controller.abort(); read.abort(); setExpanded(null); };
  }, [attempt, mode, session, sessionRestricted]));

  const due = data ? nextStewardDeadline(data.cases, data.deadlines, data.updatedAt.getTime()) : null;
  const weekVisible = preference.failed || preference.value?.opening !== 'charts' || showWeek;
  return <Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => setAttempt((value) => value + 1)}>
    <Heading>{catalogLabel('Pulse')}</Heading>
    <Body muted>Committee · {dashboard?.member.chapterID ? 'your campaign' : 'your campaigns'}</Body>
    {data ? <Body muted>{pulseUpdated(data.updatedAt)}</Body> : null}
    {mode === 'preview' ? <StateMessage title="No preview records" body="Pulse will chart the issues and worker records in this preview workspace. No figures are invented." /> : null}
    {failed ? <StateMessage title="Pulse could not load" body="Your figures didn’t load. Refresh to try again." action={<Button label="Try again" onPress={() => setAttempt((value) => value + 1)} />} /> : null}
    {!data && refreshing ? <Body muted>Loading your figures…</Body> : null}
    {data ? <>
      <SavedChartSlot position="pinned" />
      {preference.failed ? <Body muted>Your opening choice could not be checked. This week is shown first.</Body> : null}
      {!preference.failed && preference.value?.opening === 'charts' ? <Button label={showWeek ? 'Hide This week' : 'Show This week'} variant="secondary" onPress={() => setShowWeek(value => !value)} /> : null}
      {weekVisible ? <Card>
        <Heading level={2}>This week</Heading>
        {!data.deadlinesAvailable ? <Body>Some deadlines could not be checked. Open Issue work to review the complete queue.</Body> : due ? <>
          <Heading level={3}>{due.item.reference} · {due.item.title}</Heading>
          <Body>{due.label} · {pulseDeadlineLabel(due.dueAt)}</Body>
        </> : <Body>No recorded issue deadline is due in the next seven days. Your queues are below.</Body>}
        {due && data.deadlinesAvailable ? <Button label={`Open ${due.item.reference}`} onPress={() => router.push(`/issue/${due.item.id}`)} />
          : <Button label="Open Issue work" variant="secondary" onPress={() => router.push('/feature/steward')} />}
      </Card> : null}
      <PulsePills values={['all', 'chapter', 'cases', 'meetings']} selected={filter} onSelect={setFilter} />
      {data.cards.filter((card) => filter === 'all' || card.category === filter).map((card) => <PulseCatalogCard key={card.id} card={card} onOpen={() => setExpanded(card)} />)}
      <StewardPeople />
      <SavedChartSlot position="catalogue" />
      <PulseExpandSheet key={expanded?.id ?? 'closed'} card={expanded} onClose={() => setExpanded(null)} />
    </> : null}
  </Screen>;
}

export function PulsePills<T extends string>({ values, selected, onSelect }: { values: readonly T[]; selected: T; onSelect: (value: T) => void }) {
  const theme = useTheme();
  return <View style={styles.pills} accessibilityRole="radiogroup">
    {values.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={value === 'steward' ? 'Your workers' : value} accessibilityState={{ selected: value === selected, checked: value === selected }} onPress={() => onSelect(value)} style={({ pressed }) => [styles.pill, { backgroundColor: value === selected ? theme.primary : theme.card, borderColor: theme.border, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
      <Text style={{ color: value === selected ? theme.primaryForeground : theme.foreground, ...typeface.control }}>{value === 'steward' ? 'Your workers' : value[0]!.toUpperCase() + value.slice(1)}</Text>
    </Pressable>)}
  </View>;
}

function StewardPeople() {
  const theme = useTheme();
  const colors = pulsePalette(theme);
  const [level, setLevel] = useState<PulsePeople['level']>('steward');
  const [people, setPeople] = useState<PulsePeople | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    setPeople(null); setFailed(false); setPage(0);
    void withReadDeadline(loadPulsePeople(level, controller.signal)).then((result) => { if (!controller.signal.aborted) setPeople(result); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt, level]));
  const current = people?.level === level ? people : null;
  const members = current?.members.slice(page * 25, (page + 1) * 25) ?? [];
  return <Card>
    <Heading level={2}>People</Heading>
    <PulsePills values={['steward', 'chapter', 'local']} selected={level} onSelect={setLevel} />
    <Body muted>Counted from protected activities, profile readiness and follow-through for the workers you represent. Page views and product analytics are excluded.</Body>
    <View style={styles.pills}>{[0, 25, 45, 65, 85].map((score) => {
      const tier = pulseTier(score);
      return <View key={score} style={styles.band}><View style={[styles.dot, { backgroundColor: colors.tiers[tier.index] }]} /><Body muted>{tier.label}</Body></View>;
    })}</View>
    <Body muted>Critical 0–24 · Concerning 25–44 · Moderate 45–64 · Healthy 65–84 · Excellent 85–100</Body>
    {failed ? <StateMessage title="People could not load" body="Your worker list didn’t load." action={<Button label="Retry People" variant="secondary" onPress={() => setAttempt((value) => value + 1)} />} /> : null}
    {!current && !failed ? <Body muted>Loading People…</Body> : null}
    {current?.level === 'steward' ? <>
      {!current.members.length ? <Body>No workers to show for the committee role right now.</Body> : null}
      {members.map((person) => {
        const tier = pulseTier(person.score);
        return <View key={person.id} style={[styles.person, { borderColor: theme.border }]}>
          <Heading level={3}>{person.name}</Heading>
          <View style={styles.band}>
            {tier.index >= 0 && !person.scoreHidden ? <View style={[styles.dot, { backgroundColor: colors.tiers[tier.index] }]} /> : null}
            <Body>{person.scoreHidden ? 'Score hidden' : person.score === null ? tier.label : `${person.score} · ${tier.label}`}</Body>
          </View>
          {!person.scoreHidden ? <Body muted>{person.lastActivity ? `Last activity ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(person.lastActivity))}` : 'No protected activity recorded in the past 180 days.'}</Body> : null}
        </View>;
      })}
      {page > 0 ? <Button label="Previous workers" variant="secondary" onPress={() => setPage((value) => value - 1)} /> : null}
      {(page + 1) * 25 < current.members.length ? <Button label="Next workers" variant="secondary" onPress={() => setPage((value) => value + 1)} /> : null}
      <Body muted>Only workers you can see as a committee member. A worker can hide their score in Settings. People cannot be shared or exported.</Body>
    </> : current ? <>
      {!current.groups.length ? <Body>No groups to show for the committee role right now.</Body> : null}
      {current.groups.map((group) => <View key={group.id} style={[styles.person, { borderColor: theme.border }]}>
        <Heading level={3}>{group.name}</Heading>
        <Body>{group.withheld ? 'Withheld · group too small to share safely' : `${group.count} workers`}</Body>
        {!group.withheld ? <Body muted>{group.score === null ? 'Score withheld · not enough visible scores to share safely' : `${group.score} · ${pulseTier(group.score).label}`}</Body> : null}
      </View>)}
      <Body muted>Only groups you can see. No names are shown at campaign or local level. Groups that do not meet the organization's privacy minimum are withheld.</Body>
    </> : null}
  </Card>;
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { minHeight: minimumTouchTarget, paddingHorizontal: spacing.md, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center' },
  person: { paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, gap: spacing.xs },
  band: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
