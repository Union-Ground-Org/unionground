import { captureSessionWriter } from '../../src/services/supabase';
import { useRequestGeneration } from '../../src/lib/useRequestGeneration';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../src/components/Text';

import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { AttachmentPanel } from '../../src/components/AttachmentPanel';
import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../../src/components/ui';
import { useWordFit } from '../../src/components/useWordFit';
import { CaseRowTopicCard } from '../../src/features/CaseRowTopicCards';
import { CaseStewardAssignment } from '../../src/features/CaseStewardAssignment';
import { StewardCaseNoteCard, type StewardNoteReread } from '../../src/features/StewardCaseNoteCard';
import { useAssignedStewardCase } from '../../src/features/useAssignedStewardCase';
import { CoordinatorCaseWritesCard } from '../../src/features/CoordinatorCaseWritesCard';
import { previewCaseDetail } from '../../src/data/preview';
import { memberCaseStep } from '../../src/lib/caseStepLabels';
import { attachmentPanelMounted, caseDetailPresence, shouldClearLoadedCaseDetail } from '../../src/lib/caseDetailPresence';
import { explicitLiveStaffHat } from '../../src/lib/hatFunctions';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, spacing } from '../../src/theme/tokens';
import type { MemberCaseDetail } from '../../src/models/member';
import { loadCaseDetail } from '../../src/services/supabase';
import { CASE_UPDATE_NOT_LOGGED, CASE_VIEW_NOT_LOGGED, caseAccessScope, recordCaseAccess } from '../../src/services/caseAccessHistory';
import { sessionIDFromAccessToken } from '../../src/lib/sessionLineage';
import { useNativeUi } from '../../src/lib/useNativeUi';
import { CASE_OUTCOME_TITLE, caseOutcomeLabel, caseOutcomeRecordedLine, shownCaseOutcome } from '../../src/lib/caseOutcomeCopy';

import { typeface } from '../../src/theme/typeface';
// At the largest iPhone text size a case number (GR-2026-78078, ledger 381) and
// a step name ("investigation", in Public Sans) split between letters: these
// lines grow only while their longest word fits the line.
function FittedText({ children, style, color }: { children: string; style: typeof styles.value | typeof styles.reference; color: string }) {
  const fit = useWordFit(true, children, style);
  return (
    <Text onLayout={fit.onLayout} allowFontScaling={fit.allowFontScaling} style={[style, { color }, fit.style]}>
      {children}
    </Text>
  );
}

// An issue coworkers raised. The record is a member_cases row, shown as an
// organizing issue, with no
// grievance steps, contract citations, or legal deadlines.
export default function IssueDetailScreen() {
  const [screenName, setScreenName] = useState('Issue');
  return (
    <PinnedHeaderScreen screenName={screenName}>
      <CaseDetailContent onScreenName={setScreenName} />
    </PinnedHeaderScreen>
  );
}

function CaseDetailContent({ onScreenName }: { onScreenName: (name: string) => void }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { dashboard, mode, session, previewHat, authorizedRoles, organizationID, chapterMemberships } = useApp();
  const { t } = useNativeUi();
  const userID = session?.user.id;
  //  (review R-9204, finding 3): the person, sign-in and selection a
  // viewed_case entry is written for.
  const receiptWriter = captureSessionWriter(session);
  const receiptScope = caseAccessScope({
    userID,
    sessionID: session?.access_token ? sessionIDFromAccessToken(session.access_token) : null,
    organizationID,
    chapterID: chapterMemberships?.find((entry) => entry.selected)?.chapterID,
  });
  const liveStaffHat = mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;
  const coordinatorAccess = liveStaffHat === 'coordinator';
  const staffAccess = coordinatorAccess || liveStaffHat === 'steward';
  const dashboardItem = dashboard?.cases.find((candidate) => candidate.id === id) ?? null;
  const [loadedDetail, setDetail] = useState<MemberCaseDetail | null>(null);
  // The receipt scope `loadedDetail` was loaded under. Under a staff hat, a loaded
  // case is shown only to the scope that wrote its viewed_case entry.
  const [detailScope, setDetailScope] = useState<string | null>(null);
  const [loadingCase, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The record id the current `detail` was loaded for. A revalidation re-run
  // for the same id keeps that detail (and the attachment panel under it)
  // mounted; see caseDetailPresence.ts.
  const loadedID = useRef<string | null>(null);
  //: a steward or coordinator opening another member's case leaves one
  // viewed_case entry per opening, written before the case is shown, as on the
  // website. A reload of the same case on this screen (session revalidation,
  // dashboard refresh, token refresh) reuses the entry; another person, sign-in,
  // organization or chapter writes its own before the case shows (review
  // R-9204, finding 3). A failed entry is retried by Try again.
  const viewEntry = useRef<{ key: string; recorded: Promise<boolean> } | null>(null);
  const [updateNotLogged, setUpdateNotLogged] = useState(false);
  // One Try again write for an updated_case entry at a time (finding 4).
  const updateRetry = useRef<Promise<void> | null>(null);
  const [updateRetryBusy, setUpdateRetryBusy] = useState(false);
  //: a route-authorization generation. It moves forward on every
  // observed change of the route's case, receipt scope, session mode or staff
  // hat, and never moves back, so returning to earlier values (the same
  // session resuming through 'booting', a chapter switched away and back)
  // starts a new generation. A reread after a case-card write starts and
  // commits only in the generation the write's screen was drawn in, so a
  // reply that lands after any such change never puts the case back on
  // screen (reviews R-9228 and R-9228b, P2-1).
  const authorization = JSON.stringify([typeof id === 'string' && id ? id : null, receiptScope, mode, liveStaffHat]);
  const routeAuthorization = useRef({ key: authorization, generation: 0 });
  if (routeAuthorization.current.key !== authorization) {
    routeAuthorization.current = { key: authorization, generation: routeAuthorization.current.generation + 1 };
  }
  const authorizationGeneration = routeAuthorization.current.generation;
  const continuations = useRequestGeneration('case-route');
  //: the steward hat's case tools appear only on a case assigned to them.
  // The assignment is read again in every authorization generation, and an
  // answer from an earlier generation is dropped.
  const ownStewardCase = useAssignedStewardCase(
    liveStaffHat === 'steward' && typeof id === 'string' && id ? id : null,
    liveStaffHat === 'steward' ? userID ?? null : null,
    authorizationGeneration,
  );

  useEffect(() => {
    let active = true;
    const nextID = typeof id === 'string' && id ? id : null;
    // Finding 3: under a staff hat a loaded case belongs to the scope that
    // wrote its entry; another scope loads it again and writes its own.
    if (staffAccess && mode === 'authenticated' && detailScope !== receiptScope) loadedID.current = null;
    const keepLoaded = !shouldClearLoadedCaseDetail({ mode, loadedID: loadedID.current, nextID });
    if (!keepLoaded) {
      loadedID.current = null;
      setDetail(null);
      setLoading(true);
    }
    setLoadError(null);
    if (!id) {
      setLoading(false);
      return () => { active = false; };
    }
    if (mode === 'preview') {
      const hatDetail = previewHat ? previewCaseDetail(id, previewHat) : null;
      setDetail(hatDetail ?? (dashboardItem ? { item: dashboardItem, updates: [] } : null));
      loadedID.current = id;
      setLoading(false);
      return () => { active = false; };
    }
    // Session revalidation in progress: keep whatever is loaded on screen
    // (the root privacy cover hides it) and reload once authenticated again.
    if (mode === 'booting') return () => { active = false; };
    if (mode !== 'authenticated' || !userID) {
      return () => { active = false; };
    }
    if (!keepLoaded) setLoading(true);
    void loadCaseDetail(userID, id, staffAccess).then(async (nextDetail) => {
      if (!active) return;
      if (nextDetail && staffAccess) {
        const key = JSON.stringify([receiptScope, id]);
        if (viewEntry.current?.key !== key) {
          viewEntry.current = {
            key,
            recorded: recordCaseAccess(receiptWriter, 'viewed_case', { caseID: id, subjectUserID: nextDetail.item.ownerID, actorUserID: userID, organizationID }),
          };
        }
        const entry = viewEntry.current;
        const recorded = await entry.recorded;
        if (!recorded && viewEntry.current === entry) viewEntry.current = null;
        if (!active) return;
        if (!recorded) {
          setDetail(null);
          setDetailScope(null);
          loadedID.current = null;
          setLoadError(CASE_VIEW_NOT_LOGGED);
          return;
        }
      }
      setDetail(nextDetail);
      setDetailScope(nextDetail ? receiptScope : null);
      loadedID.current = nextDetail ? id : null;
    }).catch(() => {
      if (active) setLoadError('This issue didn’t load. Check your connection and try again.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
    // A dashboard refresh that replaces this case's row reloads the detail, so
    // a retained route never keeps a stale status, deadline or timeline.
    // detailScope is read only to notice a change of scope; receiptScope
    // carries that change into this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinatorAccess, dashboardItem, id, liveStaffHat, loadAttempt, mode, organizationID, previewHat, receiptScope, staffAccess, userID]);

  useEffect(() => {
    updateRetry.current = null; setUpdateRetryBusy(false); setUpdateNotLogged(false);
    return () => { updateRetry.current = null; };
  }, [id, receiptScope]);

  // A case loaded under another scope is not shown, from the first render
  // after the change, until this scope's own entry is written (finding 3).
  // A session revalidation ('booting') keeps it, as caseDetailPresence says.
  const scopeCurrent = !staffAccess || mode === 'booting' || detailScope === receiptScope;
  const detail = scopeCurrent ? loadedDetail : null;
  const loading = loadingCase || (loadedDetail !== null && !scopeCurrent);

  //: a write from a case card rereads the case and answers the reread
  // detail, or null when it failed or was dropped, so the card never claims a
  // saved row is on screen when the screen still shows the old case (
  // on 8b9d97d8). A reread belongs to the scope whose viewed_case entry the
  // shown case already carries  and to the authorization generation it
  // was started in; when either changed it is dropped.
  const rereadCase = async (): Promise<MemberCaseDetail | null> => {
    const ticket = continuations.capture();
    if (!ticket.isCurrent()) return null;
    const started = authorizationGeneration;
    const requested = typeof id === 'string' && id ? id : null;
    if (routeAuthorization.current.generation !== started || !requested || !userID || mode !== 'authenticated' || (staffAccess && detailScope !== receiptScope)) return null;
    try {
      const nextDetail = await loadCaseDetail(userID, requested, staffAccess);
      if (!ticket.isCurrent() || !nextDetail || routeAuthorization.current.generation !== started) return null;
      setDetail(nextDetail);
      setDetailScope(receiptScope);
      loadedID.current = requested;
      return nextDetail;
    } catch {
      return null;
    }
  };

  // The pinned bar names the record before it offers the way back, so the
  // issue's own name has to reach the route that renders the bar.
  const caseName = detail?.item.title ?? dashboardItem?.title ?? null;
  useEffect(() => {
    onScreenName(caseName ?? 'Issue');
    return () => onScreenName('Issue');
  }, [caseName, onScreenName]);

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const item = detail?.item ?? (mode === 'preview' ? dashboardItem : null);
  // A case held back for a new scope reads as loading until its entry is written.
  const presence = caseDetailPresence({ mode, loading, hasItem: item !== null });
  if (presence === 'loading') return <Screen><StateMessage title="Loading issue" body="Opening your issue." /></Screen>;
  if (!item) {
    return (
      <Screen>
        <StateMessage
          title="Issue not available"
          body={loadError === CASE_VIEW_NOT_LOGGED ? t(CASE_VIEW_NOT_LOGGED) : loadError ?? 'This record may have moved, or your access may have changed.'}
          action={loadError ? <Button label={t('Try again')} onPress={() => setLoadAttempt((attempt) => attempt + 1)} /> : null}
        />
      </Screen>
    );
  }
  // A reopened case keeps its earlier outcome row; only a resolved case shows it.
  const shownOutcome = shownCaseOutcome(item.status, detail?.outcome);
  //: every staff change to another member's case leaves an updated_case
  // entry after it succeeds, and the screen says so when it could not.
  const recordCaseUpdate = staffAccess && userID ? async () => {
    const ticket = continuations.capture();
    const recorded = await recordCaseAccess(receiptWriter, 'updated_case', { caseID: item.id, subjectUserID: item.ownerID, actorUserID: userID, organizationID });
    if (ticket.isCurrent() && routeAuthorization.current.generation === authorizationGeneration && loadedID.current === item.id) setUpdateNotLogged(!recorded);
  } : undefined;
  // Two presses before the first write answers send one write (finding 4).
  const retryCaseUpdate = recordCaseUpdate ? () => {
    if (updateRetry.current) return;
    setUpdateRetryBusy(true);
    const retry = recordCaseUpdate().finally(() => {
      if (updateRetry.current !== retry) return;
      updateRetry.current = null;
      setUpdateRetryBusy(false);
    });
    updateRetry.current = retry;
  } : undefined;
  //: a write from a case card leaves an updated_case entry in the
  // member's access history, then the case is read again, as the
  // website's case dialogs do through onChanged -> recordUpdate -> reload.
  // It answers the reread case, or null when the reread failed or was dropped,
  // so a card claims only what the reread shows.
  const afterCaseWrite = async (): Promise<MemberCaseDetail | null> => {
    if (recordCaseUpdate) await recordCaseUpdate();
    return rereadCase();
  };
  // Every Refresh is read-only, even after a successful write's reread
  // failed. The receipt belongs only to the acknowledged write.
  const refreshCase = (): Promise<MemberCaseDetail | null> => rereadCase();
  const refreshNote = async (noteID: string | null): Promise<StewardNoteReread> => {
    const reread = await rereadCase();
    if (!reread) return 'stale';
    return noteID && reread.updates.some((update) => update.id === noteID) ? 'shown' : 'saved';
  };
  const afterNoteSaved = async (noteID: string | null): Promise<StewardNoteReread> => {
    if (recordCaseUpdate) await recordCaseUpdate();
    return refreshNote(noteID);
  };
  // The steward's tools stay off the steward's own case: the website's
  // caseload leaves those out.
  const stewardTools = ownStewardCase && item.ownerID !== userID;
  return (
    <Screen>
      <View style={styles.title}>
        <FittedText style={styles.reference} color={theme.primary}>{item.reference}</FittedText>
        <Heading>{item.title}</Heading>
        <View style={styles.chips}>
          <StatusPill label={item.status} />
          <View style={[styles.chip, { backgroundColor: theme.muted }]}>
            <Text style={[styles.chipText, { color: theme.mutedForeground }]}>{item.caseType}</Text>
          </View>
          <View style={[styles.chip, { backgroundColor: theme.muted }]}>
            <Ionicons name="calendar-outline" size={13} color={theme.mutedForeground} accessibilityElementsHidden />
            <Text style={[styles.chipText, { color: theme.mutedForeground }]}>{item.deadline ? `Follow up ${formatDate(item.deadline)}` : 'No follow-up date'}</Text>
          </View>
        </View>
        <Body muted>Updated {formatDateTime(item.updatedAt)}</Body>
      </View>
      <Card>
        <Detail label="Where it stands" value={memberCaseStep(item)} />
      </Card>
      {shownOutcome ? <CaseOutcomeCard outcome={shownOutcome} /> : null}
      {/*  part 2: the coordinator assigns or changes the steward here, as on the website. */}
      {mode === 'authenticated' && coordinatorAccess && detail ? <CaseStewardAssignment caseID={item.id} onSaved={recordCaseUpdate} /> : null}
      {mode === 'authenticated' && detail ? <CaseRowTopicCard caseID={item.id} /> : null}
      {/*: the case's own steward adds a case note, as on the website's
          steward case dialog; the routine checks the hat, MFA and assignment.
          The card says the note is in the timeline only when the reread holds
          it (review R-9228, P2-2). */}
      {/* Each case card is keyed to the authorization generation, so a change
          of case, scope, mode or hat starts it afresh and drops anything it
          was still waiting for. */}
      {stewardTools && detail ? <StewardCaseNoteCard key={`note-${authorizationGeneration}`} caseID={item.id} onSaved={afterNoteSaved} onRefresh={refreshNote} /> : null}
      {/*  part 4: the coordinator's note, contact log and later case
          deadline, as in the website's coordinator case panel. */}
      {mode === 'authenticated' && coordinatorAccess && detail ? (
        <CoordinatorCaseWritesCard key={`coordinator-${authorizationGeneration}`} caseID={item.id} currentDeadline={item.deadline} onChanged={afterCaseWrite} onRefresh={refreshCase} />
      ) : null}
      {attachmentPanelMounted({ mode, hasLiveDetail: detail !== null && mode !== 'preview' }) ? (
        <AttachmentPanel
          target={{ kind: 'case', id: item.id }}
          canWrite={item.ownerID === userID || coordinatorAccess}
          onChanged={recordCaseUpdate ? () => { void recordCaseUpdate(); } : undefined}
        />
      ) : null}
      {updateNotLogged && retryCaseUpdate ? (
        <Card>
          <Body style={{ color: theme.destructive }}>{t(CASE_UPDATE_NOT_LOGGED)}</Body>
          <Button label={t('Try again')} variant="secondary" busy={updateRetryBusy} disabled={updateRetryBusy} onPress={retryCaseUpdate} />
        </Card>
      ) : null}
      <View style={styles.timelineSection}>
        <Heading level={2}>What has happened</Heading>
        <Body muted>Every update you are authorized to see for this issue.</Body>
        {detail?.updates.length ? (
          <View style={styles.timeline}>
            {detail.updates.map((update, index) => (
              <View key={update.id} style={styles.timelineRow}>
                <View style={styles.track}>
                  <View style={[styles.timelineDot, { backgroundColor: theme.primary }]} />
                  {index < detail.updates.length - 1 ? <View style={[styles.timelineLine, { backgroundColor: theme.border }]} /> : null}
                </View>
                <Card style={styles.timelineCard}>
                  <Body>{update.body}</Body>
                  <Body muted>{formatDateTime(update.createdAt)}</Body>
                </Card>
              </View>
            ))}
          </View>
        ) : (
          <Card style={styles.emptyCard}>
            <Ionicons name="time-outline" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
            <Body muted>No updates have been posted yet.</Body>
          </Card>
        )}
      </View>
      <Card>
        <Heading level={3}>Need to ask a question?</Heading>
        <Body muted>Your private conversation with the committee is separate from this issue and does not change its record.</Body>
        <Button label="Open messages" variant="secondary" onPress={() => router.push('/messages')} />
      </Card>
      <View style={[styles.privacy, { backgroundColor: theme.muted }]}>
        <Heading level={3}>Facts, not conclusions</Heading>
        <Body muted>Write down what happened, when, and who saw it. The app does not label anything illegal. Issue access is enforced by row-level security, and details never appear in notification previews.</Body>
      </View>
    </Screen>
  );
}

// The outcome a coordinator recorded on this case . English only, by
// the native owner ruling.
function CaseOutcomeCard({ outcome }: { outcome: NonNullable<MemberCaseDetail['outcome']> }) {
  return (
    <Card>
      <Heading level={2}>{CASE_OUTCOME_TITLE}</Heading>
      <Detail label={caseOutcomeRecordedLine(formatDateTime(outcome.updated_at || outcome.recorded_at))} value={caseOutcomeLabel(outcome.outcome)} />
      <Body>{outcome.summary}</Body>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return <View style={styles.detail}><Text style={[styles.label, { color: theme.mutedForeground }]}>{label}</Text><FittedText style={styles.value} color={theme.foreground}>{value}</FittedText></View>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

const styles = StyleSheet.create({
  title: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  chipText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, textTransform: 'capitalize' },
  emptyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  reference: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.5 },
  detail: { gap: spacing.xs, paddingVertical: spacing.sm },
  label: { fontSize: 13, lineHeight: 18, ...typeface.control },
  value: { fontSize: 17, lineHeight: 23, ...typeface.controlStrong },
  timelineSection: { gap: spacing.md },
  timeline: { gap: 0 },
  timelineRow: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.md },
  track: { width: 18, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: spacing.lg },
  timelineLine: { width: 2, flex: 1, minHeight: spacing.xxl },
  timelineCard: { flex: 1, marginBottom: spacing.md },
  privacy: { borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
});
