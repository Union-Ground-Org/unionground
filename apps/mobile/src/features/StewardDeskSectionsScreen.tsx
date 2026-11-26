import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessRequests, useBusinessWriter, useBusinessState, useBusinessRequestOwner } from '../lib/useBusinessWriter';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { CaseRowPressable } from '../components/CaseRowPressable';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { FEATURE_TITLES, type FeatureKey } from '../lib/featureCatalog';
import { explicitLiveStaffHat } from '../lib/hatFunctions';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { formatZoneInstant, groupTimeZone } from '../../../../src/lib/zoneTime.js';
import { parseDatabaseTimestamp } from '../lib/evidenceTimestamp';
import { haptics } from '../services/haptics';
import {
  loadStewardBroadcasts,
  loadStewardCaseload,
  loadStewardFormsForReview,
  loadStewardRequests,
  reviewStewardForm,
  StewardFormChangedError,
  StewardFormReturnBlockedError,
  triageStewardRequest,
  type StewardBroadcastCursor,
  type StewardBroadcastRow,
  type StewardCaseloadCase,
  type StewardCaseloadCursor,
  type StewardFormCursor,
  type StewardFormReviewRow,
  type StewardListPage,
  type StewardRequestCursor,
  type StewardRequestRow,
} from '../services/stewardDeskSections';
import {
  formatFormSubmittedAt,
  loadStewardFormReviewDetail,
  stewardFormApprovalBlock,
  type StewardFormApprovalExpectation,
  type StewardFormReviewDetail,
} from '../services/stewardFormReview';
import { NoticeComposer } from './NoticeComposer';
import { stewardFormReviewNames, stewardRequestActionName, stewardRequestTargets } from './stewardRowActionNames';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  acknowledged: 'Acknowledged',
  closed: 'Closed',
  submitted: 'Submitted',
  in_review: 'In review',
  active: 'Active',
  resolved: 'Resolved',
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function useDeskScope(): { key: string; userID: string; chapterID: string; role: string | null } {
  const { dashboard, chosenStaffRole, authorizedRoles, chapterMemberships } = useApp();
  const owner = useBusinessRequestOwner();
  const userID = dashboard?.member.id ?? '';
  const chapterID = chapterMemberships.find((entry) => entry.selected)?.chapterID ?? '';
  // A single-role account has no chosen hat (no choice was offered), so its
  // sole server-confirmed role is the desk role.
  const role = chosenStaffRole ?? explicitLiveStaffHat(authorizedRoles);
  return { key: `${userID}|${role ?? ''}|${chapterID}|${owner.workspace ?? ''}`, userID, chapterID, role };
}

function appendRows<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  const added = next.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  return added.length === 0 ? current : [...current, ...added];
}

function useStewardQueue<T extends { id: string }, C>(
  scopeKey: string,
  reload: number,
  fallback: string,
  loadPage: (cursor: C | null) => Promise<StewardListPage<T, C>>,
) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, scopeKey);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const generation = useRef(0);
  const cursorRef = useRef<C | null>(null);
  const loadingMoreRef = useRef(false);
  // The row a conflict re-read must reach, while that re-read has failed:
  // the footer's Try again runs the re-read again instead of a page that
  // may not exist.
  const failedRefreshRef = useRef<string | null>(null);
  const [rows, setRows] = useState<T[] | null>(null);
  const rowsRef = useRef<T[] | null>(null);
  rowsRef.current = rows;
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<C | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const owner = requests.capture();
    const ticket = generation.current + 1;
    generation.current = ticket;
    cursorRef.current = null;
    loadingMoreRef.current = false;
    failedRefreshRef.current = null;
    setRows(null);
    setTotal(null);
    setNextCursor(null);
    setError(null);
    setLoadingMore(false);
    void loadPageRef.current(null).then((page) => {
      if (generation.current !== ticket || !owner.isCurrent()) return;
      cursorRef.current = page.nextCursor;
      setRows(page.rows);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    }).catch((reason: unknown) => {
      if (generation.current !== ticket || !owner.isCurrent()) return;
      setError(reason instanceof Error ? reason.message : fallback);
    });
  }, [fallback, scopeKey, reload, requests]);

  const loadMore = useCallback(async () => {
    const owner = requests.capture();
    if (!owner.isCurrent()) return;
    if (failedRefreshRef.current !== null) {
      await refreshThroughRef.current(failedRefreshRef.current);
      return;
    }
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    const ticket = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loadPageRef.current(cursor);
      if (generation.current !== ticket || !owner.isCurrent()) return;
      setRows((current) => appendRows(current ?? [], page.rows));
      if (page.total !== null) setTotal(page.total);
      cursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
    } catch (reason: unknown) {
      if (generation.current !== ticket || !owner.isCurrent()) return;
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      if (generation.current === ticket) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [fallback, requests]);

  // Reads the queue again from its first page through the page that holds
  // keepID, and at least as many rows as are loaded now, and swaps it in at
  // once: the rows on screen stay until then, so an open review past page one
  // stays open on its re-read row (gate stage 187 on #8739, r1s1). A
  // resubmitted form sorts later, past the rows loaded before, so the re-read
  // keeps going until it finds keepID or the queue ends.
  const refreshThrough = useCallback(async (keepID: string = '') => {
    const owner = requests.capture();
    if (!owner.isCurrent()) return false;
    const ticket = generation.current + 1;
    generation.current = ticket;
    failedRefreshRef.current = keepID;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setError(null);
    const loaded = rowsRef.current?.length ?? 0;
    let cursor: C | null = null;
    let collected: T[] = [];
    let pageTotal: number | null = null;
    let first = true;
    try {
      do {
        const page: StewardListPage<T, C> = await loadPageRef.current(cursor);
        if (generation.current !== ticket || !owner.isCurrent()) return false;
        collected = appendRows(collected, page.rows);
        if (first || page.total !== null) pageTotal = page.total;
        first = false;
        cursor = page.nextCursor;
      } while (cursor && ((keepID !== '' && !collected.some((row) => row.id === keepID)) || collected.length < loaded));
      failedRefreshRef.current = null;
      cursorRef.current = cursor;
      setRows(collected);
      setTotal(pageTotal);
      setNextCursor(cursor);
      setRevision(value => value + 1);
      return true;
    } catch (reason: unknown) {
      if (generation.current !== ticket || !owner.isCurrent()) return false;
      setError(reason instanceof Error ? reason.message : fallback);
      return false;
    }
  }, [fallback, requests]);
  const refreshThroughRef = useRef(refreshThrough);
  refreshThroughRef.current = refreshThrough;

  const reread = async () => {
    if (!requests.capture().isCurrent()) return false;
    return await refreshThrough('');
  };
  return { rows, total, nextCursor, error, loadingMore, loadMore, refreshThrough, reread, revision };
}

function QueueFooter({ shown, total, hasMore, loadingMore, error, onLoadMore, progressText }: {
  shown: number;
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  progressText?: string;
}) {
  const progress = progressText ?? (shown === 0 ? null : total === null ? `Showing ${shown}` : `Showing ${shown} of ${total}`);
  return (
    <>
      {progress ? <Body muted>{progress}</Body> : null}
      {error ? <Failure message={error} onRetry={onLoadMore} /> : null}
      {hasMore ? (
        <Button label="Load more" accessibilityLabel="Load more" busy={loadingMore} disabled={loadingMore} onPress={onLoadMore} />
      ) : shown > 0 && !error ? <Body muted>End of the list.</Body> : null}
    </>
  );
}

export function StewardDeskSectionsScreen({ featureKey }: { featureKey: FeatureKey }) {
  const { catalogLabel } = useNativeUi();
  const title = FEATURE_TITLES[featureKey];
  return (
    <Screen>
      <Heading>{catalogLabel(title)}</Heading>
      {featureKey === 'steward-caseload' ? <CaseloadSection /> : null}
      {featureKey === 'steward-requests' ? <RequestsSection /> : null}
      {featureKey === 'steward-forms' ? <FormsSection /> : null}
      {featureKey === 'steward-broadcasts' ? <BroadcastsSection /> : null}
    </Screen>
  );
}

function CaseloadSection() {
  const theme = useTheme();
  const router = useRouter();
  const scope = useDeskScope();
  const [reload, setReload] = useState(0);
  const queue = useStewardQueue<StewardCaseloadCase, StewardCaseloadCursor>(
    scope.key,
    reload,
    'Your caseload did not load. Try again.',
    (cursor) => loadStewardCaseload(scope.userID, cursor),
  );

  if (queue.rows === null && queue.error) return <Failure message={queue.error} onRetry={() => setReload((value) => value + 1)} />;
  if (queue.rows === null) return <StateMessage title="Loading your caseload" body="Getting the issues assigned to you." />;
  if (queue.rows.length === 0 && !queue.nextCursor) return <StateMessage title="No issues assigned" body="Issues a campaign lead assigns to you will appear here." />;
  return (
    <>
      <Body muted>Issues a campaign lead assigned to you. Open an issue to read it.</Body>
      {queue.rows.map((item) => (
        <CaseRowPressable
          key={item.id}
          reference={item.reference}
          visible={[item.title, statusLabel(item.status)]}
          onPress={() => { void haptics.select(); router.push(`/issue/${item.id}` as never); }}
          style={({ pressed }) => [styles.cardPress, { opacity: pressed ? 0.82 : 1 }]}
        >
          <Card>
            <Text style={[styles.reference, { color: theme.primary }]}>{item.reference}</Text>
            <Heading level={3}>{item.title}</Heading>
            <Body muted>{statusLabel(item.status)}</Body>
          </Card>
        </CaseRowPressable>
      ))}
      <QueueFooter
        shown={queue.rows.length}
        total={queue.total}
        hasMore={queue.nextCursor !== null}
        loadingMore={queue.loadingMore}
        error={queue.rows.length > 0 ? queue.error : null}
        onLoadMore={() => { void queue.loadMore(); }}
      />
    </>
  );
}

function RequestsSection() {
  const { language, t } = useNativeUi();
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, null);
  const theme = useTheme();
  const scope = useDeskScope();
  const [busyID, setBusyID] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busyID>(setBusyID, null);
  const [acceptedRequests, setAcceptedRequests] = useBusinessState<Record<string, string>>({});
  const [actionError, setActionError] = useBusinessDraftState<string | null>(null, scope.key);
  const [reload, setReload] = useBusinessDraftState(0, scope.key);
  const queue = useStewardQueue<StewardRequestRow, StewardRequestCursor>(
    scope.key,
    reload,
    'Worker requests did not load. Try again.',
    (cursor) => loadStewardRequests(cursor),
  );

  useEffect(() => { setActionError(null); }, [scope.key, reload, setActionError]);

  async function triage(item: StewardRequestRow, action: 'acknowledge' | 'close') {
    await operate(`${action}:${item.id}`, async () => {
    if (acceptedRequests[item.id]) return;
    const current = requests.capture().isCurrent;

    setActionError(null);
    try {
      await triageStewardRequest(writer, item.id, action);
      setAcceptedRequests(previous => ({ ...previous, [item.id]: action === 'acknowledge' ? 'acknowledged' : 'closed' }));
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setActionError(BUSINESS_SAVED_STALE), refresh: async () => { const fresh = await queue.reread(); if (fresh && current()) { setAcceptedRequests({}); void haptics.success(); } return fresh; } });
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : 'That request was not updated. Try again.');
    }

    });
  }

  async function refreshAccepted() {
    await operate('refresh', async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current' && await queue.reread() && current()) {
        setAcceptedRequests({}); setActionError(null);
      }
    });
  }
  const recovery = Object.keys(acceptedRequests).length > 0
    ? <Button label={t('Refresh')} disabled={busyID !== null} variant="secondary" onPress={() => void refreshAccepted()} /> : null;
  if (queue.rows === null && queue.error) return <>{recovery}<Failure message={queue.error} onRetry={() => setReload((value) => value + 1)} /></>;
  if (queue.rows === null) return <>{recovery}<StateMessage title="Loading worker requests" body="Getting asks for committee worker support." /></>;
  const requestTargets = stewardRequestTargets(queue.rows);
  const zone: string = groupTimeZone(null);
  const spanish = language === 'es';
  const formatter = new Intl.NumberFormat(spanish ? 'es' : 'en', { useGrouping: true });
  const shown = formatter.format(queue.rows.length);
  const total = queue.total === null ? null : formatter.format(queue.total);
  // list_steward_requests uses p_status=all: this total includes closed asks.
  const progressText = spanish
    ? `Mostrando ${shown}${total === null ? '' : ` de ${total}`} solicitudes (abiertas y cerradas)`
    : `Showing ${shown}${total === null ? '' : ` of ${total}`} requests (open and closed)`;
  return (
    <>
      {recovery}
      <Body muted>Acknowledge a new request, or close one that is finished.</Body>
      {actionError ? actionError === BUSINESS_SAVED_STALE ? <Card><Body>{t(BUSINESS_SAVED_STALE)}</Body></Card> : <Failure message={actionError} onDismiss={() => setActionError(null)} /> : null}
      {queue.rows.length === 0 && !queue.nextCursor ? <StateMessage title="No worker requests" body="New asks for committee worker support will appear here." /> : null}
      {queue.rows.map((item) => {
        const requestedAt = formatZoneInstant(parseDatabaseTimestamp(item.createdAt), language, zone);
        return <Card key={item.id}>
          <Heading level={3}>{item.memberName}</Heading>
          {item.topic ? <Body>{item.topic}</Body> : null}
          {requestedAt ? <Body muted>{t('Requested {when}', { when: requestedAt })}</Body> : null}
          <Text style={[styles.status, { color: theme.mutedForeground }]}>{statusLabel(acceptedRequests[item.id] ?? item.status)}</Text>
          <View style={styles.actions}>
            {(acceptedRequests[item.id] ?? item.status) === 'requested' ? (
              <Button label="Acknowledge" accessibilityLabel={stewardRequestActionName('acknowledge', requestTargets.get(item) ?? '')} busy={busyID === `acknowledge:${item.id}`} disabled={busyID !== null || Boolean(acceptedRequests[item.id])} onPress={() => { void triage(item, 'acknowledge'); }} />
            ) : null}
            {(acceptedRequests[item.id] ?? item.status) !== 'closed' ? (
              <Button label="Close request" accessibilityLabel={stewardRequestActionName('close', requestTargets.get(item) ?? '')} variant="secondary" busy={busyID === `close:${item.id}`} disabled={busyID !== null || Boolean(acceptedRequests[item.id])} onPress={() => { void triage(item, 'close'); }} />
            ) : null}
          </View>
        </Card>;
      })}
      <QueueFooter
        shown={queue.rows.length}
        total={queue.total}
        progressText={progressText}
        hasMore={queue.nextCursor !== null}
        loadingMore={queue.loadingMore}
        error={queue.rows.length > 0 ? queue.error : null}
        onLoadMore={() => { void queue.loadMore(); }}
      />
    </>
  );
}

function FormsSection() {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, null);
  const theme = useTheme();
  const { catalogLabel, language, t } = useNativeUi();
  const scope = useDeskScope();
  const userID = scope.userID;
  const [acceptedForms, setAcceptedForms] = useBusinessState<Record<string, string>>({});
  const [refusedForms, setRefusedForms] = useBusinessState<Record<string, 'queue' | 'detail'>>({});
  const [openID, setOpenID] = useBusinessDraftState<string | null>(null, scope.key);
  const [note, setNote] = useBusinessDraftState('', scope.key);
  // Each refusal names the form it came from and shows only in that form's
  // review (#9199): "this member already has a draft" is about one member.
  // No refusal is dropped: one whose review is not open shows at the top,
  // with the member named.
  const [actionError, setActionError] = useBusinessDraftState<{ formID: string; memberName: string; message: string; saved?: true } | null>(null, scope.key);
  // While a form action is pending no other review opens (its Review button
  // is disabled, as the open review's own buttons are), so the reply lands in
  // the review it came from.
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [reload, setReload] = useBusinessDraftState(0, scope.key);
  const queue = useStewardQueue<StewardFormReviewRow, StewardFormCursor>(
    scope.key,
    reload,
    'Forms waiting for review did not load. Try again.',
    (cursor) => loadStewardFormsForReview(cursor),
  );

  useEffect(() => {
    setActionError(null);
    setOpenID(null);
    setNote('');
  }, [scope.key, setActionError, setOpenID, setNote]);

  useEffect(() => {
    if (queue.rows === null) return;
    const missing = Object.keys(refusedForms).filter(id => refusedForms[id] === 'detail' && !queue.rows!.some(row => row.id === id));
    if (missing.length === 0) return;
    setRefusedForms(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !missing.includes(id))));
    setOpenID(previous => previous && missing.includes(previous) ? null : previous);
  }, [queue.rows, refusedForms, setRefusedForms, setActionError, setOpenID]);

  async function refreshRefused(formID: string, current: () => boolean) {
    if (!current()) return false;
    const fresh = await queue.refreshThrough(formID);
    if (current()) setRefusedForms(previous => ({ ...previous, [formID]: fresh ? 'detail' : 'queue' }));
    return fresh;
  }

  function detailLoaded(formID: string) {
    if (refusedForms[formID] !== 'detail') return;
    setRefusedForms(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== formID)));
    setActionError(previous => previous?.formID === formID ? { ...previous, message: t('This filing changed after you opened it (it was resubmitted, or a co-signer joined or withdrew), so it was not approved. What is on file now is shown; review it again before approving.') } : previous);
  }

  async function review(formID: string, memberName: string, action: 'start' | 'approve' | 'return', shown: StewardFormApprovalExpectation | null) {
    await operate(`${action}:${formID}`, async () => {
    if (acceptedForms[formID] || refusedForms[formID]) return;
    const current = requests.capture().isCurrent;

    setActionError(null);
    try {
      await reviewStewardForm(writer, formID, action, note, shown);
      setAcceptedForms(previous => ({ ...previous, [formID]: action }));
      if (await writer.isCurrent() && current()) void haptics.success();
      if (action !== 'start') {
        setOpenID(null);
        setNote('');
      }
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setActionError({ formID, memberName, message: BUSINESS_SAVED_STALE, saved: true }), refresh: async () => { const fresh = await queue.refreshThrough(formID); if (fresh && current()) setAcceptedForms({}); return fresh; } });
    } catch (nextError) {
      if (nextError instanceof StewardFormChangedError) {
        setRefusedForms(previous => ({ ...previous, [formID]: 'queue' }));
        setActionError({ formID, memberName, message: t('This filing changed after you opened it, so it was not approved. Refresh it before reviewing again.') });
        if (await checkBusinessContinuation(writer, current) === 'current') await refreshRefused(formID, current);
        return;
      }
      if (nextError instanceof StewardFormReturnBlockedError) {
        // The website names this refusal; a bare "not updated" left stewards
        // pressing Return again (#9158). Nothing was returned.
        setActionError({ formID, memberName, message: t('This worker already has a draft of this form open, so it was not returned. Approve it, or ask them to finish that draft first.') });
        return;
      }
      setActionError({ formID, memberName, message: nextError instanceof Error ? nextError.message : 'That form was not updated. Try again.' });
    }

    });
  }

  async function refreshAccepted() {
    await operate('refresh', async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) !== 'current') return;
      const refused = Object.keys(refusedForms);
      if (refused.length > 0) {
        for (const formID of refused) {
          if (await checkBusinessContinuation(writer, current) !== 'current') return;
          if (!await refreshRefused(formID, current)) return;
        }
      } else if (await queue.reread() && current()) {
        setAcceptedForms({}); setActionError(null);
      }
    });
  }
  const recovery = Object.keys(acceptedForms).length > 0 || Object.keys(refusedForms).length > 0
    ? <Button label={t('Refresh')} disabled={busy !== null} variant="secondary" onPress={() => void refreshAccepted()} /> : null;
  if (queue.rows === null && queue.error) return <>{recovery}<Failure message={queue.error} onRetry={() => setReload((value) => value + 1)} /></>;
  if (queue.rows === null) return <>{recovery}<StateMessage title="Loading forms review" body="Getting submitted forms." /></>;
  const reviewNames = stewardFormReviewNames(queue.rows, language);
  // A refusal shows inside the open review, beside the buttons the steward
  // just pressed; at the top of a long list it was off screen (#9158).
  // A refusal whose review is no longer listed stays at the top.
  const refusalInReview = actionError !== null && actionError.formID === openID
    && queue.rows.some((row) => row.id === openID);
  return (
    <>
      {recovery}
      <Body muted>Submitted worker forms waiting for review. Drafts stay with the worker.</Body>
      {actionError && (actionError.saved || !refusalInReview) ? actionError.saved ? <Card><Body>{t(BUSINESS_SAVED_STALE)}</Body></Card> : <Failure message={t("{name}'s form: {message}", { name: actionError.memberName, message: actionError.message })} onDismiss={() => setActionError(null)} /> : null}
      {queue.rows.length === 0 && !queue.nextCursor ? <StateMessage title="No forms waiting" body="Submitted forms will appear here for review." /> : null}
      {queue.rows.map((item) => {
        const open = openID === item.id;
        const own = item.userID !== '' && item.userID === userID;
        return (
          <Card key={item.id}>
            <Heading level={3}>{item.memberName}</Heading>
            <Body>{catalogLabel(item.templateLabel)}</Body>
            {'unitName' in item && item.unitName ? <Body>{item.unitName}</Body> : null}
            <Text style={[styles.status, { color: theme.mutedForeground }]}>{statusLabel(item.status)}</Text>
            {open ? (
              <FormReview
                // A new read after each action, so a refusal shows the stored form.
                key={`${item.id}:${reload}:${queue.revision}`}
                item={item}
                own={own}
                note={note}
                setNote={setNote}
                busy={busy}
                disabled={Boolean(acceptedForms[item.id] || refusedForms[item.id])}
                requiresProof={Boolean(refusedForms[item.id])}
                onLoaded={() => detailLoaded(item.id)}
                refusal={actionError?.formID === item.id && !actionError.saved ? actionError.message : null}
                onReview={(action, shown) => { void review(item.id, item.memberName, action, shown); }}
              />
            ) : (
              <Button label={t('Review')} accessibilityLabel={reviewNames.get(item)} disabled={busy !== null || Boolean(acceptedForms[item.id]) || refusedForms[item.id] === 'queue'} onPress={() => { void haptics.select(); setNote(''); setActionError(null); setOpenID(item.id); }} />
            )}
          </Card>
        );
      })}
      <QueueFooter
        shown={queue.rows.length}
        total={queue.total}
        hasMore={queue.nextCursor !== null}
        loadingMore={queue.loadingMore}
        error={queue.rows.length > 0 ? queue.error : null}
        onLoadMore={() => { void queue.loadMore(); }}
      />
    </>
  );
}

function FormReview({ item, own, note, setNote, busy, disabled = false, requiresProof = false, onLoaded, refusal, onReview }: {
  item: StewardFormReviewRow;
  own: boolean;
  note: string;
  setNote: (value: string) => void;
  busy: string | null;
  disabled?: boolean;
  requiresProof?: boolean;
  onLoaded?: () => void;
  refusal: string | null;
  onReview: (action: 'start' | 'approve' | 'return', shown: StewardFormApprovalExpectation | null) => void;
}) {
  const theme = useTheme();
  const { language, t, catalogLabel } = useNativeUi();
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, item.id);
  const proofRef = useRef(requiresProof);
  proofRef.current = requiresProof;
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  // The detail is kept with the row it was read for, so an approval never
  // names a read of an earlier row.
  const [read, setRead] = useState<{ item: StewardFormReviewRow; detail: StewardFormReviewDetail } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const detail = read?.item === item ? read.detail : null;

  useEffect(() => {
    let active = true;
    const ticket = requests.capture();
    const current = () => active && ticket.isCurrent();
    setRead(null);
    setFailed(false);
    void (async () => {
      if (proofRef.current && await checkBusinessContinuation(writer, current) !== 'current') {
        if (current()) setFailed(true);
        return;
      }
      const next = await loadStewardFormReviewDetail(item);
      if (current()) { setRead({ item, detail: next }); loadedRef.current?.(); }
    })().catch(() => { if (current()) setFailed(true); });
    return () => { active = false; };
  }, [attempt, item, writer, requests]);

  if (!detail && !failed) return <StateMessage title="Loading the submitted form" body="Reading the answers and attachments." />;
  if (!detail) return <Failure message="The submitted form did not load. Try again." onRetry={() => setAttempt((value) => value + 1)} />;
  const approvalBlock = stewardFormApprovalBlock(detail);
  return (
    <View style={styles.review}>
      <Body>{detail.templateLabel === item.templateLabel ? catalogLabel(detail.templateLabel) : detail.templateLabel}</Body>
      <Body>{detail.templateVersion === null ? 'Template version is not recorded.' : `Template version ${detail.templateVersion}`}</Body>
      <Body>{formatFormSubmittedAt(detail.submittedAt, language)}</Body>
      {detail.answersUnavailable ? <Body>{approvalBlock}</Body> : detail.lines.map((line) => (
        <View key={`${line.label}:${line.value}`}>
          <Text style={[styles.status, { color: theme.mutedForeground }]}>{line.label}</Text>
          <Body>{line.value}</Body>
        </View>
      ))}
      {detail.filingUnavailable ? <Body>Filing attachments are unavailable right now.</Body> : detail.attachments.length === 0 ? <Body>No filing attachments.</Body> : detail.attachments.map((file) => (
        <Body key={file.id || file.filename}>{file.scanCurrent ? file.filename : `${file.filename} needs a current check.`}</Body>
      ))}
      {detail.cosigners.length > 0 ? <Body>{t('Co-signed by {names}.', { names: detail.cosigners.map((cosigner) => cosigner.name).join(', ') })}</Body> : null}
      {approvalBlock && !detail.answersUnavailable ? <Body>{catalogLabel(approvalBlock)}</Body> : null}
      {own ? <Body muted>This form is yours. Another committee member reviews it.</Body> : (
        <>
          <TextInput
            accessibilityLabel="Note for the worker"
            value={note}
            onChangeText={setNote}
            placeholder="Note, required to return the form"
            placeholderTextColor={theme.quietForeground}
            keyboardAppearance={theme.appearance}
            multiline
            editable={!disabled && busy === null}
            maxLength={4000}
            style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
          />
          {refusal ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{refusal}</Body> : null}
          <View style={styles.actions}>
            {item.status === 'submitted' ? (
              <Button label="Start review" busy={busy === `start:${item.id}`} disabled={disabled || busy !== null} onPress={() => { onReview('start', null); }} />
            ) : null}
            <Button label="Approve" busy={busy === `approve:${item.id}`} disabled={disabled || busy !== null || approvalBlock !== null} onPress={() => { onReview('approve', detail.expectation); }} />
            <Button label="Return with note" variant="secondary" busy={busy === `return:${item.id}`} disabled={disabled || busy !== null || note.trim() === ''} onPress={() => { onReview('return', null); }} />
          </View>
        </>
      )}
    </View>
  );
}

function BroadcastsSection() {
  const { t, catalogLabel, language } = useNativeUi();
  const scope = useDeskScope();
  const [reload, setReload] = useState(0);
  const queue = useStewardQueue<StewardBroadcastRow, StewardBroadcastCursor>(
    scope.key,
    reload,
    'Broadcasts did not load. Try again.',
    (cursor) => loadStewardBroadcasts(cursor),
  );
  // #9609: the send time, in the member's language and on the group's clock
  // (docs/contracts/time-zones-per-group.md). No chapter's own zone reaches
  // the phone yet (#9446), so groupTimeZone answers the zone every group reads
  // while that switch is held; the zone is named beside the time.
  // A stamp the formatter cannot read gives '' and the row shows no line.
  const sentAt = (value: string | null) => (value ? formatZoneInstant(value, language, groupTimeZone(null)) : null) ?? '';

  return (
    <>
      <NoticeComposer scope={scope} onSent={() => setReload((value) => value + 1)} />
      {queue.rows === null && queue.error ? <Failure message={catalogLabel(queue.error)} onRetry={() => setReload((value) => value + 1)} /> : null}
      {queue.rows === null && !queue.error ? <StateMessage title={t('Loading broadcasts')} body={t('Getting broadcasts already sent.')} /> : null}
      {queue.rows?.map((item) => {
        const when = sentAt(item.publishedAt);
        return (
          <Card key={item.id}>
            <Heading level={3}>{item.title}</Heading>
            {when ? <Body muted>{t('Sent {when}', { when })}</Body> : null}
            {item.retracted ? <Body muted>{t('Retracted')}</Body> : null}
          </Card>
        );
      })}
      {queue.rows ? (
        <QueueFooter
          shown={queue.rows.length}
          total={queue.total}
          hasMore={queue.nextCursor !== null}
          loadingMore={queue.loadingMore}
          error={queue.rows.length > 0 ? queue.error : null}
          onLoadMore={() => { void queue.loadMore(); }}
        />
      ) : null}
    </>
  );
}

type FailureAction = { onRetry: () => void; onDismiss?: never } | { onRetry?: never; onDismiss: () => void };

function Failure({ message, onRetry, onDismiss }: { message: string } & FailureAction) {
  const theme = useTheme();
  const { t } = useNativeUi();
  return (
    <Card>
      <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{message}</Body>
      <Button label={t(onDismiss ? 'Dismiss' : 'Try again')} variant="secondary" onPress={onDismiss ?? onRetry} />
    </Card>
  );
}

const styles = StyleSheet.create({
  cardPress: { minHeight: minimumTouchTarget },
  reference: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  status: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  review: { gap: spacing.sm },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  message: { minHeight: 120, textAlignVertical: 'top' },
});
