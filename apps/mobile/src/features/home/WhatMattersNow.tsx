// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: the live Home's one ranked next
// action, the native half of the restored "What matters for you now" card.
// The ranking is the shared web module; this file only gathers the member's
// own inputs and presents the result. The organization switch is member
// visible; while it loads the registered default (on) applies.

import { Ionicons } from '@expo/vector-icons';
import { useNativeUi } from '../../lib/useNativeUi';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading } from '../../components/ui';
import { whatMattersCopy } from '../../lib/whatMattersCopy';
import { useEasternCalendarDay } from '../../lib/useEasternCalendarDay';
import {
  rankWhatMattersNow,
  type WhatMattersBallot,
  type WhatMattersCase,
  type WhatMattersEvent,
  type WhatMattersItem,
  type WhatMattersNotice,
  type WhatMattersSurvey,
  type WhatMattersTask,
} from '../../lib/whatMattersShared';
import { haptics } from '../../services/haptics';
import {
  loadWhatMattersBallots,
  loadWhatMattersEvents,
  loadWhatMattersNotices,
  loadWhatMattersSurveys,
  loadWhatMattersSwitch,
  loadWhatMattersTasks,
} from '../../services/memberHomeAttention';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
type WhatMattersInputs = {
  ballots: WhatMattersBallot[];
  events: WhatMattersEvent[];
  surveys: WhatMattersSurvey[];
  notices: WhatMattersNotice[];
  tasks: WhatMattersTask[];
};
type WhatMattersInput = keyof WhatMattersInputs;
const WHAT_MATTERS_INPUTS: readonly WhatMattersInput[] = ['ballots', 'events', 'surveys', 'notices', 'tasks'];

// One input's last good value and the numbered read it came from.
type WhatMattersSlot<K extends WhatMattersInput> = { value: WhatMattersInputs[K]; request: number } | null;

// The settled reads for one member in one chapter. A different member or
// chapter starts empty, so chapter A's events never rank under chapter B.
// Each input keeps its own last good value: a failed input falls back to it,
// and only a successful value from a later read replaces it.
type WhatMattersRead = { owner: string; request: number } & { [K in WhatMattersInput]: WhatMattersSlot<K> };

type WhatMattersResults = { [K in WhatMattersInput]: PromiseSettledResult<WhatMattersInputs[K]> };

function mergeWhatMattersRead(previous: WhatMattersRead | null, owner: string, request: number, results: WhatMattersResults): WhatMattersRead {
  // A former owner's read that settles after the current owner's has landed
  // is dropped; one that settles first is replaced by the current owner's.
  if (previous && previous.owner !== owner && previous.request > request) return previous;
  const base = previous?.owner === owner ? previous : null;
  const slot = <K extends WhatMattersInput>(key: K): WhatMattersSlot<K> => {
    const kept = base ? base[key] as WhatMattersSlot<K> : null;
    const result = results[key];
    return result.status === 'fulfilled' && (!kept || kept.request < request) ? { value: result.value, request } : kept;
  };
  return {
    owner,
    request: Math.max(request, base?.request ?? 0),
    ballots: slot('ballots'),
    events: slot('events'),
    surveys: slot('surveys'),
    notices: slot('notices'),
    tasks: slot('tasks'),
  };
}

export type WhatMattersStatus = 'loading' | 'failed' | 'ready';
export type WhatMattersRanking = { status: WhatMattersStatus; item: WhatMattersItem | null };

// BUG-UG-NATIVE-HOME-FIRST-RENDER-CAUGHT-UP-BEFORE-ITEMS-LOAD-20261103:
// nothing is ranked until every input read has settled, so a first Home after
// sign-in never says caught up above a survey that is still loading. An input
// that has never been read says it could not check instead of calling the
// member caught up, while whatever the other inputs found still shows.
// 'on' until the member configuration says otherwise.
export function useWhatMattersNow(
  { includePersonalCases = true }: { includePersonalCases?: boolean } = {},
) {
  const { mode, session, dashboard } = useApp();
  const now = useEasternCalendarDay();
  const [enabled, setEnabled] = useState(true);
  const [read, setRead] = useState<WhatMattersRead | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Each read is numbered. A read is never cancelled when the dashboard is
  // replaced (the conversation poll does that every 30 s), so a slow read
  // still lands; mergeWhatMattersRead decides what of it is kept.
  const requested = useRef(0);
  const userID = session?.user.id ?? null;
  const chapterID = dashboard?.member.chapterID ?? null;
  const owner = `${userID ?? ''}:${chapterID ?? ''}`;

  // Re-read on every dashboard refresh (pull to refresh, foreground) so a vote
  // or RSVP made elsewhere stops being the next action. A re-read keeps the
  // last settled result on screen until it settles itself.
  useEffect(() => {
    if (mode !== 'authenticated' || !session?.access_token || !userID || !dashboard) return undefined;
    let active = true;
    void loadWhatMattersSwitch(session).then((value) => { if (active) setEnabled(value); }).catch(() => {});
    const request = ++requested.current;
    void Promise.allSettled([
      loadWhatMattersBallots(),
      loadWhatMattersEvents(userID, chapterID),
      loadWhatMattersSurveys(session),
      loadWhatMattersNotices(userID),
      loadWhatMattersTasks(userID, chapterID),
    ]).then(([ballots, events, surveys, notices, tasks]) => {
      setRead((previous) => mergeWhatMattersRead(previous, owner, request, { ballots, events, surveys, notices, tasks }));
    });
    return () => { active = false; };
  }, [mode, session, userID, chapterID, owner, dashboard, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const settled = read && read.owner === owner ? read : null;
  // Home supplies the takeover's dismissal lookup at render time. Only the
  // ranking changes when a notice is dismissed, and the reads stay settled.
  function rank(isBroadcastDismissed?: (id: string) => boolean): WhatMattersRanking {
    if (!settled) return { status: 'loading', item: null };
    const notices = settled.notices?.value ?? [];
    const item = rankWhatMattersNow({
      cases: includePersonalCases ? dashboard?.cases ?? [] : [],
      ballots: settled.ballots?.value ?? [],
      events: settled.events?.value ?? [],
      surveys: settled.surveys?.value ?? [],
      notices: isBroadcastDismissed ? notices.filter((notice) => !isBroadcastDismissed(notice.id)) : notices,
      tasks: settled.tasks?.value ?? [],
      now,
    });
    // Never caught up while an input has not been read for this member.
    const unread = WHAT_MATTERS_INPUTS.some((key) => settled[key] === null);
    if (unread && item.kind === 'caught_up') return { status: 'failed', item: null };
    return { status: 'ready', item };
  }
  return { enabled, now, retry, rank };
}

// The section before the ranking can be trusted: a neutral loading line, or an
// honest could-not-check line with a retry. Neither says caught up.
function WhatMattersNowPending({ status, onRetry }: { status: Exclude<WhatMattersStatus, 'ready'>; onRetry: () => void }) {
  const { t } = useNativeUi();
  const theme = useTheme();
  const failed = status === 'failed';
  const line = failed ? t('Could not check what needs your attention') : t('Checking what needs your attention…');
  return (
    <View style={styles.section}>
      <Heading level={2}>{t('What matters for you now')}</Heading>
      <Card hero style={[styles.card, { borderLeftColor: failed ? theme.accent : theme.border }]}>
        <View accessible accessibilityLabel={line} accessibilityLiveRegion="polite">
          <Body muted={!failed}>{line}</Body>
          {failed ? <Body muted>{t('Your open tasks, votes, meetings, surveys and notices could not be read. Retry to check again.')}</Body> : null}
        </View>
        {failed ? <Button label={t('Retry')} variant="secondary" onPress={onRetry} /> : null}
      </Card>
    </View>
  );
}

export function WhatMattersNowSection({ item, status, onRetry, hasPersonalItems = false }: WhatMattersRanking & {
  onRetry: () => void;
  hasPersonalItems?: boolean;
}) {
  const { t } = useNativeUi();
  if (status !== 'ready' || !item) return <WhatMattersNowPending status={status === 'failed' ? 'failed' : 'loading'} onRetry={onRetry} />;
  return (
    <View style={styles.section}>
      <Heading level={2}>{t('What matters for you now')}</Heading>
      {hasPersonalItems && item.kind === 'caught_up'
        ? <Body muted>{t('Nothing else needs your attention right now.')}</Body>
        : <WhatMattersItemCard item={item} hero />}
    </View>
  );
}

export function createPersonalCaseCards(cases: readonly WhatMattersCase[], now: Date) {
  const inputs = { ballots: [], events: [], now };
  let hasAlert = false;
  // Keep each member case's action available even while unrelated Home reads load.
  const entries = cases.flatMap((memberCase) => {
    const item = rankWhatMattersNow({ ...inputs, cases: [memberCase] });
    if (!('case' in item)) return [];
    hasAlert ||= item.kind !== 'case_in_progress' || item.deadline !== null;
    // A procedure deadline can win the ranking while a separate statutory
    // filing window on the same case still needs attention.
    // Union Ground has no statutory (ULP) deadline beside an issue's own date.
    const firstDate = item.deadline;
    const card = (
      <View key={memberCase.id} style={styles.section}>
        <Body>{memberCase.title || memberCase.reference}</Body>
        <WhatMattersItemCard item={item} />
      </View>
    );
    return [{ card, firstDate }];
  });
  // Put each case at its earliest displayed due date. Equal and undated
  // entries keep their input order.
  entries.sort((left, right) => {
    if (left.firstDate === right.firstDate) return 0;
    if (!left.firstDate) return 1;
    if (!right.firstDate) return -1;
    return left.firstDate.localeCompare(right.firstDate);
  });
  return { cards: entries.map(({ card }) => card), hasAlert };
}

function WhatMattersItemCard({ item, hero }: { item: WhatMattersItem; hero?: boolean }) {
  const { language, locale } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const copy = whatMattersCopy(item, language);
  const accent = item.urgency === 'critical' ? theme.destructive : item.urgency === 'warning' ? theme.accent : theme.primary;
  const icon = item.kind === 'caught_up' ? 'checkmark-circle-outline'
    : item.kind === 'open_vote' ? 'checkbox-outline'
      : item.kind === 'rsvp' ? 'calendar-outline'
        : item.kind === 'case_in_progress' ? 'briefcase-outline'
          : item.kind === 'assigned_task' ? 'list-outline'
            : item.kind === 'open_survey' ? 'clipboard-outline'
              : item.kind === 'unread_notice' ? 'megaphone-outline'
                : 'alert-circle-outline';
  const href = copy.href;
  return (
    <Card hero={hero} style={[styles.card, { borderLeftColor: accent }]}>
      <View style={styles.head}>
        <Ionicons name={icon} size={18} color={accent} accessibilityElementsHidden />
        <Text style={[styles.reason, { color: theme.mutedForeground }]}>{copy.reason.toLocaleUpperCase(locale)}</Text>
      </View>
      <Heading level={3} fitWords>{copy.line}</Heading>
      {copy.meta ? <Body muted>{copy.meta}</Body> : null}
      {href && copy.action ? <Button label={copy.action} onPress={() => { void haptics.select(); router.push(href as never); }} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  card: { gap: spacing.xs, borderLeftWidth: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  reason: { flex: 1, fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 0.8 },
});
