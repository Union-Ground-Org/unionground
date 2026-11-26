import { BUSINESS_SAVED_STALE, checkBusinessContinuation } from '../../lib/businessWriteContinuation';
import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import { useBusinessOperation, useBusinessSubjectState } from '../../lib/useBusinessWriter';
import { useNativeUi } from '../../lib/useNativeUi';
import type { NativeUiKey } from '../../lib/nativeUiCopy';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../../lib/useBusinessWriter';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';

import { Body, Button, Card, Heading, Notice, Screen, StateMessage, StatusPill } from '../../components/ui';
import {
  authorizeAuditQuery,
  authorizeJobQuery,
  buildJobHealthDesk,
  normalizePersistedJobHealthRows,
  toOperationsSession,
  UNREAD_HELD_JOB_SCOPE,
  withoutHeldJobs,
  type HeldJobScope,
  type NativeOrganizationActor,
} from '../../lib/mi1Shared';
import {
  acknowledgeMobileOperationsJob,
  isMfaRequiredRpcError,
  loadMobileOperationsAudit,
  loadMobileOperationsJobHealth,
  requestMobileOperationsJobRetry,
  type MobileOperationsAuditEvent,
  type MobileOperationsJobHealth,
} from '../../services/supabase';
import { loadMobileAdminListedSettingKeys, loadMobileCompassPlatformOperator } from '../../services/heldJobScope';
import { auditDomainLabel, auditEventLabel, auditLedgerEmpty, auditLedgerReason, jobsPanelMessage, operationsPanelState, showJobCards } from '../../lib/operationsHealthStates';
import { formatZoneInstant, groupTimeZone } from '../../../../../src/lib/zoneTime.js';
import { parseDatabaseTimestamp } from '../../lib/evidenceTimestamp';
import { statusStateForLabel } from '../../theme/statusRamp';

type OperationsJobRun = {
  runId?: string | null;
  failureCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

const jobHealthLabels = new Map<string, NativeUiKey>([
  ['healthy', 'Up to date'],
  ['running', 'Running'],
  ['skipped', 'Skipped'],
  ['stale', 'No recent run'],
  ['failing', 'Run failed'],
  ['acknowledged', 'Issue acknowledged'],
]);

export function OperationsHealthScreen({ actor, live = false }: { actor: NativeOrganizationActor; live?: boolean }) {
  const { catalogLabel, language, t } = useNativeUi();
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const session = toOperationsSession(actor);
  const auditGate = authorizeAuditQuery(session);
  const jobGate = authorizeJobQuery(session);
  const authorized = auditGate.ok && jobGate.ok;
  const [auditEvents, setAuditEvents] = useBusinessDraftState<MobileOperationsAuditEvent[]>([]);
  const [jobRows, setJobRows] = useBusinessDraftState<MobileOperationsJobHealth[]>([]);
  // A job that serves a held switch is not listed; until the admin settings
  // list is read, none of those jobs are (Sunday release sweep follow-up).
  const [heldScope, setHeldScope] = useBusinessDraftState<HeldJobScope>(UNREAD_HELD_JOB_SCOPE);
  const [loading, setLoading] = useBusinessDraftState(live && authorized);
  // A failed load and a failed acknowledgement or retry are different facts:
  // only the first means the ledger and job health could not be read.
  const [loadError, setLoadError] = useBusinessDraftState<string | null>(null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [busyJobName, setBusyJobName] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busyJobName>(setBusyJobName, null);
  const [needsRefresh, setNeedsRefresh] = useBusinessSubjectState(JSON.stringify([actor.organizationId, actor.chapterId]), false);
  const [acceptedOperations, setAcceptedOperations] = useBusinessState(() => new Set<string>());
  const reads = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const jobs = useMemo(() => {
    const payload = normalizePersistedJobHealthRows(jobRows, session.selectedOrganizationId);
    return buildJobHealthDesk({
      ...payload,
      selectedOrganizationId: session.selectedOrganizationId,
    } as {
      runs: typeof payload.runs;
      acknowledgements: typeof payload.acknowledgements;
      selectedOrganizationId: string | null;
    });
  }, [jobRows, session.selectedOrganizationId]);
  const listedJobs = useMemo(() => withoutHeldJobs(jobs, heldScope), [jobs, heldScope]);

  const refresh = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++reads.current;
    const current = () => ticket.isCurrent() && at === reads.current;
    setAuditEvents([]);
    setJobRows([]);
    setHeldScope(UNREAD_HELD_JOB_SCOPE);
    setLoadError(null);
    if (!live || !authorized) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextAudit, nextJobs, listedSettingKeys, platformOperator] = await Promise.all([
        loadMobileOperationsAudit(),
        loadMobileOperationsJobHealth(),
        loadMobileAdminListedSettingKeys(),
        loadMobileCompassPlatformOperator(),
      ]);
      if (!mounted.current || !current()) return;
      setAuditEvents(nextAudit);
      setJobRows(nextJobs);
      setHeldScope({ listedSettingKeys, platformOperator });
      return true;
    } catch (caught: unknown) {
      if (!mounted.current || !current()) return;
      setLoadError(isMfaRequiredRpcError(caught)
        ? 'Complete two-step sign-in, then reload operations health.'
        : 'Operations health could not be loaded. Try again.');
    } finally {
      if (mounted.current && current()) setLoading(false);
    }
  }, [authorized, live, session.selectedOrganizationId, setAuditEvents, setJobRows, setHeldScope, setLoadError, setLoading, requests]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function refreshView() {
    await operate('refresh', async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current' && await refresh() && current()) {
        setNeedsRefresh(false); setError(null);
      }
    });
  }

  async function remediate(jobName: string, runId: string, kind: 'acknowledge' | 'request_retry') {
    await operate(jobName, async () => {
    const current = requests.capture().isCurrent;

    const key = `${jobName}:${runId}:${kind}`;
    if (acceptedOperations.has(key)) return;
    setError(null);
    try {
      if (kind === 'acknowledge') await acknowledgeMobileOperationsJob(writer, jobName, runId);
      else await requestMobileOperationsJobRetry(writer, jobName, runId);
      setAcceptedOperations(previous => new Set(previous).add(key));
      setNeedsRefresh(true);
      if (!current()) return;
      const proof = await writer.check();
      if (!current() || proof === 'changed') return;
      if (proof === 'unavailable') {
        setError('The change was saved, but the view could not refresh. Pull to refresh.');
        return;
      }
      if (await refresh() && current()) setNeedsRefresh(false);
    } catch (caught: unknown) {
      if (!current()) return;
      setError(isMfaRequiredRpcError(caught)
        ? 'Complete two-step sign-in, then retry this operation.'
        : kind === 'acknowledge'
          ? 'The acknowledgement could not be saved. Try again.'
          : 'The retry request could not be saved. Try again.');
    }

    });
  }

  const panel = operationsPanelState({ authorized, live, loading, loadError });
  const auditReason = auditLedgerReason(panel);
  // Operations reads carry instants without a group zone.
  const operationsTimeZone: string = groupTimeZone(null);
  const jobsMessage = jobsPanelMessage(panel, jobRows.length);

  return (
    <Screen>
      <Heading>{catalogLabel('Operations health')}</Heading>
      <Body muted>Review recent organization activity and scheduled work.</Body>
      {needsRefresh && !error ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
      {!authorized ? (
        <StateMessage
          title="Admin desk"
          body="Operations health opens for an active organization administrator after two-step."
        />
      ) : null}
      {loadError ? <Notice>{loadError}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {needsRefresh ? <Button label="Refresh" disabled={busyJobName !== null} variant="secondary" onPress={() => void refreshView()} /> : null}
      <Card>
        <View style={{ gap: 8 }}>
          <Heading level={3}>Audit ledger</Heading>
          <StatusPill label={panel === 'loading' ? 'Loading' : panel === 'ready' ? 'Ready' : 'Unavailable'} />
          <Body muted>Recent organization activity appears here.</Body>
          {/* "Unavailable" names its reason and next step (audit MOB-ADMIN-12). */}
          {auditReason ? <Body muted>{auditReason}</Body> : null}
          {auditLedgerEmpty(panel, auditEvents.length) ? <Body muted>No recent activity is available.</Body> : null}
          {authorized ? auditEvents.map((event) => (
            <View key={event.id}>
              <Body>{auditDomainLabel(event.domain, language)} · {auditEventLabel(event.eventType, event.reviewStatus, language)}</Body>
              <Body muted>{formatZoneInstant(parseDatabaseTimestamp(event.occurredAt), language, operationsTimeZone) ?? t('Time unavailable')}</Body>
            </View>
          )) : null}
          {panel === 'not_loaded' ? <Button label="Try again" variant="secondary" onPress={() => { void operate('refresh', async () => { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await refresh(); }); }} /> : null}
        </View>
      </Card>
      <Heading level={2}>Background jobs</Heading>
      {/* Each state comes from the load, not the derived desk, which always
          lists the whole job catalog (gate round 1 on #7001). */}
      {jobsMessage ? <StateMessage title={jobsMessage.title} body={jobsMessage.body} /> : null}
      {showJobCards(panel) ? listedJobs.map((job) => {
        const lastRun: OperationsJobRun | null | undefined = job.lastRun;
        const healthLabel = lastRun ? jobHealthLabels.get(job.health) ?? 'Job status unavailable' : 'No run recorded';
        const completedAt = parseDatabaseTimestamp(lastRun?.completedAt);
        const recordedAt = completedAt ?? parseDatabaseTimestamp(lastRun?.startedAt);
        const runTimeLabel = completedAt ? 'Last run · {time}' : 'Started · {time}';
        const runTime = formatZoneInstant(recordedAt, language, operationsTimeZone);
        return (
        <Card key={job.jobName}>
          <Heading level={3}>{job.title}</Heading>
          <StatusPill label={t(healthLabel)} state={statusStateForLabel(job.health.replaceAll('_', ' '))} />
          {lastRun ? <Body muted>{runTime ? t(runTimeLabel, { time: runTime }) : t('Time unavailable')}</Body> : null}
          {lastRun?.failureCode ? <Body muted>Failure code · {lastRun.failureCode}</Body> : null}
          {job.remediations.includes('acknowledge') && lastRun?.runId ? (
            <Button
              label="Acknowledge"
              variant="secondary"
              busy={busyJobName === job.jobName}
              disabled={busyJobName !== null || acceptedOperations.has(`${job.jobName}:${lastRun.runId}:acknowledge`)}
              onPress={() => { void remediate(job.jobName, lastRun!.runId!, 'acknowledge'); }}
            />
          ) : null}
          {job.remediations.includes('request_retry') && lastRun?.runId ? (
            <Button
              label="Request retry"
              busy={busyJobName === job.jobName}
              disabled={busyJobName !== null || acceptedOperations.has(`${job.jobName}:${lastRun.runId}:request_retry`)}
              onPress={() => { void remediate(job.jobName, lastRun!.runId!, 'request_retry'); }}
            />
          ) : null}
        </Card>
      ); }) : null}
    </Screen>
  );
}
