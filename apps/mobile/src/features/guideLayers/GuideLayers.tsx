import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../../lib/businessWriteContinuation';
import { useNativeUi } from '../../lib/useNativeUi';
import { useBusinessRequests, useBusinessWriter, useBusinessState, useBusinessOperation } from '../../lib/useBusinessWriter';
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029 (native).
//
// The phone's feature guide card (R36), coach mark (R26) and org-start guide
// (R35), each decided by the shared pure rules and shown only while its
// organization switch is on (all three default on). Nothing here is a modal:
// cards sit inline with a screen, the coach mark under its control,
// and none moves focus.

import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { coachMarkDecision, memberFeatureGuides } from '../../../../../src/features/onboardingGuideEngine/memberLayers.js';
import { orgStartGuide } from '../../../../../src/features/onboardingGuideEngine/orgStart.js';
import { Body, Button, Card, Heading, Notice } from '../../components/ui';
import { haptics } from '../../services/haptics';
import { useNativeFeatureFlag } from '../../services/nativeFeatureFlag';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import {
  GUIDE_SWITCHES_OFF,
  NO_FEATURE_MARKS,
  acknowledgeOrganizationStartCelebration,
  coachMarkShownThisSession,
  createGuideText,
  guideText,
  loadFeatureMarks,
  loadGuideSwitches,
  loadOrganizationStartGuide,
  noteCoachMarkShown,
  readCoachSeen,
  recordFeatureMark,
  reviewOrganizationStartSwitches,
  saveOrganizationStartContacts,
  subscribeFeatureMarks,
  withFeatureMark,
  writeCoachSeen,
  type FeatureMarkKind,
  type FeatureMarks,
  type GuideCopy,
  type GuideSwitches,
} from './guideLayersData';

import { typeface } from '../../theme/typeface';
/** The guidance switches for a live session, re-read when the screen gains focus. */
export function useGuideSwitches(): GuideSwitches {
  const { mode, session } = useApp();
  const focused = useIsFocused();
  const [state, setState] = useState<{ session: unknown; switches: GuideSwitches } | null>(null);
  useEffect(() => {
    if (mode !== 'authenticated' || !session || !focused) return undefined;
    let live = true;
    loadGuideSwitches().then((switches) => { if (live) setState({ session, switches }); }).catch(() => { if (live) setState({ session, switches: GUIDE_SWITCHES_OFF }); });
    return () => { live = false; };
  }, [mode, session, focused]);
  return mode === 'authenticated' && state?.session === session ? state.switches : GUIDE_SWITCHES_OFF;
}

// The stored marks for this user. Nothing is shown or recorded until the
// stored record has loaded, so a first render can never overwrite it. Marks go
// through the shared store (recordFeatureMark), and every mounted guide takes
// the merged record it reports, so a guide kept mounted on another tab never
// writes back a stale copy.
function useFeatureMarks(userId: string | null, on: boolean) {
  const [state, setState] = useState<{ userId: string | null; marks: FeatureMarks }>({ userId: null, marks: NO_FEATURE_MARKS });
  // This guide's own marks still in the queue. While any is, a record reported
  // for an earlier mark would hide the later one, so it waits for its own.
  const pending = useRef(0);
  useEffect(() => {
    if (!on || !userId) return undefined;
    let live = true;
    const stop = subscribeFeatureMarks((who, marks) => { if (live && who === userId && pending.current === 0) setState({ userId, marks }); });
    void loadFeatureMarks(userId).then((stored) => { if (live) setState({ userId, marks: stored }); });
    return () => { live = false; stop(); };
  }, [userId, on]);
  const loaded = on && Boolean(userId) && state.userId === userId;
  const mark = useCallback((kind: FeatureMarkKind, feature: string) => {
    if (!on || !userId || !loaded) return;
    const now = Date.now();
    // The card answers at once; the stored record follows in its turn.
    setState((current) => current.userId === userId ? { userId, marks: withFeatureMark(current.marks, kind, feature, now) } : current);
    pending.current += 1;
    void recordFeatureMark(userId, kind, feature, now).finally(() => { pending.current -= 1; }).then((stored) => {
      if (stored && pending.current === 0) setState((current) => current.userId === userId ? { userId, marks: stored } : current);
    });
  }, [on, userId, loaded]);
  return { marks: loaded ? state.marks : NO_FEATURE_MARKS, loaded, mark };
}

export function isMemberOnly(...roleSets: (readonly string[] | null | undefined)[]): boolean {
  return roleSets.every((roles) => (roles ?? []).length === 0);
}

const FEATURE_VIEWS: Record<string, string> = {
  home: 'today',
  'member-support': 'memberSupport',
  rights: 'rights',
  events: 'events',
  messages: 'messages',
  pulse: 'voice',
  ballots: 'voting',
  settings: 'settings',
};

// The phone's own names for these screens (the shared rules name the web's
// navigation lines, which the native app does not carry).
export const NATIVE_FEATURE_NAMES: Record<string, string> = {
  home: 'Home',
  'member-support': 'Worker support',
  rights: 'Organizing rights',
  events: 'Meetings',
  messages: 'Messages',
  pulse: 'Campaign pulse',
  ballots: 'Votes',
  settings: 'Account',
};

/**
 * The feature guide card for one member feature, shown the first time the
 * member reaches it. Its first-action button finishes the guide for the two
 * guides whose first action is looking; Got it closes it.
 */
export function NativeFeatureGuide({ feature, stewardName = null, onShowing }: { feature: keyof typeof FEATURE_VIEWS; stewardName?: string | null; onShowing?: (showing: boolean) => void }) {
  const theme = useTheme();
  const { catalogLabel } = useNativeUi();
  const { mode, session, organizationRoles, chapterRoles, authorizedRoles } = useApp();
  const switches = useGuideSwitches();
  const userId = mode === 'authenticated' ? session?.user.id ?? null : null;
  const { marks, loaded, mark } = useFeatureMarks(userId, switches.featureGuides);
  const guides = memberFeatureGuides({
    on: switches.featureGuides && loaded,
    memberHat: true,
    // Any staff role, at organization or chapter scope, is not member only
    // (the web's memberOnlyAccount reads every role the same way).
    memberOnly: isMemberOnly(organizationRoles, chapterRoles, authorizedRoles),
    view: FEATURE_VIEWS[feature] ?? null,
    stewardName,
    marks,
  });
  const item = guides.view?.showing ?? null;
  const showingAs = guides.view?.showingAs ?? null;
  const seenFeature = item && showingAs === 'first' ? item.feature : null;
  useEffect(() => { if (seenFeature) mark('seen', seenFeature); }, [seenFeature, mark]);
  const showing = Boolean(item);
  useEffect(() => { onShowing?.(showing); }, [showing, onShowing]);
  const renderLine = createGuideText(catalogLabel);
  const featureName = item ? NATIVE_FEATURE_NAMES[item.feature] : null;
  const title = featureName ? catalogLabel(featureName) : renderLine(item?.title);
  const announcement = title ? renderLine({ key: 'guideEngine.fg.announce', params: { feature: title } }) : '';
  useEffect(() => { if (announcement) AccessibilityInfo.announceForAccessibility?.(announcement); }, [announcement]);
  if (!item) return null;
  const doneBefore = item.doneBeforeOpened && showingAs === 'first';
  return (
    <Card>
      <View style={styles.eyebrowRow}>
        <Text style={[styles.eyebrow, { color: theme.mutedForeground }]}>{(doneBefore ? renderLine({ key: 'guideEngine.fg.doneBeforeOpened' }) : renderLine({ key: 'guideEngine.fg.about', params: { feature: title } })).toUpperCase()}</Text>
        {item.optional ? <View style={[styles.chip, { backgroundColor: theme.secondary }]}><Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{renderLine({ key: 'guideEngine.fg.optional' })}</Text></View> : null}
      </View>
      <Heading level={2}>{title}</Heading>
      <GuideGroup heading={renderLine({ key: 'guideEngine.fg.youCan' })} lines={item.canDo.map(renderLine)} />
      <GuideGroup heading={renderLine({ key: 'guideEngine.fg.never' })} lines={item.neverDo.map(renderLine)} />
      {item.askWho ? <GuideGroup heading={renderLine({ key: 'guideEngine.fg.askHeading' })} lines={[renderLine({ key: 'guideEngine.fg.askLine', params: { who: item.askWho } })]} /> : null}
      <View style={styles.actions}>
        {!item.done && item.doneOnPrimary ? <Button fitWords variant="secondary" label={renderLine(item.firstLabel)} onPress={() => { void haptics.select(); mark('acted', item.feature); mark('got', item.feature); }} /> : null}
        <Button variant="secondary" label={renderLine({ key: 'guideEngine.fg.gotIt' })} onPress={() => { void haptics.select(); mark('got', item.feature); }} />
      </View>
    </Card>
  );
}

function GuideGroup({ heading, lines }: { heading: string; lines: string[] }) {
  const theme = useTheme();
  if (!lines.length) return null;
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.groupHeading, { color: theme.cardForeground }]}>{heading}</Text>
      {lines.map((line) => <Body key={line} fitWords>{`• ${line}`}</Body>)}
    </View>
  );
}

const COACH_WAIT_MS = 10_000;

/**
 * The coach mark under the onboarding card's next-step control: at most one
 * per session, never in the first ten seconds on the screen, once per step.
 */
export function NativeCoachMark({ stepId, stepTitle, held = false }: { stepId: string | null; stepTitle: string | null; held?: boolean }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const { mode, session } = useApp();
  const focused = useIsFocused();
  const guideSwitches = useGuideSwitches();
  const userId = mode === 'authenticated' ? session?.user.id ?? null : null;
  // #6248: member-coach-mark is the experiment-ready PostHog flag; "test"
  // withholds the coach mark, and its default "control" keeps it.
  const coachMarkVariant = useNativeFeatureFlag('member-coach-mark', { view: 'home', exposed: guideSwitches.coachMarks && Boolean(userId) });
  const switches = { ...guideSwitches, coachMarks: guideSwitches.coachMarks && coachMarkVariant !== 'test' };
  const [seen, setSeen] = useState<{ userId: string | null; seen: Record<string, number> }>({ userId: null, seen: {} });
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!switches.coachMarks || !userId) return undefined;
    let live = true;
    void readCoachSeen(userId).then((stored) => { if (live) setSeen({ userId, seen: stored }); });
    return () => { live = false; };
  }, [switches.coachMarks, userId]);
  useEffect(() => {
    setWaited(false);
    if (!focused || !switches.coachMarks) return undefined;
    const timer = setTimeout(() => setWaited(true), COACH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [focused, switches.coachMarks, stepId]);
  const anchor = stepId ? `next-step:${stepId}` : null;
  const decision = coachMarkDecision({
    on: switches.coachMarks && Boolean(userId) && seen.userId === userId,
    applies: Boolean(stepId),
    anchor,
    control: stepTitle ?? '',
    anchorReached: focused,
    secondsOnScreen: waited ? 10 : 0,
    shownThisSession: coachMarkShownThisSession(userId),
    seen: seen.userId === userId ? seen.seen : {},
    featureGuideOpen: held,
  });
  const shown = decision.show && decision.anchor;
  const title = t('Next step');
  const body = t('Your next step is: {title}', { title: stepTitle ?? '' });
  const announcement = `${title}. ${body}`;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || !userId || !anchor) return;
    if (coachMarkShownThisSession(userId) !== anchor) noteCoachMarkShown(userId, anchor);
    if (announced.current !== anchor) {
      announced.current = anchor;
      AccessibilityInfo.announceForAccessibility?.(announcement);
    }
  }, [shown, userId, anchor, announcement]);
  if (!shown || !anchor || !userId) return null;
  const close = () => {
    void haptics.select();
    const next = { ...seen.seen, [anchor]: Date.now() };
    setSeen({ userId, seen: next });
    void writeCoachSeen(userId, next);
  };
  return (
    <View style={[styles.coach, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.coachTitle, { color: theme.cardForeground }]}>{title}</Text>
      <Body fitWords>{body}</Body>
      <Button variant="secondary" label={t('Got it')} onPress={close} />
    </View>
  );
}

type OrgStartCheck = { id: string; done: boolean; label: GuideCopy; who: GuideCopy; locked: boolean };
type Milestone = { id: string; number: number; title: GuideCopy; why: GuideCopy; state: string; done: boolean; fact: GuideCopy; lock: GuideCopy | null; checks: OrgStartCheck[] };
type OrgStartPerson = { userId: string; name: string; roles: string[] };
type OrgStartGuideView = {
  kind: 'guide';
  eyebrow: GuideCopy;
  title: GuideCopy;
  ring: { done: number; total: number; percent: number; text: GuideCopy };
  next: { id: string; title: GuideCopy; line: GuideCopy } | null;
  milestones: Milestone[];
  people: OrgStartPerson[];
  members: { userId: string; name: string }[];
  peoplePartial: GuideCopy | null;
  membersPartial: GuideCopy | null;
  canReviewSwitches: boolean;
  canNameContacts: boolean;
  contacts: { backupUserId: string | null; spokespersonUserIds: string[] };
};
type OrgStartCelebration = { kind: 'celebrate'; title: GuideCopy; body: GuideCopy };

/** The org-start payload for this session, re-read whenever the screen gains focus. */
export function useOrganizationStartGuide(enabled: boolean) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const { mode, session } = useApp();
  const focused = useIsFocused();
  const [state, setState] = useBusinessState<{ owner: typeof requests; payload: unknown } | null>(null);
  const epoch = useRef(0);
  const [notice, setNotice] = useBusinessState('');
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<boolean>(setBusy, false);
  const live = mode === 'authenticated' && Boolean(session) && enabled;
  useEffect(() => {
    if (!live || !focused) return undefined;
    const ticket = requests.capture();
    const mine = ++epoch.current;
    loadOrganizationStartGuide()
      .then((payload) => { if (mine === epoch.current && ticket.isCurrent()) setState({ owner: requests, payload }); })
      .catch(() => { if (mine === epoch.current && ticket.isCurrent()) setState({ owner: requests, payload: null }); });
    return () => { epoch.current += 1; };
  }, [live, focused, session, requests, setState]);
  const run = useCallback(async (write: () => Promise<unknown>, onOutcome?: (saved: boolean) => void) => {
    await operate(true, async () => {
      const ticket = requests.begin();
      if (!ticket.isCurrent()) return;
      const mine = ++epoch.current;
      let payload: unknown;
      try {
        payload = await write();
      } catch (error) {
        if (!onOutcome) throw error;
        if (mine === epoch.current && ticket.isCurrent()) onOutcome(false);
        return;
      }
      await settleBusinessWrite(writer, {
        current: ticket.isCurrent,
        accepted: () => {
          if (mine !== epoch.current) return;
          setState({ owner: requests, payload });
          onOutcome?.(true);
        },
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: () => setNotice(''),
      });
    });
  }, [operate, requests, writer, setState, setNotice]);
  // Ledger 692: a read-only Refresh for a guide that could not be read. It
  // reads only on current session proof and holds the control until done.
  const refresh = useCallback(async () => {
    await operate(true, async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) !== 'current') return;
      const mine = ++epoch.current;
      try {
        const payload = await loadOrganizationStartGuide();
        if (mine === epoch.current && current()) { setState({ owner: requests, payload }); setNotice(''); }
      } catch {
        if (mine === epoch.current && current()) setState({ owner: requests, payload: null });
      }
    });
  }, [operate, requests, writer, setState, setNotice]);
  const read = live && state?.owner === requests;
  const payload = read ? state.payload : null;
  // Off, hidden and done are answers; anything else is a guide not read.
  const unavailable = read && !ORG_START_READ_STATES.has(String((payload as { state?: unknown } | null)?.state));
  return { busy, payload, run, notice, refresh, unavailable };
}

const ORG_START_READ_STATES = new Set(['off', 'hidden', 'done', 'active', 'live']);

/**
 * Guide 1 on the Work screen for people with an organization-wide role. The
 * phone shows the milestones, who can do each and the two things finished
 * here (the administrator's switch review; the backup and spokespeople);
 * the other milestones are done on their own screens on the web.
 */
export function NativeOrgStartGuide() {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const switches = useGuideSwitches();
  const { t } = useNativeUi();
  const { payload, run, notice, busy, refresh, unavailable } = useOrganizationStartGuide(switches.orgStartGuide);
  const [celebrationFailures, setCelebrationFailures] = useBusinessDraftState(0);
  const view = orgStartGuide(payload).view as OrgStartGuideView | OrgStartCelebration | null;
  if (!view) {
    if (!notice && !unavailable) return null;
    return <>
      {notice ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
      <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void refresh()} />
    </>;
  }
  if (view.kind === 'celebrate') {
    return (
      <Card>
        <Text style={[styles.eyebrow, { color: theme.mutedForeground }]}>{guideText({ key: 'guideEngine.org.live' }).toUpperCase()}</Text>
        <Heading level={2}>{guideText(view.title)}</Heading>
        <Body>{guideText(view.body)}</Body>
        {notice ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
        <Button busy={busy} label={t('Done')} onPress={() => {
          void haptics.select();
          void run(() => acknowledgeOrganizationStartCelebration(writer), (saved) => {
            setCelebrationFailures((count) => saved ? 0 : count + 1);
          });
        }} />
        {!busy && celebrationFailures > 0 ? <Notice key={celebrationFailures}>{t('That did not save. Try again.')}</Notice> : null}
      </Card>
    );
  }
  return <><OrgStartCard view={view} run={run} busy={busy} />{notice ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}</>;
}

function OrgStartCard({ view, run, busy }: { view: OrgStartGuideView; run: (write: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const [expanded, setExpanded] = useBusinessState(false);
  const [openId, setOpenId] = useBusinessState<string | null>(null);
  const [status, setStatus] = useBusinessDraftState('');
  const milestones = view.milestones;
  const stateLabel = (milestone: Milestone) => guideText({ key: milestone.state === 'done' ? 'guideEngine.orgPage.state.done' : milestone.state === 'next' ? 'guideEngine.orgPage.state.next' : milestone.state === 'needsAdmin' ? 'guideEngine.orgPage.state.needsAdmin' : 'guideEngine.orgPage.state.notYet' });
  return (
    <Card>
      <Text style={[styles.eyebrow, { color: theme.mutedForeground }]}>{guideText(view.eyebrow).toUpperCase()}</Text>
      <Heading level={2}>{guideText(view.title)}</Heading>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={guideText(view.eyebrow)}
        accessibilityValue={{ min: 0, max: view.ring.total, now: view.ring.done, text: guideText(view.ring.text) }}
        style={[styles.track, { backgroundColor: theme.muted }]}
      >
        <View style={[styles.fill, { width: `${view.ring.percent}%`, backgroundColor: theme.primary }]} />
      </View>
      <Text style={[styles.strong, { color: theme.foreground }]}>{guideText(view.ring.text)}</Text>
      {view.next ? <Text style={[styles.strong, { color: theme.foreground }]}>{guideText(view.next.line)}</Text> : null}
      <Button label={guideText({ key: 'guideEngine.org.continue' })} selected={expanded} onPress={() => {
        void haptics.select();
        setExpanded((value) => !value);
        if (!expanded && !openId && view.next) setOpenId(view.next.id);
      }} />
      <Body muted>{guideText({ key: 'guideEngine.org.sharedLine' })}</Body>
      {expanded ? milestones.map((milestone) => {
        const open = openId === milestone.id;
        const switchesOpen = milestone.checks.some((check) => check.id === 'switchesReviewed' && !check.done);
        return (
          <View key={milestone.id} style={[styles.milestone, { borderColor: theme.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${milestone.number}. ${guideText(milestone.title)}, ${stateLabel(milestone)}, ${guideText(milestone.fact)}`}
              onPress={() => { void haptics.select(); setOpenId(open ? null : milestone.id); }}
              style={styles.milestoneRow}
            >
              <Text style={[styles.strong, { color: theme.foreground }]}>{`${milestone.number}. ${guideText(milestone.title)}`}</Text>
              <Text style={[styles.state, { color: theme.foreground }]}>{stateLabel(milestone)}</Text>
              <Body muted>{guideText(milestone.fact)}</Body>
            </Pressable>
            {open ? (
              <View style={styles.milestoneBody}>
                <Body>{`${guideText({ key: 'guideEngine.orgPage.whyTitle' })}: ${guideText(milestone.why)}`}</Body>
                {milestone.checks.map((check) => (
                  <Body key={check.id}>{`• ${guideText(check.label)}: ${guideText({ key: check.done ? 'guideEngine.org.done' : 'guideEngine.org.notYet' })}. ${guideText({ key: 'guideEngine.orgPage.whoCanTitle' })}: ${guideText(check.who)}${check.locked ? `. ${guideText({ key: 'guideEngine.orgPage.locked' })}` : ''}`}</Body>
                ))}
                {milestone.lock ? <Text style={[styles.strong, { color: theme.foreground }]}>{guideText(milestone.lock)}</Text> : null}
                {switchesOpen && view.canReviewSwitches ? (
                  <Button disabled={busy} variant="secondary" label={guideText({ key: 'guideEngine.setup.switchesSave' })} onPress={() => {
                    void haptics.select();
                    run(() => reviewOrganizationStartSwitches(writer)).then(() => setStatus(guideText({ key: 'guideEngine.setup.switchesReviewed' }))).catch(() => setStatus(guideText({ key: 'guideEngine.orgPage.contacts.failed' })));
                  }} />
                ) : null}
                {milestone.id === 'backups' && view.canNameContacts ? <NativeContacts view={view} run={run} onStatus={setStatus} busy={busy} /> : null}
              </View>
            ) : null}
          </View>
        );
      }) : null}
      {status ? <Text accessibilityLiveRegion="polite" style={[styles.strong, { color: theme.foreground }]}>{status}</Text> : null}
    </Card>
  );
}

function NativeContacts({ view, run, onStatus, busy }: { busy: boolean; view: OrgStartGuideView; run: (write: () => Promise<unknown>) => Promise<void>; onStatus: (text: string) => void }) {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const people = view.people;
  const [backup, setBackup] = useBusinessDraftState<string | null>(view.contacts.backupUserId ?? null);
  const [spokes, setSpokes] = useBusinessDraftState<string[]>(view.contacts.spokespersonUserIds ?? []);
  const toggle = (userId: string) => setSpokes((current) => (current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]));
  return (
    <View style={styles.milestoneBody}>
      <Text accessibilityRole="header" style={[styles.groupHeading, { color: theme.cardForeground }]}>{guideText({ key: 'guideEngine.orgPage.contacts.backup' })}</Text>
      {view.peoplePartial ? <Text style={{ color: theme.mutedForeground }}>{guideText(view.peoplePartial)}</Text> : null}
      {people.map((person) => (
        <Pressable disabled={busy} key={`b-${person.userId}`} accessibilityRole="radio" accessibilityState={{ checked: backup === person.userId }} onPress={() => setBackup(backup === person.userId ? null : person.userId)} style={[styles.choice, { borderColor: theme.border, backgroundColor: backup === person.userId ? theme.secondary : 'transparent' }]}>
          <Text style={{ color: backup === person.userId ? theme.secondaryForeground : theme.foreground }}>{person.name}</Text>
        </Pressable>
      ))}
      <Text accessibilityRole="header" style={[styles.groupHeading, { color: theme.cardForeground }]}>{guideText({ key: 'guideEngine.orgPage.contacts.spokespeople' })}</Text>
      {view.membersPartial ? <Text style={{ color: theme.mutedForeground }}>{guideText(view.membersPartial)}</Text> : null}
      {view.members.map((person) => (
        <Pressable disabled={busy} key={`s-${person.userId}`} accessibilityRole="checkbox" accessibilityState={{ checked: spokes.includes(person.userId) }} onPress={() => toggle(person.userId)} style={[styles.choice, { borderColor: theme.border, backgroundColor: spokes.includes(person.userId) ? theme.secondary : 'transparent' }]}>
          <Text style={{ color: spokes.includes(person.userId) ? theme.secondaryForeground : theme.foreground }}>{person.name}</Text>
        </Pressable>
      ))}
      <Button disabled={busy} label={guideText({ key: 'guideEngine.setup.save' })} onPress={() => {
        void haptics.select();
        run(() => saveOrganizationStartContacts(writer, backup, spokes)).then(() => onStatus(guideText({ key: 'guideEngine.orgPage.contacts.saved' }))).catch(() => onStatus(guideText({ key: 'guideEngine.orgPage.contacts.failed' })));
      }} />
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4 },
  chip: { borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  group: { gap: 2 },
  groupHeading: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  actions: { gap: spacing.sm },
  coach: { gap: spacing.sm, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  coachTitle: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%' },
  strong: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  state: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  milestone: { borderWidth: 1, borderRadius: radii.md },
  milestoneRow: { minHeight: minimumTouchTarget, padding: spacing.md, gap: 2 },
  milestoneBody: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  choice: { minHeight: minimumTouchTarget, justifyContent: 'center', borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md },
});
