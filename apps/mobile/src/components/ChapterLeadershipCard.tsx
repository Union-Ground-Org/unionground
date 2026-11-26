import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useNativeUi } from '../lib/useNativeUi';
import { useBusinessRequests } from '../lib/useBusinessWriter';
import { useBusinessOperation, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { useCallback, useEffect, useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';

import { Body, Button, Card, Heading } from './ui';
import {
  LEADERSHIP_OUTCOME_COPY,
  leadershipCardState,
  leadershipFailureCopy,
  leadershipFailureReason,
  type LeadershipRecovery,
} from '../lib/governanceShared';
import { staffTwoStepSettings } from '../lib/staffTwoStepNotice';
import { claimMobileChapterLeadership, loadMobileLeadershipRecovery, withdrawMobileLeadershipClaim } from '../services/governance';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';
import { deviceDateTime } from '../lib/evidenceTimestamp';

const twoStep = staffTwoStepSettings();

// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001: the native half of the web
// campaign leadership card. get_chapter_leadership_recovery() decides everything; a
// preview, a read in flight or a failed read shows nothing. Claiming takes an
// explicit second press (the confirmation states the cooling-off window) and
// an AAL2 session, which the server re-checks.
export function ChapterLeadershipCard() {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const { locale, t } = useNativeUi();
  const { mode, organizationID, dashboard, chapterMemberships } = useApp();
  const chapterID = chapterMemberships?.find(row => row.selected)?.chapterID ?? dashboard?.member.chapterID ?? null;
  const [accepted, setAccepted] = useBusinessSubjectState(JSON.stringify([organizationID, chapterID]), false);
  const focused = useIsFocused();
  const [recovery, setRecovery] = useBusinessDraftState<LeadershipRecovery | null>(null);
  const [confirming, setConfirming] = useBusinessDraftState(false);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [reload] = useBusinessDraftState(0);

  useEffect(() => {
    setRecovery(null);
    setConfirming(false);
  }, [mode, organizationID, setRecovery, setConfirming]);

  const reads = useRef(0);
  const refresh = useCallback(async (confirmAccepted = false) => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++reads.current;
    try { const next = await loadMobileLeadershipRecovery(); if (at !== reads.current || !ticket.isCurrent()) return false; setRecovery(next); if (confirmAccepted) setAccepted(false); setError(null); return true; }
    catch (failure) {
      if (at === reads.current && ticket.isCurrent()) setError(leadershipFailureCopy(leadershipFailureReason(failure)));
      return false;
    }
  }, [requests, setRecovery, setAccepted, setError]);
  useEffect(() => {
    if (mode !== 'authenticated' || !focused) return;
    void refresh(); return () => { reads.current += 1; };
  }, [focused, mode, organizationID, reload, refresh]);

  const state = mode === 'authenticated' ? leadershipCardState(recovery) : 'hidden';
  if (state === 'hidden' || !recovery) return null;

  async function run(action: () => Promise<void>) {
    await operate(true, async () => {

    if (accepted) return;
    const current = requests.capture().isCurrent;
    setError(null);
    try {
      await action();
      setAccepted(true);
      setConfirming(false);
      if (await checkBusinessContinuation(writer, current) !== 'current' || !await refresh(true)) setError(t(BUSINESS_SAVED_STALE));
    } catch (failure) {
      setError(leadershipFailureCopy(leadershipFailureReason(failure)));
    }

    });
  }

  const claim = recovery.claim;
  const chapter = recovery.chapterName ?? 'your campaign';
  return (
    <Card>
      {(accepted || error) ? <Button label={t('Refresh')} variant="secondary" disabled={busy} onPress={() => void operate(true, async () => { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await refresh(true); })} /> : null}
      {state === 'pending' && claim ? (
        <View style={styles.stack}>
          <Heading level={3}>Your campaign leadership claim is pending</Heading>
          <Body muted>It takes effect {deviceDateTime(claim.effectiveAt, locale) ?? 'after the cooling-off window'} unless an organization admin rejects it.</Body>
          <Button label="Withdraw claim" variant="secondary" busy={busy} disabled={busy || accepted} onPress={() => { void run(() => withdrawMobileLeadershipClaim(writer, claim.id)); }} />
        </View>
      ) : state === 'outcome' && claim && claim.status !== 'pending' ? (
        <View style={styles.stack}>
          <Heading level={3}>{LEADERSHIP_OUTCOME_COPY[claim.status].title}</Heading>
          {LEADERSHIP_OUTCOME_COPY[claim.status].body ? <Body muted>{LEADERSHIP_OUTCOME_COPY[claim.status].body}</Body> : null}
          {claim.status === 'rejected' && claim.decisionNote ? <Body muted>Their note: {claim.decisionNote}</Body> : null}
        </View>
      ) : (
        <View style={styles.stack}>
          <Heading level={3}>Campaign leadership is available</Heading>
          <Body muted>Your campaign's admins and committee members have had no activity for {recovery.inactivityMonths} months. You can claim campaign admin to restore local leadership.</Body>
          <Body muted>Organization admins are told right away and have {recovery.coolingOffHours} hours to reject the claim before it takes effect.</Body>
          {!recovery.mfaAssured ? (
            <>
              <Body muted>Claiming needs two-step sign-in. Set it up on {twoStep.host}, then sign in here again with your second step.</Body>
              <Button label={twoStep.action} variant="secondary" onPress={() => { void Linking.openURL(twoStep.url).catch(() => setError(twoStep.openFailed)); }} />
            </>
          ) : confirming ? (
            <>
              <Body>You will become an admin of {chapter} in {recovery.coolingOffHours} hours unless an organization admin rejects the claim. Organization admins are notified now.</Body>
              <Button label="Confirm claim" busy={busy} disabled={busy || accepted || !recovery.chapterId} onPress={() => { if (recovery.chapterId) void run(() => claimMobileChapterLeadership(writer, recovery.chapterId as string)); }} />
              <Button label="Cancel" variant="secondary" disabled={busy || accepted} onPress={() => setConfirming(false)} />
            </>
          ) : (
            <Button label="Claim campaign admin" disabled={busy || accepted} onPress={() => { setError(null); setConfirming(true); }} />
          )}
        </View>
      )}
      {error ? <Body accessibilityRole="alert">{error}</Body> : null}
      {accepted && error !== t(BUSINESS_SAVED_STALE) ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
});
