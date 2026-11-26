import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.jsx";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatEasternTimestamp } from "../../lib/easternTimestamp.js";
import { HISTORY_PAGE } from "./api.js";
import { bannerState, entryStatus, formatPeriodWhen, kindText, periodPhase, practiceBadge, undoChain, undoRefusalReason, undoSummary } from "./model.js";
import { announceLearningUndone } from "./undoneSignal.js";
import "./learningPeriod.css";
import { BusyButton, BusyInput } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// the web screens of the organization learning period. One controller per
// signed-in shell reads the period, and every surface (the banner, the
// practice history, the administrator's start and end controls, the
// Settings entry, the toast link and the Practice badge) reads it through
// this context. Without a provider each surface renders nothing.
const LearningPeriodContext = createContext(null);

export function useLearningPeriod() {
  return useContext(LearningPeriodContext);
}

// api: a createLearningPeriodApi or createDemoLearningPeriodApi client, or
// null when this session has no organization period to read. flags: the
// Practice markers a read already returned, keyed "table:id".
// How long after an early end-of-period read the period is read once more.
const LATE_PERIOD_REREAD_MS = 60 * 1000;

export function useLearningPeriodController({ api, flags = null, scope = api }) {
  const [period, setPeriod] = useState(null);
  // A captured client changes when its token refreshes. That is a recheck of
  // the same session/organization, not a cold boot that may unmount forms.
  // Other callers retain the per-client boundary unless they supply a scope.
  const [settledScope, setSettledScope] = useState(null);
  const initialPeriod = settledScope !== scope ? api?.initialPeriod : undefined;
  const visiblePeriod = initialPeriod !== undefined ? initialPeriod : settledScope === scope ? period : null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const run = useRef(0);
  // A device clock ahead of the server reads the
  // period again at the end too early, while the server still says it runs.
  // Such a read schedules one more read a short time later, once per end.
  const lateRead = useRef({ endAt: null, timer: null });
  const refresh = useCallback(async () => {
    const current = ++run.current;
    if (!api) { setPeriod(null); setSettledScope(scope); return null; }
    try {
      const next = await api.period();
      if (current === run.current) {
        setPeriod(next); setNow(Date.now());
        const end = next?.endAt ? new Date(next.endAt).getTime() : NaN;
        if (next?.running === true && end <= Date.now() && lateRead.current.endAt !== next.endAt) {
          lateRead.current.endAt = next.endAt;
          clearTimeout(lateRead.current.timer);
          lateRead.current.timer = setTimeout(() => { void refresh(); }, LATE_PERIOD_REREAD_MS);
        }
      }
      return next;
    } catch {
      // No organization, no verified session or no period surface: nothing shows.
      if (current === run.current) setPeriod(null);
      return null;
    } finally {
      if (current === run.current) setSettledScope(scope);
    }
  }, [api, scope]);
  useEffect(() => {
    const late = lateRead.current;
    void refresh();
    // Forget the end it was waiting on too, so a client
    // rebuilt inside that minute (a token renewal) schedules its own late read.
    return () => { run.current += 1; clearTimeout(late.timer); late.endAt = null; };
  }, [refresh]);
  // The clock ends the period: re-read the phase when the end passes, and
  // read the period again (#8782): while the offer is held the server stops
  // returning a period once it ends, so the cached one must not linger as
  // "ended"; with the offer released the server keeps the ended period.
  useEffect(() => {
    const end = period?.endAt ? new Date(period.endAt).getTime() : NaN;
    if (!Number.isFinite(end) || end <= now) return undefined;
    const timer = setTimeout(() => { setNow(Date.now()); void refresh(); }, Math.min(end - now + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [period, now, refresh]);
  const phase = periodPhase(visiblePeriod, now);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  return useMemo(() => ({
    pending: Boolean(api) && settledScope !== scope && initialPeriod === undefined,
    api, period: visiblePeriod, phase, now, running: phase === "running", refresh, historyOpen, openHistory, closeHistory,
    flagFor: (table, id) => flags?.get?.(`${table}:${id}`) ?? null,
  }), [api, scope, settledScope, initialPeriod, visiblePeriod, phase, now, refresh, historyOpen, openHistory, closeHistory, flags]);
}

export function LearningPeriodProvider({ value, onNotice = null, children }) {
  const { t } = useLang();
  // Resolve the initial organization read before the shell paints, so the
  // banner and Home share their first frame. Refreshes keep the shell mounted.
  if (value?.pending) return <div className="loading-screen"><p role="status">{t("app.loading")}</p></div>;
  return <LearningPeriodContext.Provider value={value}>
    {children}
    {value?.historyOpen && value.api ? <PracticeHistoryDialog onNotice={onNotice} /> : null}
  </LearningPeriodContext.Provider>;
}

// The toast link for a write made while the period runs: the action's own
// toast is one of the three ways into the practice history.
export function learningToastAction(controller, t) {
  if (!controller?.running) return null;
  return { label: t("learningPeriod.openHistory"), run: () => controller.openHistory() };
}

export function PracticeBadge({ flag, mine = false }) {
  const { t } = useLang();
  const controller = useLearningPeriod();
  const badge = practiceBadge(flag, { running: controller?.running ?? false, mine });
  if (!badge) return null;
  return <span className={`xus-chip lp-badge lp-badge--${badge.tone}`} title={t(badge.titleKey)} data-practice={flag}>
    {badge.titleKey === badge.labelKey ? t(badge.labelKey) : <>
      <span className="sr-only">{t(badge.titleKey)}</span>
      <span aria-hidden="true">{t(badge.labelKey)}</span>
    </>}
  </span>;
}

// The marker for a record a read already returned, by its table and id.
export function PracticeMarker({ table, id }) {
  const controller = useLearningPeriod();
  const flag = controller?.flagFor?.(table, id) ?? null;
  return flag ? <PracticeBadge flag={flag} /> : null;
}

function EndEarlyButton({ onNotice }) {
  const { t } = useLang();
  const controller = useLearningPeriod();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  if (!controller?.running || !controller.period?.isAdmin) return null;
  function end() {
    return runBusyWrite(busyWriteRef, "end", () => endNow());
  }

  async function endNow() {
    setBusy(true);
    try {
      await controller.api.endEarly();
      onNotice?.(t("learningPeriod.endEarly.done"));
      setConfirming(false);
    } catch {
      onNotice?.(t("learningPeriod.endEarly.failed"));
    } finally {
      setBusy(false);
      void controller.refresh();
    }
  }
  return <>
    <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={() => setConfirming(true)}>{t("learningPeriod.endEarly")}</button>
    {confirming ? <ConfirmActionDialog
      title={t("learningPeriod.endEarly.go")}
      effects={[t("learningPeriod.endEarly.confirm")]}
      confirmLabel={t("learningPeriod.endEarly.go")}
      busy={busy}
      onConfirm={() => { void end(); }}
      onClose={() => { if (!busy) setConfirming(false); }}
    /> : null}
  </>;
}

// The banner: when the period ends, in Eastern time (#7649, #7654, #7661),
// with the way into the practice history and, for an administrator, End early.
export function LearningPeriodBanner({ onNotice = null }) {
  const { t, lang } = useLang();
  const controller = useLearningPeriod();
  const state = controller ? bannerState(controller.period, controller.now) : null;
  if (!state) return null;
  const when = formatPeriodWhen(state.when, lang, t);
  return <section className="lp-banner" aria-label={t("learningPeriod.banner.label")} data-phase={state.phase}>
    <div className="lp-banner__text">
      {state.phase === "running" ? <>
        <strong>{t("learningPeriod.banner.ends", { when })}</strong>
        <span>{t("learningPeriod.banner.body")}</span>
      </> : <strong>{t("learningPeriod.ended", { when })}</strong>}
    </div>
    <div className="lp-banner__actions">
      <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={controller.openHistory}>{t("learningPeriod.openHistory")}</button>
      <EndEarlyButton onNotice={onNotice} />
    </div>
  </section>;
}

// The honest promise, said the same way wherever the period is explained.
function PromiseNotes({ admin = false }) {
  const { t } = useLang();
  return <ul className="lp-notes">
    <li>{t("learningPeriod.promise")}</li>
    <li>{t("learningPeriod.hiddenNotErased")}</li>
    <li>{t("learningPeriod.messageRemoval")}</li>
    <li>{t("learningPeriod.automationPreview")}</li>
    {admin ? <li>{t("learningPeriod.organizationLevel")}</li> : null}
  </ul>;
}

// The administrator's offer and controls, in organization settings and on
// the admin home, where a founder lands after accepting the invitation.
export function LearningPeriodAdminCard({ onNotice = null }) {
  const { t, lang } = useLang();
  const controller = useLearningPeriod();
  const [length, setLength] = useState(14);
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [failed, setFailed] = useState(false);
  if (!controller?.period?.isAdmin) return null;
  const { phase, period } = controller;
  function start() {
    return runBusyWrite(busyWriteRef, "start", () => startNow());
  }

  async function startNow() {
    setBusy(true); setFailed(false);
    try {
      const next = await controller.api.start(length);
      onNotice?.(t("learningPeriod.offer.started", { when: formatPeriodWhen(next?.endAt, lang, t) }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      void controller.refresh();
    }
  }
  return <section className="lp-card" aria-labelledby="learning-period-admin-title" data-phase={phase}>
    <h2 id="learning-period-admin-title" className="lp-card__title">{t(phase === "unused" ? "learningPeriod.offer.title" : "learningPeriod.title")}</h2>
    {phase === "unused" ? <>
      <p>{t("learningPeriod.offer.body")}</p>
      <fieldset className="lp-length">
        <legend>{t("learningPeriod.offer.length")}</legend>
        {[14, 7].map((days) => <label key={days} className="lp-length__option">
          <BusyInput type="radio" name="learning-period-length" value={days} checked={length === days} onChange={() => setLength(days)} pending={busy} />
          <span className="lp-length__dot" aria-hidden="true" />
          <span>{t(days === 14 ? "learningPeriod.offer.days14" : "learningPeriod.offer.days7")}</span>
        </label>)}
      </fieldset>
      <PromiseNotes admin />
      <p className="lp-muted">{t("learningPeriod.offer.once")} {t("learningPeriod.offer.verified")}</p>
      {failed ? <p role="alert" className="lp-error">{t("learningPeriod.offer.failed")}</p> : null}
      <div className="lp-actions">
        <BusyButton type="button" className="xus-btn xus-btn--wrap xus-btn--go lp-button" pending={busy} onClick={() => { void start(); }}>{t("learningPeriod.offer.start")}</BusyButton>
      </div>
    </> : phase === "running" ? <>
      <p>{t("learningPeriod.running.admin", { when: formatPeriodWhen(period.endAt, lang, t) })}</p>
      <PromiseNotes admin />
      <div className="lp-actions">
        <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={controller.openHistory}>{t("learningPeriod.openHistory")}</button>
        <EndEarlyButton onNotice={onNotice} />
      </div>
    </> : <>
      <p>{t("learningPeriod.ended", { when: formatPeriodWhen(period.endAt, lang, t) })}</p>
      <p className="lp-muted">{t("learningPeriod.offer.used")}</p>
      <div className="lp-actions">
        <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={controller.openHistory}>{t("learningPeriod.openHistory")}</button>
      </div>
    </>}
  </section>;
}

// The Settings way into the practice history, once the period has run.
export function PracticeHistorySettingsEntry() {
  const { t } = useLang();
  const controller = useLearningPeriod();
  if (!controller?.period?.used) return null;
  return <section className="lp-card" aria-labelledby="learning-period-settings-title">
    <h3 id="learning-period-settings-title" className="lp-card__title">{t("learningPeriod.history.title")}</h3>
    <p>{t(controller.running ? "learningPeriod.history.intro" : "learningPeriod.history.afterEnd")}</p>
    <div className="lp-actions">
      <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={controller.openHistory}>{t("learningPeriod.openHistory")}</button>
    </div>
  </section>;
}

const STATUS_CHIP = {
  available: { chip: "xus-chip--on", label: null, note: "learningPeriod.line.available" },
  refused: { chip: "xus-chip--warn", label: "learningPeriod.line.notUndoable", note: null },
  undone: { chip: "xus-chip--off", label: "learningPeriod.line.undone", note: "learningPeriod.line.undoneNote" },
  kept: { chip: "xus-chip--note", label: "learningPeriod.line.kept", note: "learningPeriod.line.keptNote" },
  sent: { chip: "xus-chip--note", label: "learningPeriod.line.sent", note: "learningPeriod.line.sentNote" },
  final: { chip: "xus-chip--warn", label: "learningPeriod.line.final", note: "learningPeriod.line.finalNote" },
};

export function PracticeHistoryLine({ entry, status, reasonKey, entries, confirming, busy, onAsk, onCancel, onUndo }) {
  const { t, lang } = useLang();
  const action = kindText(entry, t);
  const timestamp = formatEasternTimestamp(entry.createdAt, lang);
  const chip = STATUS_CHIP[status];
  const summary = confirming ? undoSummary(entry.id, entries) : null;
  return <li className="lp-line" data-status={status} data-entry-id={entry.id}>
    <div className="lp-line__head">
      <span className="lp-line__action">{action}</span>
      {chip.label ? <span className={`xus-chip ${chip.chip}`}>{t(chip.label)}</span> : null}
    </div>
    <time className="lp-muted" dateTime={timestamp?.dateTime}>{timestamp?.text}</time>
    {reasonKey ? <p className="lp-line__note">{t(reasonKey)}</p> : chip.note ? <p className="lp-line__note">{t(chip.note)}</p> : null}
    {status === "available" && !confirming ? <div className="lp-actions">
      <button type="button" className="xus-btn xus-btn--wrap lp-button" aria-label={t("learningPeriod.line.undoLabel", { action })} onClick={onAsk}>{t("learningPeriod.line.undo")}</button>
    </div> : null}
    {confirming ? <div className="lp-confirm" role="group" aria-label={t("learningPeriod.confirm.title")}>
      <p className="lp-confirm__title">{t("learningPeriod.confirm.title")}</p>
      {summary.laterSteps > 0 ? <p>{t(summary.laterSteps === 1 ? "learningPeriod.confirm.chainOne" : "learningPeriod.confirm.chainOther", { count: summary.laterSteps })}</p> : null}
      {summary.staysSent.length > 0 ? <>
        <p>{t("learningPeriod.confirm.staysSentIntro")}</p>
        <ul className="lp-confirm__sent">{summary.staysSent.map((sent) => <li key={sent.id}>{t("learningPeriod.confirm.staysSent", { action: kindText(sent, t) })}</li>)}</ul>
      </> : null}
      <p className="lp-muted">{t("learningPeriod.confirm.record")}</p>
      <div className="lp-actions">
        <BusyButton type="button" className="xus-btn xus-btn--wrap lp-button" pending={busy} onClick={onCancel}>{t("learningPeriod.confirm.cancel")}</BusyButton>
        <BusyButton type="button" className="xus-btn xus-btn--wrap xus-btn--go lp-button" pending={busy} onClick={onUndo}>{t("learningPeriod.confirm.go")}</BusyButton>
      </div>
    </div> : null}
  </li>;
}

// "Your practice history": every journalled action of yours, newest first,
// with Undo where the server offers it and the reason where it does not.
export function PracticeHistoryDialog({ onNotice = null }) {
  const { t } = useLang();
  const controller = useLearningPeriod();
  const [state, setState] = useState({ loading: true, failed: false, running: false, entries: [], more: false });
  const [refusals, setRefusals] = useState(() => new Map());
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  const run = useRef(0);
  const api = controller?.api;
  const load = useCallback(async () => {
    const current = ++run.current;
    setState((previous) => ({ ...previous, loading: true, failed: false }));
    try {
      const history = await api.history(null);
      if (current !== run.current) return;
      setState({ loading: false, failed: false, running: history.running, entries: history.entries, more: history.entries.length === HISTORY_PAGE });
    } catch {
      if (current === run.current) setState((previous) => ({ ...previous, loading: false, failed: true }));
    }
  }, [api]);
  useEffect(() => { void load(); return () => { run.current += 1; }; }, [load]);
  async function older() {
    const last = state.entries.at(-1);
    if (!last) return;
    const current = ++run.current;
    try {
      const page = await api.history(last.createdAt);
      if (current !== run.current) return;
      setState((previous) => ({ ...previous, entries: [...previous.entries, ...page.entries], more: page.entries.length === HISTORY_PAGE }));
    } catch {
      if (current === run.current) setState((previous) => ({ ...previous, failed: true }));
    }
  }
  function undo(entry) {
    return runBusyWrite(busyWriteRef, "undo", (release) => undoNow(entry, release));
  }

  async function undoNow(entry, release) {
    setBusy(true); setNotice("");
    try {
      const takenKinds = [entry.actionKind, ...undoChain(entry.id, state.entries).map((item) => item.actionKind)];
      const result = await api.undo(entry.id, entry.version);
      const message = result.status === "already_undone" ? t("learningPeriod.reason.alreadyUndone")
        : result.undoneCount > 1 ? t("learningPeriod.doneChain", { count: result.undoneCount - 1 }) : t("learningPeriod.done");
      setNotice(message);
      onNotice?.(message);
      setRefusals(new Map());
      // The screens showing what was taken back re-read it (undoneSignal.js).
      announceLearningUndone(takenKinds);
    } catch (error) {
      const reason = undoRefusalReason(error);
      // A stale version only means the list moved: reread it and offer again.
      if (reason !== "learningPeriod.reason.stale") setRefusals((previous) => new Map(previous).set(entry.id, reason));
      setNotice(t(reason));
    } finally {
      // The lock ends with the write: once busy clears, the controls are ready
      // again, so the history reload below must not refuse a new Undo.
      release();
      setBusy(false);
      setConfirmId(null);
      await load();
      void controller?.refresh();
    }
  }
  if (!controller) return null;
  const running = state.running && controller.running;
  return <Dialog title={t("learningPeriod.history.title")} onClose={controller.closeHistory} size="detail">
    <div className="lp-history">
      <p>{t(running ? "learningPeriod.history.intro" : "learningPeriod.history.afterEnd")}</p>
      {running ? <PromiseNotes /> : <p className="lp-muted">{t("learningPeriod.promise")}</p>}
      <p role="status" className="lp-status">{state.loading ? t("learningPeriod.history.loading") : notice}</p>
      {state.failed ? <div role="alert" className="lp-error">
        <p>{t("learningPeriod.history.failed")}</p>
        <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={() => { void load(); }}>{t("learningPeriod.history.retry")}</button>
      </div> : null}
      {!state.loading && !state.failed && state.entries.length === 0 ? <p>{t("learningPeriod.history.empty")}</p> : null}
      {state.entries.length > 0 ? <ol className="lp-lines">
        {state.entries.map((entry) => {
          const { status, reasonKey } = entryStatus(entry, { running, refusals });
          return <PracticeHistoryLine key={entry.id} entry={entry} status={status} reasonKey={reasonKey} entries={state.entries}
            confirming={confirmId === entry.id} busy={busy}
            onAsk={() => setConfirmId(entry.id)} onCancel={() => setConfirmId(null)} onUndo={() => { void undo(entry); }} />;
        })}
      </ol> : null}
      {state.more ? <button type="button" className="xus-btn xus-btn--wrap lp-button" onClick={() => { void older(); }}>{t("learningPeriod.history.older")}</button> : null}
    </div>
  </Dialog>;
}
