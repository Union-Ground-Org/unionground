import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import type { NativeUiText } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import { useFocusEffect, useRouter } from 'expo-router';
import { View } from 'react-native';
import { createDemoLearningPeriodApi, createLearningPeriodApi, HISTORY_PAGE, withoutOrganizationControls, type LearningPeriodApi } from '../../../../src/features/learningPeriod/api.js';
import type { LearningEntry, LearningPeriod } from '../../../../src/features/learningPeriod/model.js';
import { bannerState, entryStatus, formatPeriodWhen, kindText, periodPhase, practiceBadge, undoChain, undoRefusalReason, undoSummary } from '../../../../src/features/learningPeriod/model.js';
import { announceLearningUndone } from '../../../../src/features/learningPeriod/undoneSignal.js';
import { learningPeriodText } from '../lib/learningPeriodCopy';
import { formatDateTime } from '../../../../src/lib/i18n/format.js';
import { Body, Button, Card, Heading, Notice } from '../components/ui';
import { createCapturedSessionRpcClient } from '../services/supabase';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';

// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// native parity for the organization learning period. The same shared
// client and model as the web screens, with the same English copy kept in
// apps/mobile so the native graph stays inside its catalogue budget: the
// banner on Home, and on Account the administrator's start and end controls
// and "Your practice history" with Undo. The server decides every refusal.

type Period = LearningPeriod;
type Entry = LearningEntry;

const t = (key: string, vars?: Record<string, string | number>): string => learningPeriodText(key, vars);

// The preview walks the flow on fictional fixtures; one twin per app run so
// an undo on Account is still undone on Home.
let previewApi: LearningPeriodApi | null = null;
const sharedDemoMessage = 'The shared demo cannot change the learning period.';

function organizationControlFailure(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && error.code === 'shared-demo-account'
    ? sharedDemoMessage : t(fallback);
}

export function useNativeLearningPeriodApi(): LearningPeriodApi | null {
  const { mode, session, organizationID, sampleHat, sessionRestricted, locked, privacyCovered, assuranceUnavailable } = useApp();
  return useMemo(() => {
    if (mode === 'preview') return previewApi ??= createDemoLearningPeriodApi();
    if (mode !== 'authenticated' || !session || !organizationID || sessionRestricted || locked || privacyCovered || assuranceUnavailable) return null;
    try {
      const client = createCapturedSessionRpcClient(session);
      const api = createLearningPeriodApi({ rpc: async (name, args) => {
        const { data, error }: { data: unknown; error: PostgrestError | null } = await client.rpc(name, args);
        // The shared client retains codes, but drops PostgREST hints. Keep the
        // server's specific refusal distinct from ordinary permission errors.
        return { data, error: error?.code === '42501' && error.hint === 'shared-demo-account'
          ? { ...error, code: 'shared-demo-account' } : error };
      } });
      return sampleHat ? withoutOrganizationControls(api) : api;
    } catch { return null; }
  }, [mode, session, organizationID, sampleHat, sessionRestricted, locked, privacyCovered, assuranceUnavailable]);
}

// How long after an early end-of-period read the period is read once more.
const LATE_PERIOD_REREAD_MS = 60 * 1000;

const periodEnd = (period: Period | null) => (period?.endAt ? new Date(period.endAt).getTime() : NaN);

export function useNativeLearningPeriod(api: LearningPeriodApi | null) {
  const [period, setPeriod] = useState<Period | null>(null);
  const run = useRef(0);
  // #8790 with a review note (b), as on the web (#8792): a device clock ahead of
  // the server reads the period at its end too early, while the server still
  // says it runs. Such a read schedules one more read a short time later,
  // once per end.
  const lateRead = useRef<{ endAt: string | null; timer: ReturnType<typeof setTimeout> | undefined }>({ endAt: null, timer: undefined });
  const refresh = useCallback(async () => {
    const current = ++run.current;
    if (!api) { setPeriod(null); return; }
    try {
      const next = await api.period();
      if (run.current !== current) return;
      setPeriod(next);
      if (next?.running === true && periodEnd(next) <= Date.now() && lateRead.current.endAt !== next.endAt) {
        lateRead.current.endAt = next.endAt;
        clearTimeout(lateRead.current.timer);
        lateRead.current.timer = setTimeout(() => { void refresh(); }, LATE_PERIOD_REREAD_MS);
      }
      return next !== null;
    } catch { if (run.current === current) setPeriod(null); return false; }
  }, [api]);
  useFocusEffect(useCallback(() => {
    const late = lateRead.current;
    void refresh();
    return () => { run.current += 1; clearTimeout(late.timer); };
  }, [refresh]));
  // Focus cleanup runs only on blur, or while focused, so
  // a late read scheduled on a blurred screen (by the end-timer read below)
  // is cleared, and any read in flight dropped, when the client changes or
  // the screen unmounts, whatever its focus.
  useEffect(() => {
    const late = lateRead.current;
    return () => { run.current += 1; clearTimeout(late.timer); late.endAt = null; };
  }, [refresh]);
  // #8790: a screen left open past the period's end reads the period again
  // then. While the offer is held the server stops returning a period once it
  // ends; with the offer released it keeps the ended one for its 14 days.
  useEffect(() => {
    const end = periodEnd(period);
    const now = Date.now();
    if (!Number.isFinite(end) || end <= now) return undefined;
    const timer = setTimeout(() => { void refresh(); }, Math.min(end - now + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [period, refresh]);
  return { period, phase: periodPhase(period, Date.now()), refresh };
}

export function NativePracticeBadge({ flag, running, mine = false }: { flag: string | null; running: boolean; mine?: boolean }) {
  const badge = practiceBadge(flag, { running, mine });
  if (!badge) return null;
  return <View accessible accessibilityLabel={t(badge.titleKey)}><Body muted>{t(badge.labelKey)}</Body></View>;
}

// Home: when the period ends, in this device's time zone, and the way in.
export function NativeLearningPeriodBanner() {
  const api = useNativeLearningPeriodApi();
  const { period } = useNativeLearningPeriod(api);
  const router = useRouter();
  const state = period ? bannerState(period, Date.now()) : null;
  if (!state) return null;
  const when = formatPeriodWhen(state.when, 'en', t);
  return <Card>
    <Heading level={3}>{state.phase === 'running' ? t('learningPeriod.banner.ends', { when }) : t('learningPeriod.ended', { when })}</Heading>
    {state.phase === 'running' ? <Body>{t('learningPeriod.banner.body')}</Body> : null}
    <Button label={t('learningPeriod.openHistory')} variant="secondary" onPress={() => router.push('/account')} />
  </Card>;
}

function PromiseNotes({ admin = false }: { admin?: boolean }) {
  return <View style={{ gap: spacing.xs }}>
    <Body muted>{t('learningPeriod.promise')}</Body>
    <Body muted>{t('learningPeriod.hiddenNotErased')}</Body>
    <Body muted>{t('learningPeriod.messageRemoval')}</Body>
    <Body muted>{t('learningPeriod.automationPreview')}</Body>
    {admin ? <Body muted>{t('learningPeriod.organizationLevel')}</Body> : null}
  </View>;
}

const LINE_LABEL: Record<string, string | null> = {
  available: null, refused: 'learningPeriod.line.notUndoable', undone: 'learningPeriod.line.undone',
  kept: 'learningPeriod.line.kept', sent: 'learningPeriod.line.sent', final: 'learningPeriod.line.final',
};
const LINE_NOTE: Record<string, string | null> = {
  available: 'learningPeriod.line.available', refused: null, undone: 'learningPeriod.line.undoneNote',
  kept: 'learningPeriod.line.keptNote', sent: 'learningPeriod.line.sentNote', final: 'learningPeriod.line.finalNote',
};

export function NativePracticeHistory({ api, running, onChanged }: { api: LearningPeriodApi; running: boolean; onChanged: () => void }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(api);
  const ui: NativeUiText = useNativeUi().t;
  const [acceptedEntries, setAcceptedEntries] = useBusinessDraftState(() => new Set<string>());
  useEffect(() => { setMessage(''); setConfirmId(null); setRefusals(new Map()); }, [requests]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [serverRunning, setServerRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [refusals, setRefusals] = useState(() => new Map<string, string>());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [refreshing, setRefreshing] = useBusinessState(false);
  const [message, setMessage] = useBusinessDraftState('');
  const run = useRef(0);
  const load = useCallback(async () => {
    const ticket = requests.capture();
    const current = ++run.current;
    setLoading(true); setFailed(false);
    try {
      const history = await api.history(null);
      if (!ticket.isCurrent() || current !== run.current || !history) return;
      setEntries(history.entries); setServerRunning(history.running); setMore(history.entries.length === HISTORY_PAGE);
    } catch { if (ticket.isCurrent() && current === run.current) setFailed(true); }
    finally { if (ticket.isCurrent() && current === run.current) setLoading(false); }
  }, [api, requests]);
  useFocusEffect(useCallback(() => { void load(); return () => { run.current += 1; }; }, [load]));
  async function older() {
    const last = entries.at(-1);
    if (!last) return;
    const ticket = requests.capture();
    const current = ++run.current;
    try {
      const page = await api.history(last.createdAt);
      if (!ticket.isCurrent() || current !== run.current || !page) return;
      setEntries((previous) => [...previous, ...page.entries]); setMore(page.entries.length === HISTORY_PAGE);
    } catch { if (ticket.isCurrent() && current === run.current) setFailed(true); }
  }
  async function undo(entry: Entry) {
    await operate(true, async () => {
    const ticket = requests.capture();
     setMessage('');
    try {
      const takenKinds = [entry.actionKind, ...undoChain(entry.id, entries).map((item) => item.actionKind)];
      if (acceptedEntries.has(entry.id)) return;
      const result = await api.undo(entry.id, entry.version);
      setAcceptedEntries(previous => new Set(previous).add(entry.id));
      setConfirmId(null);
      setMessage(result.status === 'already_undone' ? t('learningPeriod.reason.alreadyUndone')
        : result.undoneCount > 1 ? t('learningPeriod.doneChain', { count: result.undoneCount - 1 }) : t('learningPeriod.done'));
      setRefusals(new Map());
      // The screens showing what was taken back re-read it (undoneSignal.js).
      if (ticket.isCurrent()) announceLearningUndone(takenKinds);
    } catch (error) {
      if (!ticket.isCurrent()) return;
      const reason = undoRefusalReason(error);
      if (reason !== 'learningPeriod.reason.stale') setRefusals((previous) => new Map(previous).set(entry.id, reason));
      setMessage(t(reason));
    } finally {
      if (await checkBusinessContinuation(writer, ticket.isCurrent) === 'current') {
        setConfirmId(null);
        await load();
        if (ticket.isCurrent()) onChanged();
      }
    }

    });
  }
  const live = running && serverRunning;
  return <View style={{ gap: spacing.sm }}>
    <Heading level={3}>{t('learningPeriod.history.title')}</Heading>
    <Button label={ui('Refresh')} disabled={busy} variant="secondary" onPress={() => void operate(true, async () => { setRefreshing(true); try { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current') await load(); } finally { setRefreshing(false); } })} />
    <Body>{t(live ? 'learningPeriod.history.intro' : 'learningPeriod.history.afterEnd')}</Body>
    {loading ? <Body muted>{t('learningPeriod.history.loading')}</Body> : null}
    {message ? <Body accessibilityRole="text">{message}</Body> : null}
    {failed ? <><Notice>{t('learningPeriod.history.failed')}</Notice><Button label={t('learningPeriod.history.retry')} variant="secondary" onPress={() => { void load(); }} /></> : null}
    {!loading && !failed && entries.length === 0 ? <Body>{t('learningPeriod.history.empty')}</Body> : null}
    {entries.map((entry) => {
      const { status, reasonKey } = entryStatus(entry, { running: live, refusals });
      const action = kindText(entry, t);
      const label = LINE_LABEL[status];
      const note = reasonKey ?? LINE_NOTE[status];
      const summary = confirmId === entry.id ? undoSummary(entry.id, entries) : null;
      return <View key={entry.id} testID={`practice-line-${entry.id}`} style={{ gap: spacing.xs }}>
        <Body>{label ? `${action} · ${t(label)}` : action}</Body>
        <Body muted>{formatDateTime(entry.createdAt, 'en')}</Body>
        {note ? <Body muted>{t(note)}</Body> : null}
        {status === 'available' && !acceptedEntries.has(entry.id) && !summary ? <Button label={t('learningPeriod.line.undoLabel', { action })} variant="secondary" onPress={() => setConfirmId(entry.id)} /> : null}
        {summary ? <View style={{ gap: spacing.xs }}>
          <Heading level={3}>{t('learningPeriod.confirm.title')}</Heading>
          {summary.laterSteps > 0 ? <Body>{t(summary.laterSteps === 1 ? 'learningPeriod.confirm.chainOne' : 'learningPeriod.confirm.chainOther', { count: summary.laterSteps })}</Body> : null}
          {summary.staysSent.length > 0 ? <Body>{t('learningPeriod.confirm.staysSentIntro')}</Body> : null}
          {summary.staysSent.map((sent: Entry) => <Body key={sent.id}>{t('learningPeriod.confirm.staysSent', { action: kindText(sent, t) })}</Body>)}
          <Body muted>{t('learningPeriod.confirm.record')}</Body>
          <Button label={t('learningPeriod.confirm.go')} busy={busy && !refreshing} onPress={() => { void undo(entry); }} disabled={Boolean(busy)} />
          <Button label={t('learningPeriod.confirm.cancel')} variant="secondary" disabled={busy} onPress={() => setConfirmId(null)} />
        </View> : null}
      </View>;
    })}
    {more ? <Button label={t('learningPeriod.history.older')} variant="secondary" onPress={() => { void older(); }} /> : null}
  </View>;
}

// Account: the administrator's offer and controls, and the practice history.
export function NativeLearningPeriodCard() {
  const api = useNativeLearningPeriodApi();
  const { period, phase, refresh } = useNativeLearningPeriod(api);
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(api ?? {});
  const ui: NativeUiText = useNativeUi().t;
  const [accepted, setAccepted] = useBusinessDraftState(false);
  useEffect(() => { setFailed(''); setMessage(''); setConfirmEnd(false); }, [requests]);
  const [length, setLength] = useState<7 | 14>(14);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [refreshing, setRefreshing] = useBusinessState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [message, setMessage] = useBusinessDraftState('');
  const [failed, setFailed] = useBusinessDraftState('');
  if (!api || !period || (phase === 'unused' && !period.isAdmin)) return null;
  const when = formatPeriodWhen(period.endAt, 'en', t);
  const sharedDemoRefused = failed === sharedDemoMessage || message === sharedDemoMessage;
  async function start() {
    await operate(true, async () => {
    if (!api || accepted) return;
    const ticket = requests.capture();
     setFailed(''); setMessage('');
    try { const next = await api.start(length); setAccepted(true); setMessage(t('learningPeriod.offer.started', { when: formatPeriodWhen(next?.endAt ?? null, 'en', t) })); }
    catch (error) { if (ticket.isCurrent()) setFailed(organizationControlFailure(error, 'learningPeriod.offer.failed')); }
    finally { if (await checkBusinessContinuation(writer, ticket.isCurrent) === 'current' && await refresh()) setAccepted(false); }

    });
  }
  async function endEarly() {
    await operate(true, async () => {
    if (!api || accepted) return;
    const ticket = requests.capture();
     setMessage('');
    try { await api.endEarly(); setAccepted(true); setMessage(t('learningPeriod.endEarly.done')); setConfirmEnd(false); }
    catch (error) { if (ticket.isCurrent()) setMessage(organizationControlFailure(error, 'learningPeriod.endEarly.failed')); }
    finally { if (await checkBusinessContinuation(writer, ticket.isCurrent) === 'current' && await refresh()) setAccepted(false); }

    });
  }
  return <Card>
    {accepted ? <Button label={ui('Refresh')} disabled={busy} variant="secondary" onPress={() => void operate(true, async () => { setRefreshing(true); try { const current = requests.capture().isCurrent; if (await checkBusinessContinuation(writer, current) === 'current' && await refresh()) setAccepted(false); } finally { setRefreshing(false); } })} /> : null}
    <Heading level={2}>{phase === 'unused' ? t('learningPeriod.offer.title') : t('learningPeriod.title')}</Heading>
    {message ? <Body>{message}</Body> : null}
    {phase === 'unused' ? (sharedDemoRefused ? <Notice>{failed}</Notice> : <>
      <Body>{t('learningPeriod.offer.body')}</Body>
      <Body>{t('learningPeriod.offer.length')}</Body>
      <Button label={t('learningPeriod.offer.days14')} variant="secondary" selected={length === 14} onPress={() => setLength(14)} />
      <Button label={t('learningPeriod.offer.days7')} variant="secondary" selected={length === 7} onPress={() => setLength(7)} />
      <PromiseNotes admin />
      <Body muted>{`${t('learningPeriod.offer.once')} ${t('learningPeriod.offer.verified')}`}</Body>
      {failed ? <Notice>{failed}</Notice> : null}
      <Button label={t('learningPeriod.offer.start')} disabled={accepted} busy={busy && !refreshing} onPress={() => { void start(); }} />
    </>) : <>
      <Body>{phase === 'running' ? (period.isAdmin ? t('learningPeriod.running.admin', { when }) : t('learningPeriod.banner.ends', { when })) : t('learningPeriod.ended', { when })}</Body>
      {phase === 'running' ? <PromiseNotes admin={period.isAdmin} /> : null}
      {phase === 'running' && period.isAdmin && !sharedDemoRefused ? (confirmEnd ? <>
        <Body>{t('learningPeriod.endEarly.confirm')}</Body>
        <Button label={t('learningPeriod.endEarly.go')} variant="danger" busy={busy && !refreshing} onPress={() => { void endEarly(); }} disabled={Boolean(busy)} />
        <Button label={t('learningPeriod.endEarly.cancel')} variant="secondary" disabled={busy} onPress={() => setConfirmEnd(false)} />
      </> : <Button label={t('learningPeriod.endEarly')} variant="secondary" onPress={() => setConfirmEnd(true)} />) : null}
      <NativePracticeHistory api={api} running={phase === 'running'} onChanged={() => { void refresh(); }} />
    </>}
  </Card>;
}
