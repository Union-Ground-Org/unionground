import { SeniorityChapterScope, SeniorityPanel, seniorityOrganizationWide } from "../features/seniority/SeniorityPanel.jsx";
import { EvidenceUpload } from "../components/EvidenceUpload.jsx";
import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { WorkspaceCardTitle, WorkspaceSection, WorkspaceOverview, useWorkspace, useWorkspaceTitle } from "../components/WorkspacePages.jsx";
import { WorkspaceStatusState } from "../components/WorkspaceStatusState.jsx";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect, BusyTextarea } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { ChartColumnBig, Clock3, ListChecks, MessageSquareText, Search, Sparkles } from "lucide-react";
import { CaseworkOperationsPanel } from "../components/CaseworkOperationsPanel.jsx";
import { CaseHistoryTimeline } from "../components/CaseHistoryTimeline.jsx";
import { CaseworkHubPanel } from "../components/CaseworkHubPanel.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { CaseworkSectionHeader, CaseworkTag } from "../components/CaseworkSystem.jsx";
import { PlaneHeader, PlaneKpi } from "../components/PlaneHeader.jsx";
import { SourceTaskAction } from "../components/SourceTaskAction.jsx";
import { ChapterAppointmentsPanel } from "../components/ChapterAppointmentsPanel.jsx";
import { CaseList } from "../components/CaseList.jsx";
import { CaseBulkActions, CaseSelectBox } from "../components/CaseBulkActions.jsx";
import { CaseMacroEditor } from "../components/CaseMacroEditor.jsx";
import { CaseNoteBody, CaseNoteComposer } from "../components/CaseMentions.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { countKey, dateTimeFormat, localeFor } from "../lib/i18n.js";
import { groupCasesByArticle } from "../lib/caseArticles.js";
import { caseOutcomeT } from "../lib/i18n/caseOutcome.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import { withObjectUrl } from "../lib/privateFileAccess.js";
import { useDesk } from "../lib/useDesk.js";
import { useCoordinatorStickyClearance } from "../lib/coordinatorStickyClearance.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { lazyView } from "../lib/lazyView.js";
import { pruneSelection } from "../lib/caseSelection.js";
import { notePreview } from "../lib/notePreview.js";
import {
  DEFAULT_DEADLINE_COLORS, DEFAULT_DEADLINE_LOOKAHEAD, DEFAULT_DEADLINE_RISK, deadlineColorThresholds, deadlineColorTier,
  deadlineLookaheadDays, deadlineRiskSeverity, deadlineRiskThresholds,
} from "../lib/configurableThresholds.js";
import { NextActionsPanel } from "../features/caseSignals/CaseSignals.jsx";
import { coordinatorKpisOnly } from "../lib/deskPrefetch.js";
import "../lib/i18n/features/caseNotesStrings.js";

// Campaign lead — the Issue queue. A real, role-gated plane: reads every open
// issue in the campaign through the coordinator RLS widening plus the
// get_coordinator_kpis aggregate RPC. Unbacked demo affordances are removed
// rather than faked.
//
// The dashboards tile pack — charts, their data tables and the three-aggregate
// read — is the one part of this plane a campaign lead may never open, so it is
// its own chunk. It is lazied here rather than in App.jsx because the whole
// coordinator view is already one chunk: splitting inside it is what keeps the
// queue's first paint free of the charts.
const CaseDashboards = lazyView(() => import("../components/CaseDashboards.jsx").then((module) => ({ default: module.CaseDashboards })));

const QUEUE_PAGE_SIZE = 30;
const TIMELINE_PAGE_SIZE = 40;
const BREAKDOWN_PAGE_SIZE = 30;
const CONTACT_TYPE_KEYS = {
  phone: "coordinator.contactPhone",
  email: "coordinator.contactEmail",
  meeting: "coordinator.contactMeeting",
  letter: "coordinator.contactLetter",
  other: "coordinator.contactOther",
};
const CONTACT_DIRECTION_KEYS = {
  outbound: "coordinator.contactOutbound",
  inbound: "coordinator.contactInbound",
  internal: "coordinator.contactInternal",
};
const OUTCOME_KIND_KEYS = {
  upheld: "coordinator.outcomeUpheld",
  settled: "coordinator.outcomeSettled",
  withdrawn: "coordinator.outcomeWithdrawn",
  denied: "coordinator.outcomeDenied",
  other: "coordinator.outcomeOther",
};

function coordinatorTokenLabel(t, table, value, fallbackKey) {
  const token = String(value || "").trim().toLowerCase();
  return t(table[token] || fallbackKey);
}
const DAY_MS = 86400000;
const STALE_UPDATE_DAYS = 7;

function startOfDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// member_cases.deadline is a date-only column (see isOverdue in memberApi):
// parse it at local noon so the day never shifts across timezones. Bare
// Date.parse would read "YYYY-MM-DD" as UTC midnight — the previous local day
// everywhere west of Greenwich.
function deadlineValue(value) {
  if (!value) return null;
  return dateValue(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
}

// A date-only case deadline stays open until the end of its local day (see
// isOverdue), so it sorts after a timed clock due earlier that same day.
function deadlineSortValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? dateValue(`${value}T23:59:59.999`) : deadlineValue(value);
}

function daysFromToday(value, now) {
  const parsed = deadlineValue(value);
  if (parsed === null) return null;
  return Math.round((startOfDay(parsed).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

// Grievance steps are left out of this edition: no coordinator surface shows
// a stored step (tests/coordinator-view.test.jsx).

function latestUpdate(item) {
  return [...(item.updates || [])]
    .filter((update) => dateValue(update.createdAtValue) !== null)
    .sort((a, b) => dateValue(b.createdAtValue) - dateValue(a.createdAtValue))[0] || null;
}

// REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: the queue ranking reads the
// organization's deadline risk windows and lookahead, and the deadline chips
// read its red/amber thresholds (old defaults: risk 0/7/14, lookahead 7,
// red 5, amber 14). Labels stay calendar-true; only rank and colour move.
const DEFAULT_DEADLINE_THRESHOLDS = Object.freeze({
  colors: DEFAULT_DEADLINE_COLORS, risk: DEFAULT_DEADLINE_RISK, lookahead: DEFAULT_DEADLINE_LOOKAHEAD,
});

function deadlineThresholdsFor(configuration) {
  return {
    colors: deadlineColorThresholds(configuration),
    risk: deadlineRiskThresholds(configuration),
    lookahead: deadlineLookaheadDays(configuration),
  };
}

function urgencyFor(item, now, t, thresholds = DEFAULT_DEADLINE_THRESHOLDS) {
  const days = daysFromToday(item.deadline, now);
  const recent = latestUpdate(item);
  const updateAge = recent ? Math.floor((now.getTime() - dateValue(recent.createdAtValue)) / DAY_MS) : null;

  if (days !== null && days < 0) return { score: 5000 + Math.abs(days), tone: "danger", label: t("coordinator.priorityOverdue") };
  if (days !== null && days <= thresholds.lookahead) {
    const severity = deadlineRiskSeverity(days, thresholds.risk);
    const label = days === 0 ? t("coordinator.priorityToday")
      : days === 1 ? t("coordinator.priorityTomorrow")
        : days <= 7 ? t("coordinator.priorityWeek") : t("coordinator.priorityDueIn", { count: days });
    if (severity === "critical") return { score: 4500 - days, tone: "danger", label };
    if (severity === "high") return { score: 4200 - days, tone: "gold", label };
    if (severity === "medium") return { score: 3500 - days, tone: "gold", label };
  }
  if (!recent) return { score: 3000, tone: "purple", label: t("coordinator.priorityNoUpdate") };
  if (updateAge > STALE_UPDATE_DAYS) return { score: 2000 + updateAge, tone: "purple", label: t("coordinator.priorityFollowUp") };
  return { score: 1000, tone: "green", label: t("coordinator.priorityActive") };
}

// Clock kinds with catalogue names. Union Ground has no grievance
// procedure (owner decision, 2026-10-13), so there is no step clock; any
// other kind the inert database still returns (a legacy procedure clock)
// reads as a plain deadline, never as its raw key.
const CLOCK_KINDS = new Set(["response", "follow_up"]);

function clockSource(row, t) {
  const kind = CLOCK_KINDS.has(row.kind) ? t(`caseHistory.value.kind.${row.kind}`) : t("caseList.deadline");
  return row.label ? `${kind} · ${row.label}` : kind;
}

function clockDateLabel(value, lang) {
  const parsed = deadlineValue(value);
  if (parsed === null) return "";
  // A timed clock shows its time: "due today" alone hides whether it passed.
  const timed = !/^\d{4}-\d{2}-\d{2}$/.test(value);
  return timed
    ? dateTimeFormat(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(parsed))
    : new Date(parsed).toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" });
}

function deadlineStatus(item, now, t, thresholds = DEFAULT_DEADLINE_THRESHOLDS) {
  const days = daysFromToday(item.deadline, now);
  if (days === null) return { tone: "quiet", label: t("coordinator.noDeadline"), days };
  const tier = deadlineColorTier(days, thresholds.colors);
  const tone = tier === "overdue" || tier === "red" ? "danger" : tier === "amber" ? "gold" : "quiet";
  if (days < 0) return { tone, label: t("coordinator.deadlineOverdue"), days };
  if (days === 0) return { tone, label: t("coordinator.deadlineToday"), days };
  if (days === 1) return { tone, label: t("coordinator.deadlineTomorrow"), days };
  if (days <= 7) return { tone, label: t("coordinator.deadlineWeek"), days };
  return { tone, label: tier === "green" ? t("coordinator.deadlineScheduled") : t("coordinator.deadlineDueIn", { count: days }), days };
}

function useReactiveCaseworkDepth(containerRef) {
  const activeRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    if (reduced || coarse) return undefined;

    let frame = 0;
    const reset = (node) => {
      if (!node) return;
      node.style.setProperty("--gq-depth-x", "0");
      node.style.setProperty("--gq-depth-y", "0");
    };
    const onPointerMove = (event) => {
      const target = event.target.closest?.("[data-reactive-depth]");
      if (!target || !container.contains(target)) {
        reset(activeRef.current);
        activeRef.current = null;
        return;
      }
      if (activeRef.current && activeRef.current !== target) reset(activeRef.current);
      activeRef.current = target;
      const rect = target.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
      const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        target.style.setProperty("--gq-depth-x", x.toFixed(3));
        target.style.setProperty("--gq-depth-y", y.toFixed(3));
      });
    };
    const onPointerLeave = () => {
      reset(activeRef.current);
      activeRef.current = null;
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const depth = Math.min(1, window.scrollY / 180);
        container.style.setProperty("--gq-scroll-depth", depth.toFixed(3));
      });
    };

    container.addEventListener("pointermove", onPointerMove, { passive: true });
    container.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("scroll", onScroll);
      reset(activeRef.current);
    };
  }, [containerRef]);
}

// The case panels below are not remounted per case (the
// upload control keeps each case's write lock across a switch). So each
// message is stored with the case it was written for and shown only while that
// case is on screen: never in the next case's first frame, never from a write
// that finished after the switch, and still there when the coordinator comes
// back to the case it belongs to. `set(caseId, value)` writes one.
// One value per case, so a late write for case A never
// replaces the message case B is showing.
function useCaseMessage(caseId, empty = "") {
  const [stored, setStored] = useState(() => new Map());
  const set = useCallback((forCase, value) => setStored((current) => new Map(current).set(forCase, value)), []);
  return [stored.has(caseId) ? stored.get(caseId) : empty, set];
}

function CaseAssignment({ item, api, reload, recordUpdate, onWritten, t }) {
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useCaseMessage(item.id, "");
  const [saved, setSaved] = useCaseMessage(item.id, false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let live = true;
    const caseId = item.id;
    setCandidates(null);
    setError(caseId, "");
    api.loadAssignmentCandidates(caseId)
      .then((rows) => { if (live) setCandidates(rows); })
      .catch(() => { if (live) setError(caseId, t("coordinator.assignmentLoadError")); });
    return () => { live = false; };
  }, [api, item.id, retryKey, t, setError]);

  if (error && candidates === null) return <div className="gq-assignment"><p role="alert" className="gq-assignment__error">{rpcErrorTextAtRender(t, error)}</p><button type="button" onClick={() => setRetryKey((key) => key + 1)}>{t("app.tryAgain")}</button></div>;
  if (candidates === null) return <p className="gq-empty-note" role="status">{t("coordinator.assignmentLoading")}</p>;
  const stewards = candidates.filter((person) => person.roles?.includes("steward"));
  const coordinators = candidates.filter((person) => person.roles?.includes("coordinator"));
  return (
    <form className="gq-assignment" onSubmit={(event) => runBusyWrite(busyWriteRef, "assignment", async () => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const caseId = item.id;
      setBusy(true); setError(caseId, ""); setSaved(caseId, false);
      try {
        await api.assignCase(caseId, { stewardId: String(fields.get("steward")) || null, coordinatorId: String(fields.get("coordinator")) || null });
        onWritten?.();
        const recorded = await recordUpdate();
        await reload();
        setSaved(caseId, recorded ? true : t("accessHistory.updateRecordFailed"));
      } catch {
        setError(caseId, t("coordinator.assignmentSaveError"));
      } finally { setBusy(false); }
    }, event)}>
      <h4 className="gq-panel__title">{t("coordinator.assignmentTitle")}</h4>
      <div className="gq-assignment__grid">
        <label>{t("coordinator.assignmentSteward")}<BusySelect name="steward" defaultValue={item.stewardUserId || ""} pending={busy}><option value="">{t("coordinator.assignmentUnassigned")}</option>{stewards.map((person) => <option key={person.userId} value={person.userId}>{person.fullName}</option>)}</BusySelect></label>
        <label>{t("coordinator.assignmentCoordinator")}<BusySelect name="coordinator" defaultValue={item.coordinatorUserId || ""} pending={busy}><option value="">{t("coordinator.assignmentUnassigned")}</option>{coordinators.map((person) => <option key={person.userId} value={person.userId}>{person.fullName}</option>)}</BusySelect></label>
      </div>
      <label className="gq-assignment__confirm"><BusyInput type="checkbox" required pending={busy} />{t("coordinator.assignmentConfirm")}</label>
      <BusyButton type="submit" pending={busy}>{busy ? t("coordinator.assignmentSaving") : t("coordinator.assignmentSave")}</BusyButton>
      {error && <p role="alert" className="gq-assignment__error">{rpcErrorTextAtRender(t, error)}</p>}
      {saved && <p role="status" className="gq-assignment__saved">{saved === true ? t("coordinator.assignmentSaved") : saved}</p>}
    </form>
  );
}

function CoordinatorCaseWrites({ item, api, reload, recordUpdate, onWritten, t }) {
  // The confirm line says the member will see the outcome (#7195).
  const { lang } = useLang();
  const [busy, setBusy] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const incoming = useMemo(() => ({ status: item.status, deadline: item.deadline || "", articles: item.articles || "" }), [item.status, item.deadline, item.articles]);
  const [editor, setEditor] = useState({ source: incoming, baseline: incoming, draft: incoming });
  useEffect(() => {
    setEditor((current) => {
      if (current.source === incoming) return current;
      const baseline = { ...current.baseline }, draft = { ...current.draft };
      for (const key of Object.keys(incoming)) {
        // Unchanged stale props must not undo an independently confirmed save.
        if (incoming[key] === current.source[key]) continue;
        if (draft[key] === baseline[key]) draft[key] = incoming[key];
        baseline[key] = incoming[key];
      }
      return { source: incoming, baseline, draft };
    });
  }, [incoming]);
  const { draft, baseline } = editor;
  const edit = (name) => (event) => {
    const value = event.target.value;
    setEditor((current) => ({ ...current, draft: { ...current.draft, [name]: value } }));
  };
  // The mention audience is whoever may already be assigned this case, so it
  // is the one list the server will accept. Loading it is what turns the note
  // box into a mention composer; without it the plain box stays.
  const [mentionPeople, setMentionPeople] = useState(null);
  const [mentionsFailed, setMentionsFailed] = useState(false);
  const canMention = Boolean(api?.addCaseNoteWithMentions && api?.loadMentionCandidates);
  useEffect(() => {
    if (!canMention) return undefined;
    let live = true;
    setMentionsFailed(false);
    api.loadMentionCandidates(item.id)
      .then((people) => { if (live) setMentionPeople(people); })
      .catch(() => {
        if (live) {
          setMentionPeople([]);
          setMentionsFailed(true);
        }
      });
    return () => { live = false; };
  }, [api, canMention, item.id]);
  if (!api?.updateCase) return null;
  const submit = (kind, operation, form) => runBusyWrite(busyWriteRef, "case", () => submitNow(kind, operation, form));
  const submitNow = async (kind, operation, form) => {
    if (busy) return;
    setBusy(kind); setError(""); setSaved("");
    try {
      await operation();
      onWritten?.();
      const recorded = await recordUpdate();
      form?.reset();
      setSaved(t(recorded ? "coordinator.writeSaved" : "accessHistory.updateRecordFailed"));
      await reload();
    }
    catch (cause) { setError(rpcErrorKeyStrict(cause, "coordinator.writeFailed")); }
    finally { setBusy(""); }
  };
  return (
    <section className="gq-panel gq-write" aria-labelledby={`gq-write-${item.id}`}>
      <strong className="gq-panel__title" id={`gq-write-${item.id}`}>{t("coordinator.caseActions")}</strong>
      {error && <p className="gq-write__error" role="alert">{rpcErrorTextAtRender(t, error)}</p>}
      {saved && <p className="gq-write__saved" role="status">{saved}</p>}
      <form className="gq-write__form" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const fields = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== baseline[key]));
        submit("case", async () => {
          const result = await api.updateCase(item.id, { ...fields, reason: String(form.get("reason")) });
          setEditor((current) => {
            const next = { ...current.draft, ...fields };
            for (const key of Object.keys(next)) if (result && Object.hasOwn(result, key)) next[key] = result[key] ?? "";
            return { ...current, baseline: next, draft: next };
          });
        });
      }}>
        <h4>{t("coordinator.updateCase")}</h4><label>{t("coordinator.factStatus")}<BusySelect name="status" value={draft.status} onChange={edit("status")} pending={Boolean(busy)}><option value="active">{t("coordinator.statusActive")}</option><option value="resolved">{t("coordinator.statusResolved")}</option></BusySelect></label><label>{t("coordinator.factDeadline")}<BusyInput name="deadline" type="date" min={item.deadline || undefined} value={draft.deadline} onChange={edit("deadline")} pending={Boolean(busy)} /></label><label>{t("cases.contractArticles")}<BusyTextarea name="articles" value={draft.articles} onChange={edit("articles")} pending={Boolean(busy)} maxLength={500} /></label><p>{t("cases.articlesEditHelp")}</p><label>{t("coordinator.changeReason")}<BusyTextarea name="reason" maxLength={1000} required pending={Boolean(busy)} /></label><BusyButton type="submit" pending={Boolean(busy)}>{busy === "case" ? t("coordinator.saving") : t("coordinator.saveChanges")}</BusyButton>
      </form>
      {canMention
        ? <div className="gq-write__form"><h4>{t("coordinator.addNote")}</h4>{/* Stable slot: toggling mentionsFailed must not remount the composer. */}<div>{mentionsFailed ? <p role="status" className="gq-write__error">{t("coordinator.mentionsUnavailable")}</p> : null}</div><CaseNoteComposer caseId={item.id} candidates={mentionPeople || []} busy={Boolean(busy)} t={t} onSubmit={async (caseId, body, mentionIds) => { await api.addCaseNoteWithMentions(caseId, body, mentionIds); onWritten?.(); const recorded = await recordUpdate(); setSaved(t(recorded ? "coordinator.writeSaved" : "accessHistory.updateRecordFailed")); await reload(); }} /></div>
        : <form className="gq-write__form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const f = new FormData(form); submit("note", () => api.addCaseNote(item.id, String(f.get("note"))), form); }}><h4>{t("coordinator.addNote")}</h4><label>{t("caseNotes.staffNoteLabel")}<textarea name="note" maxLength={4000} required /></label><p className="gq-empty-note">{t("caseNotes.noteAudience")}</p><BusyButton type="submit" pending={Boolean(busy)}>{busy === "note" ? t("coordinator.saving") : t("coordinator.addNote")}</BusyButton></form>}
      <form className="gq-write__form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const f = new FormData(form); submit("contact", () => api.logCaseContact(item.id, { type: String(f.get("type")), direction: String(f.get("direction")), summary: String(f.get("summary")), contactedAt: new Date(String(f.get("contactedAt"))).toISOString() }), form); }}><h4>{t("coordinator.logContact")}</h4><div className="gq-write__grid"><label>{t("coordinator.contactType")}<select name="type"><option value="phone">{t("coordinator.contactPhone")}</option><option value="email">{t("coordinator.contactEmail")}</option><option value="meeting">{t("coordinator.contactMeeting")}</option><option value="letter">{t("coordinator.contactLetter")}</option><option value="other">{t("coordinator.contactOther")}</option></select></label><label>{t("coordinator.contactDirection")}<select name="direction"><option value="outbound">{t("coordinator.contactOutbound")}</option><option value="inbound">{t("coordinator.contactInbound")}</option><option value="internal">{t("coordinator.contactInternal")}</option></select></label><label>{t("coordinator.contactTime")}<input name="contactedAt" type="datetime-local" required /></label></div><label>{t("coordinator.contactSummary")}<textarea name="summary" maxLength={2000} required /></label><BusyButton type="submit" pending={Boolean(busy)}>{busy === "contact" ? t("coordinator.saving") : t("coordinator.logContact")}</BusyButton></form>
      <form className="gq-write__form gq-write__form--outcome" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const f = new FormData(form); submit("outcome", () => api.recordCaseOutcome(item.id, { outcome: String(f.get("outcome")), summary: String(f.get("summary")) }), form); }}><h4>{t("coordinator.recordOutcome")}</h4><label>{t("coordinator.outcomeType")}<select name="outcome"><option value="upheld">{t("coordinator.outcomeUpheld")}</option><option value="settled">{t("coordinator.outcomeSettled")}</option><option value="withdrawn">{t("coordinator.outcomeWithdrawn")}</option><option value="denied">{t("coordinator.outcomeDenied")}</option><option value="other">{t("coordinator.outcomeOther")}</option></select></label><label>{t("coordinator.outcomeSummary")}<textarea name="summary" maxLength={4000} required /></label><label className="gq-write__confirm"><input type="checkbox" required />{caseOutcomeT(lang, "caseOutcome.coordinatorConfirm")}</label><BusyButton type="submit" pending={Boolean(busy)}>{busy === "outcome" ? t("coordinator.saving") : t("coordinator.recordOutcome")}</BusyButton></form>
    </section>
  );
}

function CoordinatorCaseFiles({ item, api, reload, recordUpdate, onWritten, t }) {
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [failure, setFailure] = useCaseMessage(item.id, "");
  // `checking` says the bytes are uploaded but not yet attached; `staleFileId`
  // marks the one file whose clean verdict aged out, which one re-check fixes.
  const [phase, setPhase] = useCaseMessage(item.id, "");
  const [staleFileId, setStaleFileId] = useState("");
  if (!api?.openCaseFile) return null;
  // A rejection is a decision about these bytes: permanent, and never dressed
  // up as something the coordinator can retry.
  const describe = (error) => {
    const code = error?.privateFileCode || "";
    if (code === "rejected") return t("uploads.rejected");
    if (code === "rate-limited") return t("uploads.rateLimited");
    if (code === "pending-check") return t("uploads.pendingCheck");
    if (code === "unsupported-format") return t("uploads.unsupportedFormat");
    if (code === "stale") return t("uploads.stale");
    if (code === "popup-blocked") return t("uploads.popupBlocked");
    if (code === "recheck-failed") return t("uploads.recheckFailed");
    return rpcErrorKeyStrict(error, "cases.fileFailed");
  };
  const run = (operation, recordsUpdate = false) => runBusyWrite(busyWriteRef, "files", () => runNow(operation, recordsUpdate));
  const runNow = async (operation, recordsUpdate = false) => {
    if (busy) return;
    const caseId = item.id;
    setBusy(true); setFailure(caseId, ""); setPhase(caseId, ""); setStaleFileId("");
    try {
      await operation(caseId);
      if (recordsUpdate) {
        onWritten?.();
        const recorded = await recordUpdate();
        if (!recorded) setFailure(caseId, t("accessHistory.updateRecordFailed"));
      }
      await reload();
    }
    catch (error) { setFailure(caseId, describe(error)); }
    finally { setBusy(false); setPhase(caseId, ""); }
  };
  const addFile = async (file, options) => {
    const caseId = item.id;
    setFailure(caseId, ""); setPhase(caseId, ""); setStaleFileId("");
    // Let the selection control retain the file on upload failure. Once the
    // upload succeeds, a refresh failure must not invite a duplicate upload.
    const result = await api.addCaseFile(caseId, file, options);
    onWritten?.();
    try {
      const recorded = await recordUpdate();
      if (!recorded) setFailure(caseId, t("accessHistory.updateRecordFailed"));
      await reload();
    } catch (error) { setFailure(caseId, describe(error)); }
    return result;
  };
  // Open the tab synchronously on the tap so Safari/iOS keep the transient
  // user-activation window; awaiting the bytes first (the old code) consumes
  // activation and window.open silently opens nothing there.
  const openFile = (file) => run(async () => {
    // Passing `noopener` can make Safari return null even when it opened the
    // tab. Keep the WindowProxy long enough to navigate it, but sever the
    // opener synchronously before the authenticated read starts.
    const popup = window.open("", "_blank");
    if (!popup) throw Object.assign(new Error("popup-blocked"), { privateFileCode: "popup-blocked" });
    popup.opener = null;
    try {
      const blob = await api.openCaseFile(file);
      // withObjectUrl defers the revoke: the new tab has not fetched the
      // object URL yet when this returns.
      withObjectUrl(blob, (url) => { popup.location = url; });
    } catch (error) {
      popup.close();
      if (error?.privateFileCode === "stale" && api.recheckCaseFile) {
        setStaleFileId(file.id);
        throw error;
      }
      throw error;
    }
  });
  const recheckFile = (file) => run(async (caseId) => {
    setPhase(caseId, "checking");
    try {
      await api.recheckCaseFile(file);
      setStaleFileId("");
    } catch (error) {
      // Keep the affordance: a failed re-check is exactly the state where the
      // coordinator most needs the button to still be there.
      if (error?.privateFileCode !== "rejected") setStaleFileId(file.id);
      throw error?.privateFileCode === "rejected"
        ? error
        : Object.assign(new Error("recheck-failed", { cause: error }), { privateFileCode: "recheck-failed" });
    }
  });
  return <div className="gq-panel case-files"><strong className="gq-panel__title">{t("cases.documents")}</strong><p className="gq-empty-note">{t("caseNotes.staffDocumentsHelp")}</p>{api.addCaseFile && <EvidenceUpload scopeKey={item.id} label={t("cases.addDocument")} disabled={busy} onBusyChange={setBusy} onUpload={addFile} />}{phase === "checking" && <p className="case-files__checking" role="status" aria-live="polite">{t("uploads.checking")}</p>}{failure && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, failure)}</p>}{(item.files || []).length ? <ul className="case-files__list">{item.files.map((file) => <li key={file.id}><span><b>{file.filename}</b><small>{Math.ceil(file.sizeBytes / 1024)} KB</small></span><span className="case-files__actions"><BusyButton type="button" pending={busy} aria-label={`${t("cases.openDocument")}: ${file.filename}`} onClick={() => openFile(file)}>{t("cases.openDocument")}</BusyButton>{staleFileId === file.id && api.recheckCaseFile && <BusyButton type="button" pending={busy} aria-label={`${busy ? t("uploads.rechecking") : t("uploads.recheck")}: ${file.filename}`} onClick={() => recheckFile(file)}>{busy ? t("uploads.rechecking") : t("uploads.recheck")}</BusyButton>}{api.removeCaseFile && <BusyButton type="button" pending={busy} aria-label={`${t("cases.removeDocument")}: ${file.filename}`} onClick={() => run(() => api.removeCaseFile(file), true)}>{t("cases.removeDocument")}</BusyButton>}</span></li>)}</ul> : <p className="case-files__empty">{t("cases.noDocuments")}</p>}</div>;
}

function CaseDetail({ item, t, api = null, reload = async () => {}, recordUpdate = async () => true, onCreateTaskFromSource = null, onOpenTask = null, organizationConfiguration = null }) {
  const { lang } = useLang();
  // The case tools notice belongs to the case it was written for.
  const [caseworkNotice, setCaseworkNotice] = useCaseMessage(item.id, "");
  const [historyRevision, setHistoryRevision] = useState(0);
  const invalidateHistory = () => setHistoryRevision((revision) => revision + 1);
  const facts = [
    [t("coordinator.factMember"), item.memberName],
    [t("coordinator.factReference"), item.reference],
    [t("coordinator.factDeadline"), clockDateLabel(item.deadline, lang)],
    [t("coordinator.factStatus"), item.status === "resolved" ? t("coordinator.statusResolved") : t("coordinator.statusActive")],
  ].filter(([, value]) => value);
  return (
    <div className="gq-detail">
      {onCreateTaskFromSource && <SourceTaskAction sourceKind="case" sourceId={item.id} onCreate={onCreateTaskFromSource} onOpenTask={onOpenTask} className="outline-pill" />}
      <div className="gq-panel">
        <strong className="gq-panel__title">{t("coordinator.facts")}</strong>
        {facts.map(([label, value]) => (
          <div key={label} className="gq-fact">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
        {/* Quiet leadership attribution (SOL-20260813-07). Absent when no
            President review exists — and absent, not "not reviewed", is also
            what a failed review read renders. */}
        {item.review && <p className="gq-review-note">{t("cases.presidentReviewed", { name: item.review.reviewerName, date: item.review.reviewedLabel })}</p>}
      </div>
      <div className="gq-panel">
        <strong className="gq-panel__title">{t("coordinator.timeline")}</strong>
        {item.updates.length === 0 && <p className="gq-empty-note">{t("coordinator.noUpdates")}</p>}
        {item.updates.map((update) => (
          <div key={update.id} className="gq-tl">
            <span className="gq-tl__dot" aria-hidden="true" />
            <div>
              <CaseNoteBody body={update.body} mentions={update.mentions || []} />
              <small>{update.createdAt}</small>
            </div>
          </div>
        ))}
        {item.totalUpdates > item.updates.length && (
          <p className="gq-empty-note">{t("coordinator.updatesShowingRecent", { shown: item.updates.length, total: item.totalUpdates })}</p>
        )}
      </div>
      {(item.contacts || []).length > 0 && <div className="gq-panel"><strong className="gq-panel__title">{t("coordinator.contactLog")}</strong>{item.contacts.map((entry) => <div className="gq-tl" key={entry.id}><span className="gq-tl__dot" aria-hidden="true" /><div><p>{entry.summary}</p><small>{coordinatorTokenLabel(t, CONTACT_TYPE_KEYS, entry.type, "coordinator.contactOther")} · {coordinatorTokenLabel(t, CONTACT_DIRECTION_KEYS, entry.direction, "coordinator.contactOther")} · {entry.contactedAt}</small></div></div>)}</div>}
      {item.outcome && <div className="gq-panel"><strong className="gq-panel__title">{t("coordinator.outcomeRecorded")}</strong><p>{item.outcome.summary}</p><small>{coordinatorTokenLabel(t, OUTCOME_KIND_KEYS, item.outcome.kind, "coordinator.outcomeOther")} · {item.outcome.recordedAt}</small></div>}
      {api?.assignCase && api?.loadAssignmentCandidates && <CaseAssignment item={item} api={api} reload={reload} recordUpdate={recordUpdate} onWritten={invalidateHistory} t={t} />}
      {caseworkNotice && <p role="status">{caseworkNotice}</p>}
      {/* The panel's own notice already read "Case tools updated" by the time
          this runs, so a rejected access-history write has to replace it —
          otherwise the case changes with no entry and no warning. */}
      {api?.loadCaseworkCase && <CaseworkOperationsPanel caseId={item.id} api={api} organizationConfiguration={organizationConfiguration} historyRefreshKey={historyRevision} onNotice={(message) => setCaseworkNotice(item.id, message)} onChanged={async () => { const caseId = item.id; const recorded = await recordUpdate(); if (!recorded) setCaseworkNotice(caseId, t("accessHistory.updateRecordFailed")); await reload(); }} />}
      {api?.loadCaseHistory && !api?.loadCaseworkCase && <CaseHistoryTimeline caseId={item.id} api={api} refreshKey={historyRevision} />}
      <CoordinatorCaseWrites key={item.id} item={item} api={api} reload={reload} recordUpdate={recordUpdate} onWritten={invalidateHistory} t={t} />
      <CoordinatorCaseFiles item={item} api={api} reload={reload} recordUpdate={recordUpdate} onWritten={invalidateHistory} t={t} />
    </div>
  );
}

// List drilldowns are server pages now: the focus predicates live in
// list_coordinator_cases beside the KPI aggregate, so a tile's count and the
// rows below it are two reads of one definition — no client re-derivation.
function KpiBreakdown({ focus, focusState, kpis, onOpenCase, onLoadMore, onClose, t }) {
  // #9533 B-50: articles, not the ways cases typed them. A text row with no
  // article number ("Seniority") stays in the chart but is not an article.
  const articleCount = groupCasesByArticle(kpis.byArticle).filter((row) => row.number != null).length;
  const { lang } = useLang();
  if (!focus) return null;
  const focusedCases = focusState?.cases || [];
  const title = t(`coordinator.breakdown.${focus}`);
  return (
    <section id="coordinator-kpi-breakdown" className="gq-breakdown" aria-label={title} data-reactive-depth="panel">
      <header className="gq-breakdown__head">
        <div>
          <span className="gq-eyebrow"><Sparkles size={14} aria-hidden="true" />{t("coordinator.breakdownLabel")}</span>
          <h2>{title}</h2>
        </div>
        <button type="button" className="gq-close" onClick={onClose}>{t("coordinator.closeBreakdown")}</button>
      </header>
      {focus === "resolution" ? (
        <div className="gq-resolution">
          <strong>{typeof kpis.resolutionRate === "number" ? `${kpis.resolutionRate}%` : "—"}</strong>
          <p>{t("coordinator.resolutionContext")}</p>
          <div className="gq-resolution__facts">
            {typeof kpis.resolved === "number" && <span>{t("coordinator.breakdownResolvedBasis", { resolved: kpis.resolved, total: (kpis.openCases ?? 0) + kpis.resolved })}</span>}
            <span>{t(countKey("coordinator.breakdownArticles", articleCount), { count: articleCount })}</span>
          </div>
        </div>
      ) : (
        <div className="gq-breakdown__list">
          {focusState?.error && <p className="gq-empty-note">{t("coordinator.breakdownError")}</p>}
          {focusedCases.map((item) => (
            <button key={item.id} type="button" className="gq-mini-case" onClick={() => onOpenCase(item.id, item)}>
              <span><strong>{item.memberName}</strong><small>{item.title} · {item.reference}</small></span>
              <span>{clockDateLabel(item.deadline, lang) || t("coordinator.noDeadline")}</span>
            </button>
          ))}
          {focusState?.loading && <p className="gq-empty-note">{t("coordinator.loading")}</p>}
          {!focusState?.loading && !focusState?.error && focusedCases.length === 0 && <p className="gq-empty-note">{t("coordinator.breakdownEmpty")}</p>}
          {focusState?.cursor && !focusState?.loading && (
            <button type="button" className="outline-pill gq-more" onClick={onLoadMore}>{t("coordinator.loadMoreCases")}</button>
          )}
        </div>
      )}
    </section>
  );
}

function ViewTabs({ value, counts, onChange, t, dashboards }) {
  const views = [
    // No procedure board: Union Ground issues have no grievance steps to
    // deal into columns (owner decision, 2026-10-13).
    ["queue", "01", ListChecks, t("coordinator.viewQueue"), counts.queue],
    ["timeline", "02", Clock3, t("coordinator.viewTimeline"), counts.timeline],
    ["outreach", "03", MessageSquareText, t("coordinator.viewOutreach"), counts.outreach],
    // The dashboards tab is offered only by a plane that can actually read the
    // aggregates. The fixture SAMPLE desk serves cases from a seed file and has
    // no chapter-wide aggregate to read, so it keeps the four tabs it has
    // always had rather than advertising a fifth that could only say "no data".
    ...(dashboards ? [["dashboards", "04", ChartColumnBig, t("caseDash.tab"), counts.dashboards]] : []),
  ];
  return (
    <nav className="gq-views" aria-label={t("coordinator.viewsLabel")}>
      {views.map(([id, index, Icon, label, count]) => (
        <RoutedTabLink group="coordinator" value={id} key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          <span className="gq-view__index" aria-hidden="true">{index}</span>
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
          <strong>{count}</strong>
        </RoutedTabLink>
      ))}
    </nav>
  );
}

function LoadedSliceNotice({ loaded, loading, error, onLoadMore, t }) {
  return (
    <aside className="gq-slice" aria-label={t("coordinator.sliceTitle")}>
      <p>{t("coordinator.sliceBody", { count: loaded })}</p>
      {error && <p role="alert">{t("coordinator.sliceError")}</p>}
      <button type="button" className="outline-pill" onClick={onLoadMore} disabled={loading}>
        {loading ? t("coordinator.loading") : error ? t("coordinator.sliceRetry") : t("coordinator.sliceLoadMore")}
      </button>
    </aside>
  );
}

function FocusDocket({ cases, now, onOpenCase, t, thresholds }) {
  const { lang } = useLang();
  const priorities = cases.slice(0, 3);
  return (
    <section className="gq-docket" aria-labelledby="gq-docket-title" data-reactive-depth="panel">
      <header className="gq-docket__head">
        <div>
          <span className="gq-docket__eyebrow"><Clock3 size={14} aria-hidden="true" />{t("coordinator.docketEyebrow")}</span>
          <h2 id="gq-docket-title">{t("coordinator.docketTitle")}</h2>
        </div>
        <div>
          <p>{t("coordinator.docketSub")}</p>
          <CaseworkTag tone="accent">{t("coordinator.docketMethod")}</CaseworkTag>
        </div>
      </header>
      {priorities.length > 0 ? (
        <ol className="gq-docket__list">
          {priorities.map((item, index) => {
            const reason = urgencyFor(item, now, t, thresholds);
            return (
              <li key={item.id}>
                <button type="button" className="gq-docket__case" onClick={() => onOpenCase(item.id)}>
                  <span className="gq-docket__index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className="gq-docket__content">
                    <span className={`gq-reason gq-reason--${reason.tone}`}>{reason.label}</span>
                    <strong>{item.title}</strong>
                    <small>{item.memberName} · {item.reference}</small>
                    <span className="gq-docket__due">{clockDateLabel(item.deadline, lang) || t("coordinator.noDeadline")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : <p className="gq-docket__empty">{t("coordinator.docketEmpty")}</p>}
    </section>
  );
}

function TimelineView({ entries, visibleCount, onMore, selectedId, onSelect, t }) {
  return (
    <section className="gq-workspace gq-workspace--timeline" aria-labelledby="gq-practical-timeline-title" data-reactive-depth="panel">
      <CaseworkSectionHeader id="gq-practical-timeline-title" index="02" eyebrow={t("coordinator.systemEyebrow")} title={t("coordinator.practicalTimelineTitle")} description={t("coordinator.practicalTimelineSub")} />
      <div className="gq-master-timeline">
        {entries.slice(0, visibleCount).map((entry) => (
          <button key={entry.key} type="button" className="gq-master-event" aria-pressed={selectedId === entry.item.id} onClick={() => onSelect(entry.item.id)}>
            <span className={`gq-master-event__dot gq-master-event__dot--${entry.type}`} aria-hidden="true" />
            <span className="gq-master-event__date">{entry.label}</span>
            <span><strong>{entry.title}</strong><small>{entry.item.memberName} · {entry.item.reference}</small></span>
          </button>
        ))}
        {entries.length === 0 && <p className="gq-empty">{t("coordinator.timelineEmpty")}</p>}
      </div>
      {entries.length > visibleCount && <button type="button" className="outline-pill gq-more" onClick={onMore}>{t("coordinator.showMore", { count: entries.length - visibleCount })}</button>}
    </section>
  );
}

function OutreachView({ rows, selectedId, onSelect, now, t }) {
  return (
    <section className="gq-workspace" aria-labelledby="gq-outreach-title">
      <CaseworkSectionHeader id="gq-outreach-title" index="03" eyebrow={t("coordinator.systemEyebrow")} title={t("coordinator.outreachTitle")} description={t("coordinator.outreachSub")} meta={<CaseworkTag>{t("coordinator.outreachHonesty")}</CaseworkTag>} />
      <div className="gq-outreach-grid">
        {rows.map((item) => {
          const recent = latestUpdate(item);
          const age = recent ? Math.max(0, Math.floor((now.getTime() - dateValue(recent.createdAtValue)) / DAY_MS)) : null;
          return (
            <button key={item.id} type="button" className="gq-outreach-card" aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)} data-reactive-depth="card">
              <span className="gq-outreach-card__person"><span className="gq-av" aria-hidden="true">{item.memberInitials}</span><span><strong>{item.memberName}</strong><small>{item.reference}</small></span></span>
              <span className="gq-outreach-card__reason">{recent ? t("coordinator.outreachStale", { count: age }) : t("coordinator.outreachNoUpdate")}</span>
              <span className="gq-outreach-card__title">{item.title}</span>
            </button>
          );
        })}
        {rows.length === 0 && <p className="gq-empty">{t("coordinator.outreachEmpty")}</p>}
      </div>
    </section>
  );
}


export function CoordinatorView(props) {
  const section = useWorkspace()?.section;
  const kpisOnly = coordinatorKpisOnly(section, window.location.search);
  return <CoordinatorDesk key={kpisOnly ? "funnel" : "desk"} {...props} kpisOnly={kpisOnly} />;
}

function CoordinatorDesk({ data, api, seniorityApi = null, accessActor = null, onNotice, onProfile, onAssistant, onOpenTasks = null, onCreateTaskFromSource = null, onOpenTask = null, caseSignals = null, kpisOnly }) {
  const pageTitle = useWorkspaceTitle(null);
  const workspace = useWorkspace();
  const { t, lang } = useLang();
  const organizationConfiguration = data?.organizationConfiguration ?? null;
  const deadlineThresholds = useMemo(() => deadlineThresholdsFor(organizationConfiguration), [organizationConfiguration]);
  const deskApi = useMemo(() => kpisOnly ? { loadDesk: () => api.loadDesk({ kpisOnly: true }) } : api, [api, kpisOnly]);
  const { desk, error, load } = useDesk(deskApi, "app.loadFailed", workspace?.section);
  const [expandedId, setExpandedId] = useDeviceParityState("coordinator.expandedId", null);
  const [filter, setFilter] = useDeviceParityState("coordinator.filter", "");
  const [view, setView] = useRoutedTab("coordinator", "queue");
  const [kpiFocus, setKpiFocus] = useDeviceParityState("coordinator.kpiFocus", null);
  const [visibleCount, setVisibleCount] = useDeviceParityState("coordinator.visibleCount", QUEUE_PAGE_SIZE);
  const [timelineCount, setTimelineCount] = useDeviceParityState("coordinator.timelineCount", TIMELINE_PAGE_SIZE);
  // Selection lives here rather than inside the bar so the same ids survive a
  // reload and can be handed to the export button and every bulk action.
  const [selection, setSelection] = useState([]);
  const depthRef = useRef(null);
  useReactiveCaseworkDepth(depthRef);
  useCoordinatorStickyClearance(depthRef);
  // Day-granular clock: tick once a minute so deadline states, priority order,
  // and outreach ages stay honest across midnight in a long-lived tab.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Server keyset pages appended past the first desk page, plus drilldown
  // cases merged in when a coordinator opens one that lives beyond the loaded
  // queue. Reset whenever the desk itself reloads.
  const [queueExtra, setQueueExtra] = useState({ cases: [], cursor: null });
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState(false);
  // Generation stamp: a desk reload (or language change) invalidates any page
  // fetch still in flight, so a stale response can neither append old rows
  // nor resurrect an old cursor into the fresh desk.
  const queueGen = useRef(0);
  // Layout effect, not a passive one: the first cursor arrives with the desk
  // itself, and the rows it belongs to are painted in that same commit. A
  // passive effect would let the browser paint one frame of facet counts and
  // a results line that do not yet say they describe a window — the exact
  // misreading UX-UG-CASE-LIST-FACET-COUNTS-LOADED-WINDOW-20260917 is
  // about — before flipping them. Running before paint keeps the qualifier on
  // the first painted list, including the first paint after a deep link.
  useLayoutEffect(() => {
    queueGen.current += 1;
    setQueueError(false);
    setQueueExtra({ cases: [], cursor: desk?.nextCursor || null });
  }, [desk]);
  const allCases = useMemo(() => {
    const seen = new Set();
    const merged = [];
    for (const item of [...(desk?.cases || []), ...queueExtra.cases]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }, [desk, queueExtra.cases]);
  // List drilldowns fetch their own server page per focus so the rows agree
  // with the chapter-wide KPI count instead of re-filtering the loaded queue.
  const [focusState, setFocusState] = useState(null);
  const serverFocus = kpiFocus === "open" ? "all" : kpiFocus;
  // Generation stamp for the same reason as the queue's: switching focus while
  // a page (or load-more) is in flight must not let the old focus's response
  // overwrite the new focus's list.
  const focusGen = useRef(0);
  useEffect(() => {
    const gen = ++focusGen.current;
    if (!kpiFocus || kpiFocus === "resolution" || !api.loadCases) {
      setFocusState(null);
      return;
    }
    setFocusState({ loading: true, cases: [] });
    api.loadCases({ focus: kpiFocus === "open" ? "all" : kpiFocus, limit: BREAKDOWN_PAGE_SIZE })
      .then((result) => { if (gen === focusGen.current) setFocusState({ cases: result.cases, cursor: result.nextCursor || null }); })
      .catch(() => { if (gen === focusGen.current) setFocusState({ error: true, cases: [] }); });
  }, [kpiFocus, api, lang]);
  const loadMoreFocus = () => {
    const current = focusState;
    if (!current?.cursor || current.loading || !api.loadCases) return;
    const gen = focusGen.current;
    setFocusState({ ...current, loading: true });
    api.loadCases({ focus: serverFocus, cursor: current.cursor, limit: BREAKDOWN_PAGE_SIZE })
      .then((result) => { if (gen === focusGen.current) setFocusState({ cases: [...current.cases, ...result.cases], cursor: result.nextCursor || null }); })
      .catch(() => { if (gen === focusGen.current) setFocusState({ ...current, loading: false, error: true }); });
  };

  const activeCases = useMemo(() => allCases.filter((item) => item.status === "active"), [allCases]);
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return activeCases;
    return activeCases.filter((item) => [item.memberName, item.title, item.reference, item.caseType].filter(Boolean).some((field) => field.toLowerCase().includes(query)));
  }, [activeCases, filter]);
  const actionQueue = useMemo(() => [...filtered].sort((a, b) => urgencyFor(b, now, t, deadlineThresholds).score - urgencyFor(a, now, t, deadlineThresholds).score || (a.deadline || "9999").localeCompare(b.deadline || "9999")), [filtered, now, t, deadlineThresholds]);
  // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
  // (deadlines list): every saved clock on the loaded open cases, each named by
  // its source, instead of only the case's own deadline under the member's
  // paragraph. Procedural clocks are read for exactly these cases, so the list
  // keeps the desk's organization and access scope.
  const activeCaseIds = useMemo(() => activeCases.map((item) => item.id).sort().join(","), [activeCases]);
  const [clocks, setClocks] = useState({ rows: [], failed: false });
  useEffect(() => {
    const ids = activeCaseIds ? activeCaseIds.split(",") : [];
    if (!ids.length || !api.listOpenCaseDeadlines) { setClocks({ rows: [], failed: false }); return undefined; }
    let live = true;
    Promise.resolve().then(() => api.listOpenCaseDeadlines(ids)).then(
      (rows) => { if (live) setClocks({ rows: Array.isArray(rows) ? rows : [], failed: false }); },
      () => { if (live) setClocks({ rows: [], failed: true }); },
    );
    return () => { live = false; };
    // `desk` is a dependency on purpose: a desk reload after a clock is added,
    // met or waived keeps the same case ids but must read the clocks again.
  }, [api, activeCaseIds, desk]);
  // The ten slots go first to rows inside the organization's deadline window
  // (recently overdue and coming up, soonest first), then to later upcoming
  // rows, then to older overdue ones, most recent first. A clock missed
  // yesterday or an overdue case deadline is never pushed out by rows months
  // away, and a pile of old missed clocks cannot crowd out the week ahead.
  // Overdue means a past case deadline, a missed clock, or a timed clock whose
  // instant has passed. Display overdue rows first. Within each status,
  // procedural clocks and case dates have their own chronological groups
  // (UX-UG-COORDINATOR-UPCOMING-DEADLINES-SPLIT-CLOCKS-FROM-CASE-DATES-20261118):
  // only a clock can be extended, and a mixed list sent coordinators to case
  // dates that cannot. A case date on the same day as an open clock of the
  // same case gives up its slot, but only while that clock is one of the ten
  // shown, so a case date is never hidden behind a clock that is not listed.
  const shownDeadlines = useMemo(() => {
    const byId = new Map(activeCases.map((item) => [item.id, item]));
    const nowMs = now.getTime();
    const dayKey = (caseId, value) => `${caseId}|${startOfDay(deadlineValue(value)).getTime()}`;
    const entries = activeCases.filter((item) => item.deadline && deadlineValue(item.deadline) !== null).map((item) => ({ key: `case-${item.id}`, kind: "case", item, deadline: item.deadline, day: dayKey(item.id, item.deadline), chip: clockDateLabel(item.deadline, lang), source: t("coordinator.clockCase"), overdue: daysFromToday(item.deadline, now) < 0 }));
    for (const row of clocks.rows) {
      const item = byId.get(row.caseId);
      if (!item || deadlineValue(row.dueAt) === null) continue;
      const overdue = row.status === "missed" || deadlineSortValue(row.dueAt) < nowMs;
      entries.push({ key: `clock-${row.id}`, kind: "clock", item, deadline: row.dueAt, day: dayKey(item.id, row.dueAt), chip: clockDateLabel(row.dueAt, lang), source: clockSource(row, t), overdue });
    }
    const byTime = (a, b) => deadlineSortValue(a.deadline) - deadlineSortValue(b.deadline) || a.key.localeCompare(b.key);
    const span = deadlineThresholds.lookahead;
    const inWindow = (entry) => Math.abs(daysFromToday(entry.deadline, now)) <= span;
    const near = entries.filter(inWindow).sort(byTime);
    const later = entries.filter((entry) => !inWindow(entry) && !entry.overdue).sort(byTime);
    const older = entries.filter((entry) => !inWindow(entry) && entry.overdue).sort((a, b) => byTime(b, a));
    const ranked = [...near, ...later, ...older];
    const clockDays = new Set(entries.filter((entry) => entry.kind === "clock").map((entry) => entry.day));
    // Case dates that may give up their slot. One that loses its clock from
    // the ten competes again; the set only shrinks, so this ends.
    const yielding = new Set(entries.filter((entry) => entry.kind === "case" && clockDays.has(entry.day)).map((entry) => entry.key));
    let chosen;
    for (;;) {
      chosen = ranked.filter((entry) => !yielding.has(entry.key)).slice(0, 10);
      const shownClockDays = new Set(chosen.filter((entry) => entry.kind === "clock").map((entry) => entry.day));
      const unshadowed = entries.filter((entry) => yielding.has(entry.key) && !shownClockDays.has(entry.day));
      if (!unshadowed.length) break;
      for (const entry of unshadowed) yielding.delete(entry.key);
    }
    return chosen.sort(byTime);
  }, [activeCases, clocks.rows, t, lang, now, deadlineThresholds]);
  const outreach = useMemo(() => filtered.filter((item) => {
    const recent = latestUpdate(item);
    if (!recent) return true;
    return now.getTime() - dateValue(recent.createdAtValue) > STALE_UPDATE_DAYS * DAY_MS;
  }), [filtered, now]);
  const timelineEntries = useMemo(() => {
    const entries = [];
    for (const item of filtered) {
      if (item.deadline && deadlineValue(item.deadline) !== null) entries.push({ key: `deadline-${item.id}`, item, type: "deadline", value: deadlineValue(item.deadline), label: clockDateLabel(item.deadline, lang), title: t("coordinator.timelineDeadline", { title: item.title }) });
      for (const update of item.updates || []) {
        const value = dateValue(update.createdAtValue);
        if (value !== null) entries.push({ key: `update-${update.id}`, item, type: "update", value, label: update.createdAt, title: notePreview(update.body) });
      }
    }
    return entries.sort((a, b) => b.value - a.value);
  }, [filtered, t, lang]);

  const kpis = desk?.kpis || {};
  // No header summary line: the shared one counts cases in arbitration, and
  // Union Ground has no arbitration (owner decision, 2026-10-13).
  // The dashboards tab counts nothing client-side on purpose: its numbers come
  // from the server aggregates, so the strip shows the desk's own open-case KPI
  // rather than the length of whatever page happens to be loaded.
  const viewCounts = { queue: actionQueue.length, timeline: timelineEntries.length, outreach: outreach.length, dashboards: kpis.openCases ?? 0 };
  // Drilldowns list unfiltered server pages, so opening one must clear the
  // search and page window — and a case beyond the loaded queue merges in
  // first, otherwise it would expand invisibly.
  const recordCaseEvent = useCallback(async (item, action) => {
    if (!api.recordAccess) return true;
    if (!accessActor || !item?.subjectUserId) return false;
    // A coordinator's own case is not a staff access to another member: the
    // access history refuses self-subject events permanently
    // (member_access_events_not_self), so there is nothing to record and the
    // case opens without a write instead of offering a retry that cannot land.
    if (item.subjectUserId === accessActor.userId) return true;
    try {
      const result = await api.recordAccess(accessActor, {
        subjectUserId: item.subjectUserId,
        action,
        entityType: "case",
        entityId: item.id,
      });
      return result?.ok === true;
    } catch {
      return false;
    }
  }, [accessActor, api]);
  const caseRevealIntentRef = useRef(0);
  const invalidateCaseReveal = useCallback(() => {
    caseRevealIntentRef.current += 1;
  }, []);
  useEffect(() => () => { invalidateCaseReveal(); }, [invalidateCaseReveal]);
  const openCaseInQueue = useCallback((id, item = null, { intent, alreadyRecorded = false } = {}) => {
    const selected = item || allCases.find((existing) => existing.id === id);
    const capturedIntent = intent ?? (caseRevealIntentRef.current += 1);
    const reveal = () => {
      if (capturedIntent !== caseRevealIntentRef.current) return;
      if (item && !allCases.some((existing) => existing.id === id)) setQueueExtra((state) => ({ ...state, cases: [...state.cases, item] }));
      setView("queue");
      setFilter("");
      setVisibleCount(Math.max(activeCases.length + 1, QUEUE_PAGE_SIZE));
      setKpiFocus(null);
      setExpandedId(id);
    };
    if (!selected) return Promise.resolve({ recorded: false, revealed: false });
    if (!api.recordAccess || alreadyRecorded) {
      reveal();
      return Promise.resolve({
        recorded: true,
        revealed: capturedIntent === caseRevealIntentRef.current,
      });
    }
    return recordCaseEvent(selected, "viewed_case").then((recorded) => {
      if (recorded) {
        reveal();
        return {
          recorded: true,
          revealed: capturedIntent === caseRevealIntentRef.current,
        };
      }
      onNotice?.(t("accessHistory.recordFailed"));
      return { recorded: false, revealed: false };
    });
  }, [activeCases.length, allCases, api.recordAccess, onNotice, recordCaseEvent, setExpandedId, setFilter, setKpiFocus, setView, setVisibleCount, t]);
  // #9794: next actions read every chapter under an organization-level
  // coordinator grant (the session's organization roles), while this queue
  // reads the open chapter. A next action whose case is not in the loaded
  // queue says so instead of doing nothing; it is not opened another way,
  // because opening a case here writes its access record first.
  const nextActionsScope = (data?.member?.organizationRoles || []).includes("coordinator") ? "organization" : null;
  const openNextActionCase = useCallback((id) => {
    if (allCases.some((item) => item.id === id)) void openCaseInQueue(id);
    else onNotice?.(t("caseSignals.caseOutsideChapterQueue"));
  }, [allCases, onNotice, openCaseInQueue, t]);
  const openCaseInPlace = useCallback((id) => {
    invalidateCaseReveal();
    const selected = allCases.find((item) => item.id === id);
    if (!selected) return undefined;
    if (!api.recordAccess) {
      setExpandedId(id);
      return undefined;
    }
    return recordCaseEvent(selected, "viewed_case").then((recorded) => {
      if (recorded) setExpandedId(id);
      else onNotice?.(t("accessHistory.recordFailed"));
    });
  }, [allCases, api.recordAccess, invalidateCaseReveal, onNotice, recordCaseEvent, setExpandedId, t]);
  const dismissExpandedCase = useCallback(() => {
    invalidateCaseReveal();
    setExpandedId(null);
  }, [invalidateCaseReveal, setExpandedId]);
  // URL navigation is an entry instruction, not durable selection state: the
  // link is consumed exactly once per target for this mount, but it keeps
  // waiting until the projection actually contains that target, so a saved
  // copy or an older projection cannot swallow it. Once a reveal actually
  // happens, refreshed arrays never reopen or replace the row the
  // coordinator is looking at or has closed. Every consumed id stays in the
  // mount-scoped set even after a later ?case=B replace, so Back to A cannot
  // write a second viewed_case. A later manual open/close, query change, or
  // unmount bumps the reveal generation so a stale in-flight write cannot
  // yank the desk. The current ?case= is read during render so a query-only
  // parent rerender (same api, same allCases) still reruns this effect. A
  // canceled reveal is consumed only when the query never left that case
  // (local override). If the query left and came back before the write
  // settled, the id stays retryable and a nonce reruns the effect once; a
  // write that already succeeded is reused so the retry reveals without a
  // second viewed_case.
  const consumedLinkedCasesRef = useRef(new Set());
  const openingLinkedCasesRef = useRef(new Set());
  const queryLeftLinkedCasesRef = useRef(new Set());
  const auditedLinkedCasesRef = useRef(new Set());
  const [linkedRetryNonce, setLinkedRetryNonce] = useState(0);
  let linkedCaseId;
  try { linkedCaseId = new URLSearchParams(window.location.search).get("case"); } catch { linkedCaseId = null; }
  useEffect(() => {
    if ([...openingLinkedCasesRef.current].some((id) => id !== linkedCaseId)) {
      for (const id of openingLinkedCasesRef.current) {
        if (id !== linkedCaseId) queryLeftLinkedCasesRef.current.add(id);
      }
      invalidateCaseReveal();
    }
    if (
      !linkedCaseId
      || consumedLinkedCasesRef.current.has(linkedCaseId)
      || openingLinkedCasesRef.current.has(linkedCaseId)
      || !allCases.some((item) => item.id === linkedCaseId)
    ) {
      return;
    }
    openingLinkedCasesRef.current.add(linkedCaseId);
    const intent = caseRevealIntentRef.current;
    const alreadyRecorded = auditedLinkedCasesRef.current.has(linkedCaseId);
    void openCaseInQueue(linkedCaseId, null, { intent, alreadyRecorded }).then((result) => {
      const queryLeft = queryLeftLinkedCasesRef.current.has(linkedCaseId);
      if (result?.recorded) auditedLinkedCasesRef.current.add(linkedCaseId);
      if (result?.revealed) {
        consumedLinkedCasesRef.current.add(linkedCaseId);
      } else if (result?.recorded && !queryLeft) {
        let current;
        try { current = new URLSearchParams(window.location.search).get("case"); } catch { current = null; }
        if (current === linkedCaseId) consumedLinkedCasesRef.current.add(linkedCaseId);
      }
      openingLinkedCasesRef.current.delete(linkedCaseId);
      queryLeftLinkedCasesRef.current.delete(linkedCaseId);
      if (consumedLinkedCasesRef.current.has(linkedCaseId)) {
        auditedLinkedCasesRef.current.delete(linkedCaseId);
      } else if (queryLeft) {
        let current;
        try { current = new URLSearchParams(window.location.search).get("case"); } catch { current = null; }
        if (current === linkedCaseId) setLinkedRetryNonce((nonce) => nonce + 1);
      }
    });
  }, [allCases, invalidateCaseReveal, linkedCaseId, linkedRetryNonce, openCaseInQueue]);
  // One button walks the whole chapter: the local window expands first, then
  // the keyset cursor fetches the next server page.
  const loadNextChapterPage = () => {
    if (!queueExtra.cursor || !api.loadCases || queueLoading) return Promise.resolve(false);
    const gen = queueGen.current;
    setQueueLoading(true);
    setQueueError(false);
    return api.loadCases({ focus: "all", cursor: queueExtra.cursor })
      .then((result) => {
        if (gen !== queueGen.current) return false;
        setQueueExtra((state) => ({ cases: [...state.cases, ...result.cases], cursor: result.nextCursor || null }));
        return true;
      })
      .catch(() => {
        if (gen === queueGen.current) setQueueError(true);
        return false;
      })
      .finally(() => setQueueLoading(false));
  };
  // A case the live filter just hid can no longer be acted on, so it must not
  // stay silently selected and get swept into the next batch.
  const queueIds = useMemo(() => actionQueue.map((item) => item.id), [actionQueue]);
  useEffect(() => { setSelection((current) => pruneSelection(current, queueIds)); }, [queueIds]);
  // #2101 moved the rows into CaseList, which owns the facets, the sort and
  // the window. "Select all visible" therefore has to mean the page the list
  // is actually painting, so the list reports it instead of the plane slicing
  // its own unfiltered queue.
  const [visibleQueueIds, setVisibleQueueIds] = useState([]);
  // Facet names only, for the export receipt.
  const [queueFilterKeys, setQueueFilterKeys] = useState([]);
  const bulkApi = useMemo(() => ({
    bulkUpdateCases: api?.bulkUpdateCases,
    assignCase: api?.assignCase,
    addCaseNote: api?.addCaseNote,
    loadAssignmentCandidates: api?.loadAssignmentCandidates,
    listMacros: api?.listMacros,
    applyMacro: api?.applyMacro,
    recordCaseExport: api?.recordCaseExport,
  }), [api]);
  const macroApi = useMemo(() => ({
    listMacros: api?.listMacros, saveMacro: api?.saveMacro,
    // Organization-scoped picker for the editor's assign action
    // (UX-UG-CASE-MACRO-EDITOR-RAW-IDS-AND-FREE-TEXT-STEP-20260917).
    loadStaffCandidates: api?.loadStaffCandidates,
  }), [api]);
  // The list owns the window now, so it reports how many filtered rows it is
  // still holding back. Rows in hand widen locally; an exhausted window walks
  // the chapter with the keyset cursor exactly as the old button did.
  const loadMoreQueue = (remainingLocally = 0) => {
    if (remainingLocally > 0) {
      setVisibleCount((count) => count + QUEUE_PAGE_SIZE);
      return;
    }
    void loadNextChapterPage().then((loaded) => {
      if (loaded) setVisibleCount((count) => count + QUEUE_PAGE_SIZE);
    });
  };

  return (
    <div className="screen gq-screen" data-casework-theme="casefile-control" ref={depthRef}>
      <PlaneHeader chapterName={data.member?.chapterName} title={pageTitle || t("coordinator.title")} toolbar>
        <span className="gq-search">
          <Search className="gq-search__icon" size={15} aria-hidden="true" />
          <input className="gq-search__input" type="search" value={filter} onChange={(event) => { setFilter(event.target.value); setVisibleCount(QUEUE_PAGE_SIZE); setTimelineCount(TIMELINE_PAGE_SIZE); }} placeholder={t("coordinator.searchPlaceholder")} aria-label={t("coordinator.searchPlaceholder")} />
        </span>
        {onOpenTasks && <button type="button" className="gq-action" onClick={onOpenTasks}><ListChecks size={16} aria-hidden="true" /><span className="gq-action__label">{t("staff.chapterWork")}</span></button>}
        {onAssistant && <button type="button" className="gq-hbtn phead__btn--assistant" aria-label={t("header.assistant")} onClick={onAssistant}><span aria-hidden="true">✦</span></button>}
        {/* Named visible initials first (#7550, WCAG 2.5.3 Label in Name). */}
        {onProfile && <button type="button" className="gq-hbtn gq-hbtn--avatar" aria-label={`${data.member?.initials ?? "?"} ${t("header.profile")}`} onClick={onProfile}>{data.member?.initials ?? "?"}</button>}
      </PlaneHeader>

      <div className="gq-body">
        {error && <EmptyState><p>{rpcErrorTextAtRender(t, error)}</p><button type="button" className="outline-pill" onClick={load}>{t("app.tryAgain")}</button></EmptyState>}
        {!error && !desk && <div className="gq-loading" role="status"><Sparkles size={18} aria-hidden="true" /><span>{t("coordinator.loading")}</span></div>}
        {!error && desk && (
          <>
            <WorkspaceSection name="overview"><div className="pkpi-grid" role="group" aria-label={t("coordinator.title")}>
              <PlaneKpi label={t("coordinator.kpiQueueOpen")} value={kpis.openCases ?? 0} tone="green" active={kpiFocus === "open"} controls="coordinator-kpi-breakdown" onClick={() => setKpiFocus(kpiFocus === "open" ? null : "open")} />
              <PlaneKpi label={t("coordinator.kpiDueWeek")} value={kpis.dueThisWeek ?? 0} tone="gold" active={kpiFocus === "due"} controls="coordinator-kpi-breakdown" onClick={() => setKpiFocus(kpiFocus === "due" ? null : "due")} />
              <PlaneKpi label={t("coordinator.kpiResolved")} value={typeof kpis.resolutionRate === "number" ? `${kpis.resolutionRate}%` : "—"} tone="purple" active={kpiFocus === "resolution"} controls="coordinator-kpi-breakdown" onClick={() => setKpiFocus(kpiFocus === "resolution" ? null : "resolution")} />
            </div></WorkspaceSection>
          </>
        )}
        {/* #9840: next actions read on their own, so they load in place while
            the queue loads instead of after it. One position in both states,
            so the panel (and any focus in it) stays as the desk arrives; a row
            opens its case once the queue it opens into has loaded. */}
        {!error && caseSignals && <WorkspaceSection name="overview"><NextActionsPanel caseSignals={caseSignals} hat="coordinator" scope={nextActionsScope} onOpenCase={desk ? openNextActionCase : null} /></WorkspaceSection>}
        {!error && desk && (
          <>
            <WorkspaceOverview />
            <WorkspaceSection name="overview"><KpiBreakdown focus={kpiFocus} focusState={focusState} kpis={kpis} onOpenCase={openCaseInQueue} onLoadMore={loadMoreFocus} onClose={() => setKpiFocus(null)} t={t} /></WorkspaceSection>
            <WorkspaceSection name="coordinator-cases"><ViewTabs value={view} counts={viewCounts} onChange={(nextView) => { setView(nextView); setKpiFocus(null); }} t={t} dashboards={Boolean(api.loadCaseDashboards)} /></WorkspaceSection>
            {queueExtra.cursor && <WorkspaceSection name="coordinator-cases"><LoadedSliceNotice loaded={allCases.length} loading={queueLoading} error={queueError} onLoadMore={loadNextChapterPage} t={t} /></WorkspaceSection>}

            {view === "queue" && (
              <div className="gq-grid">
                <WorkspaceSection name="overview"><FocusDocket cases={actionQueue} now={now} onOpenCase={openCaseInQueue} t={t} thresholds={deadlineThresholds} /></WorkspaceSection>
                <WorkspaceSection name="coordinator-cases"><section id="coordinator-cases" className="gq-cases role-section-target" tabIndex="-1" aria-label={t("coordinator.actionTitle")} data-reactive-depth="panel">
                  <header className="gq-cases__head"><span className="gq-cases__key" aria-hidden="true">01</span><span><strong className="gq-cases__title">{t("coordinator.actionTitle")}</strong><small className="gq-cases__sub">{t("coordinator.actionSub")}</small></span><span className="gq-count">{t("gq.openChip", { count: actionQueue.length })}</span></header>
                  <CaseBulkActions rows={actionQueue} visibleIds={visibleQueueIds} selection={selection} onSelectionChange={setSelection} api={bulkApi} t={t} onDone={load} exportPrefix="coordinator-cases" exportFilterKeys={queueFilterKeys} canWrite={Boolean(api?.bulkUpdateCases)} />
                  {activeCases.length === 0 && <p className="gq-empty">{t("coordinator.empty")}</p>}
                  {activeCases.length > 0 && actionQueue.length === 0 && <p className="gq-empty">{t("coordinator.emptyFiltered")}</p>}
                  {/* The queue is the shared faceted list. Expansion is still
                      in place — the row opens the same CaseDetail beneath
                      itself, so the docket, the deadline rail, and the ?case=
                      deep link keep landing on a visible, expanded row. */}
                  {actionQueue.length > 0 && (
                    <CaseList
                      plane="coordinator"
                      rows={actionQueue}
                      visibleCount={visibleCount}
                      expandedCaseId={expandedId}
                      onOpenCase={(item, isOpen) => { if (isOpen) dismissExpandedCase(); else void openCaseInPlace(item.id); }}
                      renderDetail={(item) => <CaseDetail item={item} t={t} api={api} reload={load} recordUpdate={() => recordCaseEvent(item, "updated_case")} onCreateTaskFromSource={onCreateTaskFromSource} onOpenTask={onOpenTask} organizationConfiguration={organizationConfiguration} />}
                      savedViewsApi={api}
                      onNotice={onNotice}
                      // The queue row has always said WHY a case is first;
                      // the docket reads the same function.
                      urgencyOf={(item) => urgencyFor(item, now, t, deadlineThresholds)}
                      // Lane 5.6: the select box rides beside each row trigger,
                      // and the list tells the bar which ids the current page
                      // holds so select-all-visible cannot reach a facet-hidden
                      // row.
                      renderRowLead={(item) => <CaseSelectBox id={item.id} selection={selection} onSelectionChange={setSelection} label={t("caseBulk.selectCase", { reference: item.reference })} />}
                      onVisibleRowsChange={setVisibleQueueIds}
                      onActiveFiltersChange={setQueueFilterKeys}
                      // A cursor means the chapter continues past the loaded
                      // rows, so the facet counts describe a window.
                      countsWindowed={Boolean(queueExtra.cursor)}
                      canLoadMore={Boolean(queueExtra.cursor) && !filter.trim()}
                      loadMoreBusy={queueLoading}
                      onLoadMore={loadMoreQueue}
                      moreLabel={(remaining) => (remaining > 0 ? t("coordinator.showMore", { count: remaining }) : t("coordinator.loadMoreCases"))}
                      formatStatus={(status) => (status === "resolved" ? t("coordinator.statusResolved") : t("coordinator.statusActive"))}
                      formatDeadline={(item) => clockDateLabel(item.deadline, lang) || t("coordinator.noDeadline")}
                    />
                  )}
                </section></WorkspaceSection>

                <div className="gq-side">
                  <WorkspaceSection name="coordinator-deadlines"><section id="coordinator-deadlines" className="gq-card gq-card--due role-section-target" tabIndex="-1" aria-label={t("coordinator.deadlinesTitle")} data-reactive-depth="panel">
                    <header className="gq-card__head"><WorkspaceCardTitle as="span" className="gq-card__title">{t("coordinator.deadlinesTitle")}</WorkspaceCardTitle><span className="gq-card__chip">{t("gq.dueCount", { count: shownDeadlines.length })}</span></header>
                    <p className="gq-card__sub">{t(queueExtra.cursor ? "coordinator.deadlinesSliceSub" : "coordinator.deadlinesSub", { shown: shownDeadlines.length, loaded: allCases.length })}</p>
                    <div className="gq-duelist">
                      {["overdue", "upcoming"].map((bucket) => {
                        const overdue = bucket === "overdue";
                        const deadlines = shownDeadlines.filter((entry) => entry.overdue === overdue);
                        if (!deadlines.length) return null;
                        const groupId = `coordinator-deadlines-${bucket}`;
                        return (
                          <div key={bucket} className="gq-duegroup" role="group" aria-labelledby={groupId}>
                            <p id={groupId} className="gq-duegroup__title">{overdue ? t("coordinator.groupOverdue") : t("coordinator.groupUpcoming")}</p>
                            {[["clock", t("coordinator.groupClocks")], ["case", t("coordinator.groupCaseDates")]].map(([kind, label]) => {
                              const rows = deadlines.filter((entry) => entry.kind === kind);
                              if (!rows.length) return null;
                              const labelId = `${groupId}-${kind}`;
                              return (
                                <div key={kind} className="gq-duegroup" role="group" aria-labelledby={labelId}>
                                  <p id={labelId} className="gq-duegroup__title">{label}</p>
                                  {rows.map((entry) => {
                                    const { item } = entry;
                                    const status = entry.kind === "clock" && overdue
                                      ? { tone: "danger", label: t("coordinator.deadlineOverdue") }
                                      : deadlineStatus(entry, now, t, deadlineThresholds);
                                    return (
                                      <button key={entry.key} type="button" className="gq-duerow" aria-label={`${t("coordinator.openDeadline", { status: status.label, reference: item.reference })}: ${entry.source}`} onClick={() => { void openCaseInQueue(item.id); }}>
                                        <span className={`gq-duechip gq-duechip--${status.tone}`}>{entry.chip}</span>
                                        <span className="gq-duerow__body">
                                          <strong>{entry.source}</strong>
                                          {overdue && <small>{status.label}</small>}
                                          <small>{item.memberName} · {item.reference}</small>
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                    {shownDeadlines.length === 0 && !clocks.failed && <p className="gq-empty-note">{t("coordinator.deadlinesEmpty")}</p>}
                    {clocks.failed && <p className="gq-empty-note" role="status">{t("coordinator.clocksUnavailable")}</p>}
                  </section></WorkspaceSection>
                  {/* REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030 */}
                  {seniorityApi && (data.member?.chapterId || data.member?.organizationId) ? <WorkspaceSection name="coordinator-deadlines"><SeniorityChapterScope api={seniorityApi} defaultChapterId={data.member?.chapterId || null} organizationId={data.member?.organizationId || null} organizationWide={seniorityOrganizationWide(data.member)}>{(chapterId) => <SeniorityPanel api={seniorityApi} chapterId={chapterId} />}</SeniorityChapterScope></WorkspaceSection> : null}
                </div>
              </div>
            )}
            {view === "timeline" && <WorkspaceSection name="coordinator-cases"><TimelineView entries={timelineEntries} visibleCount={timelineCount} onMore={() => setTimelineCount((count) => count + TIMELINE_PAGE_SIZE)} selectedId={expandedId} onSelect={(id) => { if (expandedId === id) dismissExpandedCase(); else void openCaseInPlace(id); }} t={t} /></WorkspaceSection>}
            {view === "outreach" && <WorkspaceSection name="coordinator-cases"><OutreachView rows={outreach} selectedId={expandedId} onSelect={(id) => { if (expandedId === id) dismissExpandedCase(); else void openCaseInPlace(id); }} now={now} t={t} /></WorkspaceSection>}
            {view === "dashboards" && api.loadCaseDashboards && <WorkspaceSection name="coordinator-cases"><Suspense fallback={<p className="gq-empty-note" role="status">{t("caseDash.loading")}</p>}><CaseDashboards api={api} caseListPath="/m/coordinator/cases/queue" onNotice={onNotice} lookaheadDays={deadlineThresholds.lookahead} /></Suspense></WorkspaceSection>}
            {/* The tab is hidden on a desk without the aggregate read, but the
                route still exists, so a pasted /dashboards URL must land on a
                stated refusal rather than on a blank panel. */}
            {view === "dashboards" && !api.loadCaseDashboards && <WorkspaceSection name="coordinator-cases"><section className="cdash"><p className="cdash__status" role="status">{t("caseDash.unavailable")}</p><p className="cdash__status cdash__status--quiet">{t("caseDash.unavailableBody")}</p></section></WorkspaceSection>}
            {/* Validated against the FILTERED set: a case the live filter just
                hid must drop its lingering detail panel too. */}
            {view !== "queue" && expandedId && filtered.some((item) => item.id === expandedId) && <WorkspaceSection name="coordinator-cases"><section className="gq-selected-case" data-reactive-depth="panel"><CaseDetail item={filtered.find((item) => item.id === expandedId)} t={t} api={api} reload={load} recordUpdate={() => recordCaseEvent(filtered.find((item) => item.id === expandedId), "updated_case")} onCreateTaskFromSource={onCreateTaskFromSource} onOpenTask={onOpenTask} organizationConfiguration={organizationConfiguration} /></section></WorkspaceSection>}
            <WorkspaceSection name="coordinator-appointments"><ChapterAppointmentsPanel api={api} onNotice={onNotice} /></WorkspaceSection>
            <WorkspaceSection name="coordinator-macros"><CaseMacroEditor api={macroApi} chapterId={data?.member?.chapterId || null} onNotice={onNotice} /></WorkspaceSection>
            {/* The casework hub on the plane the server actually admits.
                The retaliation-pattern scan demands a
                coordinator/advisor/admin/vp hat, so before this page a
                coordinator could reach them only by ALSO wearing the steward
                hat, while the steward plane painted them for stewards the
                RPCs refuse. Same panel, same chapter read; the bargaining,
                intake and history sections admit a coordinator too. */}
            <WorkspaceSection name="coordinator-casework-hub">{api.loadCaseworkHub && data?.member?.chapterId
              ? <CaseworkHubPanel chapterId={data.member.chapterId} caseOptions={allCases} api={api} onNotice={onNotice} />
              : <WorkspaceStatusState
                title={t("coordinator.caseworkHubUnavailable")}
                body={t("coordinator.caseworkHubUnavailableBody")}
                hint={t("coordinator.caseworkHubWhoFixes")}
                links={[
                  { label: t("coordinator.caseworkHubOpenDesk"), path: "/m/coordinator" },
                  { label: t("coordinator.caseworkHubOpenCases"), path: "/m/coordinator/cases" },
                ]}
              />}</WorkspaceSection>
          </>
        )}
      </div>
    </div>
  );
}
