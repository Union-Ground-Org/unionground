import { WorkspaceCardTitle, WorkspaceSection, WorkspaceOverview, useWorkspace, useWorkspaceTitle } from "../components/WorkspacePages.jsx";
import { WorkspaceStatusState } from "../components/WorkspaceStatusState.jsx";
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import { Dialog } from "../components/Dialog.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import "./stewardRequests.css";
import { SourceTaskAction } from "../components/SourceTaskAction.jsx";
import { FormFilingControls } from "../components/FormFilingControls.jsx";
import { FilerSignatureKindNote, cosignerNamesWithKind } from "../components/SignatureKindNote.jsx";
import { PlaneHeader, PlaneKpi } from "../components/PlaneHeader.jsx";
import { QueuePager } from "../components/QueuePager.jsx";
import { StewardAppointmentsPanel } from "../components/StewardAppointmentsPanel.jsx";
import { MessageActions } from "../components/MessageActions.jsx";
import { CameraCheckinScanner } from "../components/CameraCheckinScanner.jsx";
import { CaseworkOperationsPanel } from "../components/CaseworkOperationsPanel.jsx";
import { CaseHistoryTimeline } from "../components/CaseHistoryTimeline.jsx";
import { StewardPrivateReminders } from "../components/StewardPrivateReminders.jsx";
import { StewardCaseNoteForm, StewardDeadlineList } from "../features/caseNotes/StewardCaseNotes.jsx";
import { StewardCaseIntake } from "../features/caseIntake/StewardCaseIntake.jsx";
import { CaseDetailsSummary } from "../features/caseIntake/CaseDetailsFields.jsx";
import { BidDeadlines, SeniorityChapterScope, SeniorityPanel, seniorityOrganizationWide } from "../features/seniority/SeniorityPanel.jsx";
import { AnnouncementDrafts } from "../components/AnnouncementDrafts.jsx";
import { BroadcastPublishConfirm, broadcastLanguageKey, otherBroadcastLocale } from "../components/BroadcastPublishConfirm.jsx";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog.jsx";
import { CaseworkHubPanel } from "../components/CaseworkHubPanel.jsx";
import { CaseList } from "../components/CaseList.jsx";
import { caseTypeLabel } from "../lib/caseRowLine.js";
import { CaseBulkActions, CaseSelectBox } from "../components/CaseBulkActions.jsx";
import { CaseNoteBody } from "../components/CaseMentions.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatCount } from "../lib/formatCount.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { READ_STATES, readResult } from "../lib/readResult.js";
import { useDesk } from "../lib/useDesk.js";
import { usePagedQueue } from "../lib/usePagedQueue.js";
import { localeFor } from "../lib/i18n.js";
import { templateByKey, templateFromDbRow } from "../lib/formTemplates.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { rpcErrorText } from "../lib/rpcErrorText.js";
import { EventTextCount } from "../components/EventTextCount.jsx";
import { EVENT_FORM_LIMITS, MESSAGE_EVENT_CODE_LIMIT } from "../lib/eventFormLimits.js";
import { keepOneParagraph, oneParagraph } from "../lib/eventSummary.js";
import { ConversationLegalHoldControls } from "../components/ConversationLegalHoldControls.jsx";
import { lazyView } from "../lib/lazyView.js";
import { deadlineLookaheadDays } from "../lib/configurableThresholds.js";
import { pruneSelection } from "../lib/caseSelection.js";
import { notePreview } from "../lib/notePreview.js";
import { canOfferSourceTask, isDeliveredMessage } from "../features/messaging/sourceTask.js";
import { useLandOnMessage } from "../features/messaging/useLandOnMessage.js";
import { isPermissionRefusal, isSourceGone, mergeLandedMessage } from "../features/connectedWorkflows/landing.js";
import { StewardAmbientHint } from "../features/memberHome/StewardAmbientHint.jsx";
import { IssueSignalsStaffPanel } from "../features/issueIntelligence/IssueSignals.jsx";
import { AttentionBadge, AttentionPanel, NextActionsPanel, useAttentionVisit, useStewardAttention } from "../features/caseSignals/CaseSignals.jsx";
import { configuredWorkloadCategories, withConfiguredWorkloadCategories } from "../lib/workloadConfiguration.js";
import { createNoticeDraft, noticeKeyReused } from "../lib/noticePublishKey.js";

// Same chunk as the coordinator's dashboards tab: the module is imported by
// specifier from both planes, so Rollup emits it once and the second plane to
// open it pays nothing.
const CaseDashboards = lazyView(() => import("../components/CaseDashboards.jsx").then((module) => ({ default: module.CaseDashboards })));

// The two casework-hub methods the server reserves for a coordinator hat.
// casework_scan_retaliation_patterns demands coordinator/advisor/admin/vp on
// the chapter, and
// casework_review_retaliation_pattern demands the same on the chapter or the
// organization. A steward who does not also wear one of those hats is refused
// with 42501, which the sensitive-content client rewrites into "Sensitive
// content is unavailable" — an outage sentence for a permission that was never
// granted. Withholding the methods is the same treatment caseBulkApi gives
// macros below; the hub hides a control whose method is absent.
const CASEWORK_OVERSIGHT_METHODS = ["scanRetaliationPatterns", "reviewRetaliationPattern"];
const CASEWORK_OVERSIGHT_ROLES = ["coordinator", "advisor", "admin", "vp"];

// PR7: the steward desk renders in the steward's own language like every other
// member surface — a steward is a member with an extra tab, not a separate
// English-only console. Dates route through the active locale too.
function shortDate(value, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" }).format(new Date(value));
}

// Status → catalogue key. The RPC statuses are stable machine values; the label
// is looked up per render so it follows the steward's language.
const STATUS_KEY = { requested: "steward.statusRequested", acknowledged: "steward.statusAcknowledged", closed: "steward.statusClosed" };
const FORM_STATUS_KEY = { submitted: "steward.formStatusSubmitted", in_review: "steward.formStatusInReview" };

// Chip tone per machine status. "Needs you" is the amber chip, "in hand" the
// mint one, "settled" the neutral one — the same three tones the prototype's
// stage chips use. Unknown statuses fall through to neutral rather than being
// styled as urgent.
const QUEUE_CHIP = { requested: "cwk-chip--new", acknowledged: "cwk-chip--live", closed: "cwk-chip--rest" };
const FORM_CHIP = { submitted: "cwk-chip--new", in_review: "cwk-chip--live" };

// Caseload (UB-CASE-05): the desk lists exactly the cases where this steward
// is the named assignee — the loader's .eq(steward_user_id) mirrors the RLS
// predicate. Same machine-status → catalogue-key + chip-tone treatment as the
// request queue.

// Case machine-status → catalogue key. The shared case list renders the
// label through these so the steward's caseload keeps its localized status
// column (the old card rows used the same keys).
const CASE_STATUS_KEY = { active: "steward.caseStatusActive", resolved: "steward.caseStatusResolved" };

// UB-DESK-01: the four desk queues page server-side (keyset walks with
// search/filter/sort in SQL). These are the params the desk's own first page
// is fetched with — usePagedQueue adopts that page while a queue's controls
// sit on their defaults, and refetches from the server the moment they move.
const REQUEST_DEFAULTS = { status: "all", search: "", sort: "newest" };
const THREAD_DEFAULTS = { filter: "all", search: "" };
const FORM_DEFAULTS = { status: "all", search: "", sort: "oldest" };
const BROADCAST_DEFAULTS = { filter: "all", search: "" };

// One compact toolbar per paged queue: a debounced search box, filter chips,
// and (where the server sorts) a sort toggle. The debounce lives here so
// every panel gets it for free; the functional setParams keeps an identical
// value from refiring the hook's fetch effect.
function QueueToolbar({ label, searchPlaceholder, query, chips = null, chipKey = "status", sortLabels = null }) {
  const [text, setText] = useState(query.params.search || "");
  const setParams = query.setParams;
  useEffect(() => {
    const timer = setTimeout(() => {
      setParams((prev) => (prev.search === text ? prev : { ...prev, search: text }));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, setParams]);
  return (
    <div className="cwk-toolbar" role="group" aria-label={label}>
      <input
        type="search"
        className="cwk-toolbar__search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
      />
      {chips && chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          className={`cwk-btn ${query.params[chipKey] === chip.value ? "cwk-btn--soft" : "cwk-btn--ghost"}`}
          aria-pressed={query.params[chipKey] === chip.value}
          onClick={() => setParams((prev) => (prev[chipKey] === chip.value ? prev : { ...prev, [chipKey]: chip.value }))}
        >
          {chip.label}
        </button>
      ))}
      {sortLabels && (
        <button
          type="button"
          className="cwk-btn cwk-btn--ghost cwk-toolbar__sort"
          onClick={() => setParams((prev) => ({ ...prev, sort: prev.sort === "newest" ? "oldest" : "newest" }))}
        >
          {sortLabels[query.params.sort]}
        </button>
      )}
    </div>
  );
}

// QueuePager — the honest "showing N of M" + Load more tail — moved to
// src/components/QueuePager.jsx when the appointments panel became the fifth
// paged list (sol  F9).

// `get_form_filing_status` reports the ledger verdict for each attachment
// (`scanCurrent`) using the very predicate `approve_form` gates on. Naming the
// files it is refusing for — rather than saying "an attachment" — is what turns
// the refusal into an action the reviewer can take.
function staleFilingAttachments(readiness) {
  return (readiness?.status?.attachments || []).filter((row) => row?.scanCurrent === false);
}

// Wave 2e (pixel-match, prototype pg.casework): the desk adopts the shared
// staff-plane anatomy — PlaneHeader's .ph strip and PlaneKpi's accent-left
// tiles — and the Wave-2b `.strip-head` placeholder retires with it (this was
// its last consumer). The desk keeps its own name in the strip's title and puts
// its two non-identity actions in the strip's trailing slot: Compass, and the
// chapter-work entrance that used to sit in a `.plane-tools` row below it.
// onProfile is the top bar's avatar and is still not read here. Every casework
// callback, busy key and RPC is untouched.
//
// Three renders, one layout: a real steward opens this inside the member shell
// on the desktop AND on a 390px phone, and the demo opens it as a staff plane.
// The two-column prototype grid collapses to one below 900px for the last two.
// The plane header's actions, shared by the desk and the appointments page so
// Compass and Chapter work stay reachable on every steward page.
function StewardHeaderActions({ t, onAssistant, onOpenTasks }) {
  return <>
    {onAssistant && (
      <button type="button" className="cwk-iconbtn phead__btn--assistant" aria-label={t("header.assistant")} onClick={onAssistant}>
        <span aria-hidden="true">✦</span>
      </button>
    )}
    {/* The way into the chapter-work staff tool: Tasks left the member tab
        bar, so this button — never an overflow
        item — is its entrance from the plane that runs chapter work. Wave
        2e moves it out of the `.plane-tools` row into the plane header's
        action slot; it is the same callback on the same condition. The
        label rides in its own span because at phone widths it is visually
        hidden — the Case queue action's glyph-pill treatment — so the
        strip title stops competing with however long the label is in the
        active language, while the accessible name never changes. */}
    {onOpenTasks && (
      <button type="button" className="cwk-btn cwk-btn--green cwk-btn--strip" onClick={onOpenTasks}>
        <span className="cwk-btn__ic" aria-hidden="true"><ClipboardList size={16} /></span>
        <span className="cwk-btn__label">{t("staff.chapterWork")}</span>
      </button>
    )}
  </>;
}

// Mounted inside the Broadcasts section, so it leaves with the broadcast form
// (WorkspaceSection unmounts the section while StewardDeskView stays): leaving
// the page abandons the form's draft key and its open confirmation, and a form
// that comes back starts a new notice . Retries inside the same form
// keep the key. A publish still waiting for its answer keeps the key
//: its notice may already be posted, so the same words published
// again from the returning form are the same operation and the server answers
// with the notice it holds. The key still ends on a confirmed publication,
// and on the next departure once nothing is running.
function BroadcastFormLifetime({ draft, inFlight, setPublishConfirm, setActiveDraftId }) {
  useEffect(() => () => {
    if (!inFlight.current) draft.cancel();
    setPublishConfirm(null);
    setActiveDraftId(null);
  }, [draft, inFlight, setPublishConfirm, setActiveDraftId]);
  return null;
}

// A failure the server answered carries its code (a PostgREST or SQL state).
// A reply that never arrived (a dropped connection, a timeout) reaches the
// client with the empty code supabase-js gives a failed request, and its
// notice may have been posted . A refusal the page made itself has no
// code at all and keeps its own message.
function broadcastAnswerLost(error) {
  return error?.code === "";
}

export function StewardView(props) {
  const { t } = useLang();
  const workspace = useWorkspace();
  const title = useWorkspaceTitle(null);
  // This independently authorized reader must not wait for requests, forms,
  // messages and casework to load before a steward can publish weekly hours.
  if (workspace?.section === "steward-appointments") {
    return <div className="screen cwk-screen">
      <PlaneHeader title={title} chapterName={props.data?.member?.chapterName}><StewardHeaderActions t={t} onAssistant={props.onAssistant} onOpenTasks={props.onOpenTasks} /></PlaneHeader>
      <div className="cwk-plane"><StewardAppointmentsPanel api={props.api} onNotice={props.onNotice} /></div>
    </div>;
  }
  const linkedTarget = new URLSearchParams(window.location.search);
  const wholeDesk = linkedTarget.has("case") || linkedTarget.has("thread");
  const overviewOnly = workspace?.section === "overview" && !wholeDesk;
  const requestsOnly = workspace?.section === "steward-requests" && !wholeDesk;
  // Keep the desk instance through queue navigation so an in-flight
  // broadcast keeps its operation key until its result is known.
  return <StewardDeskView key={overviewOnly ? "overview" : "desk"} {...props} overviewOnly={overviewOnly} requestsOnly={requestsOnly} />;
}

function useStewardQueue(seed, fetcher, defaults, reload) {
  const query = usePagedQueue(seed, fetcher, defaults);
  // Older API doubles can only retry the full desk. Production queues own
  // their retry, including the current filter and its request generation.
  return fetcher ? query : { ...query, retry: reload };
}


const STEWARD_REQUEST_SECTIONS = new Set(["overview", "steward-requests"]);
function StewardDeskView({ data, accessActor = null, onAssistant, api, onNotice, overviewOnly, requestsOnly, seniorityApi = null, onOpenTasks = null, onCreateTaskFromSource = null, onResolveSourceTask = null, renderConnectedActions = null, onOpenTask = null, canCreateMessageEvent = null, officerQa = null, learningContent = null, issueSignals = null, caseSignals = null }) {
  const pageTitle = useWorkspaceTitle(null);
  const workspace = useWorkspace();
  const { t, lang } = useLang();
  const [fullDeskOpened, setFullDeskOpened] = useState(!requestsOnly);
  const loadRequestsOnly = requestsOnly && !fullDeskOpened;
  useEffect(() => {
    if (!requestsOnly) setFullDeskOpened(true);
  }, [requestsOnly]);
  const deskApi = useMemo(() => ({
    loadDesk: async () => ({
      value: await api.loadDesk(loadRequestsOnly ? { requestsOnly: true } : { overviewOnly }),
      requestsOnly: loadRequestsOnly,
    }),
  }), [api, overviewOnly, loadRequestsOnly]);
  const { desk: loaded, error: deskError, load } = useDesk(deskApi, "steward.deskLoadFailed", workspace?.section);
  // A requests-only read cannot supply the next page's other queues.
  const desk = loaded?.requestsOnly && !requestsOnly ? null : loaded?.value;
  // A write that finishes after navigation refreshes the scope now visible.
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const reload = useCallback(() => latestLoad.current(), []);
  // The hub reads one chapter's casework records; without that backing the
  // page says so (APP-STEWARD-12).
  const caseworkHubReady = Boolean(api.loadCaseworkHub && data.member?.chapterId);
  // The request and profile counts belong to the overview and Member requests.
  // On the other desk pages they read as counts of the content on those pages.
  const requestFigures = !workspace || STEWARD_REQUEST_SECTIONS.has(workspace.section);
  const [threadId, setThreadId] = useDeviceParityState("steward.threadId", null);
  // `?thread=<id>&message=<id>` names one exact message inside the thread. It is
  // a one-shot landing instruction for that thread's dialog, dropped when the
  // steward opens a thread by hand.
  const [landing, setLanding] = useState(null);
  // A thread the paged queue never loaded is hydrated exactly (api.loadSourceLanding)
  // under the steward's own scope: { threadId, thread, message }. `landingStatus`
  // is how that request stands: null | "loading" | "unavailable" | "failed".
  const [landed, setLanded] = useState(null);
  const [landingStatus, setLandingStatus] = useState(null);
  const landingRun = useRef(0);
  const landingTarget = useRef(null);
  const [formId, setFormId] = useDeviceParityState("steward.formId", null);
  const [caseId, setCaseId] = useDeviceParityState("steward.caseId", null);
  const [requestId, setRequestId] = useDeviceParityState("steward.requestId", null);
  const [caseSelection, setCaseSelection] = useState([]);
  const [filingReadiness, setFilingReadiness] = useState({ formId: null, loading: false, status: null, error: "" });
  // A SET of in-flight keys, not one key. A single string cannot describe two
  // actions at once: acknowledging request A and then closing request B
  // overwrote the first key, and whichever call settled first cleared it — so B's
  // button re-enabled while B was still in flight, and the double-fire this
  // guard exists to prevent was two clicks away.
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  // The controls above stay focusable while their write runs, so
  // each write takes a synchronous lock before React commits its busy state.
  // A lock ends in the same finally that clears its busy key.
  const busyWriteRef = useRef(new Set());
  const [publishBusy, setPublishBusy] = useState(false);
  // REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001: a draft the steward loaded
  // into the composer is marked published once the broadcast goes out.
  const composerRef = useRef(null);
  const [activeDraftId, setActiveDraftId] = useState(null);
  // One operation key for the broadcast being written, from its first Publish
  // until it is confirmed posted; another signed-in person, a loaded
  // draft or leaving the Broadcasts page (BroadcastFormLifetime) starts a new one.
  const broadcastDraft = useRef(null);
  broadcastDraft.current ??= createNoticeDraft();
  // True from the moment a broadcast is sent until its answer is in, set
  // before the request so no render gap lets a departure through .
  const broadcastInFlight = useRef(false);
  // While it runs, leaving the Steward desk by a link, a desk switch or Back
  // waits (src/lib/navigationGuard.js), so the attempt's key and the page
  // that reports its outcome stay; closing the tab asks first.
  useEffect(() => {
    const hold = (event) => {
      if (!broadcastInFlight.current) return;
      event.preventDefault();
      onNotice(t("steward.publishHold"));
    };
    const unload = (event) => {
      if (!broadcastInFlight.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("sg:before-navigate", hold);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("sg:before-navigate", hold);
      window.removeEventListener("beforeunload", unload);
    };
  }, [onNotice, t]);
  const [publishConfirm, setPublishConfirm] = useState(null);
  // The language still owed after "publish now and write the other next",
  // tied to the broadcast just published. Loading a saved draft clears it,
  // and the confirmation lets the steward say the next broadcast is a
  // different announcement, so an unrelated draft never closes the pair
  // (gate r2).
  const [pairPending, setPairPending] = useState(null);
  const [draftsRevision, setDraftsRevision] = useState(0);
  const [scanBusy, setScanBusy] = useState(false);
  const scanBusyRef = useRef(false);
  const scanFormRef = useRef(null);
  const scanTokenRef = useRef(null);
  const cameraScannerRef = useRef(null);
  // The member event feed also carries explicit history. Door check-in must
  // offer only live/upcoming events; a completed event is useful context on
  // the calendar but is never a valid scan destination.
  const upcomingCheckinEvents = useMemo(() => (data.events || []).filter((event) => event.isPast !== true), [data.events]);
  const [emailIntakes, setEmailIntakes] = useState([]);
  const [emailIntakeStatus, setEmailIntakeStatus] = useState("pending");
  const [emailIntakeLoading, setEmailIntakeLoading] = useState(Boolean(api.listEmailIntakes));
  const [emailIntakeError, setEmailIntakeError] = useState(false);
  const emailIntakeVisible = !workspace || workspace.section === "steward-email-intake";

  // Paged queues (UB-DESK-01): the desk load carries page one of each list
  // plus its keyset cursor and TRUE filtered total; the hooks own everything
  // after that. Old api doubles without the pager methods degrade to the
  // seeded page (the hook never fetches with a null fetcher).
  const requestSeed = useMemo(() => (desk ? { rows: desk.queue, cursor: desk.queueCursor ?? null, total: desk.queueTotal ?? desk.queue.length, error: desk.requestsUnavailable } : null), [desk]);
  const threadSeed = useMemo(() => (desk ? { rows: desk.threads, cursor: desk.threadsCursor ?? null, total: desk.threadsTotal ?? desk.threads.length, error: desk.threadsUnavailable } : null), [desk]);
  const formSeed = useMemo(() => (desk ? { rows: desk.formsInbox || [], cursor: desk.formsCursor ?? null, total: desk.formsTotal ?? (desk.formsInbox || []).length, error: desk.formsUnavailable } : null), [desk]);
  const broadcastSeed = useMemo(() => (desk ? { rows: desk.broadcasts, cursor: desk.broadcastsCursor ?? null, total: desk.broadcastsTotal ?? desk.broadcasts.length, error: desk.broadcastsUnavailable } : null), [desk]);
  const requestFetch = useCallback((opts) => api.loadRequests(opts), [api]);
  const threadFetch = useCallback((opts) => api.loadThreads(opts), [api]);
  const formFetch = useCallback((opts) => api.loadForms(opts), [api]);
  const broadcastFetch = useCallback((opts) => api.loadBroadcasts(opts), [api]);
  const requestsQ = useStewardQueue(requestSeed, api.loadRequests ? requestFetch : null, REQUEST_DEFAULTS, reload);
  const threadsQ = useStewardQueue(threadSeed, api.loadThreads ? threadFetch : null, THREAD_DEFAULTS, reload);
  // A hold placed or released from the open dialog is reflected on its list
  // row immediately; the next page fetch carries the server's own answer.
  const [holdOverrides, setHoldOverrides] = useState({});
  const threadRows = useMemo(
    () => threadsQ.rows.map((row) => (row.id in holdOverrides ? { ...row, legalHold: holdOverrides[row.id] } : row)),
    [threadsQ.rows, holdOverrides],
  );
  const formsQ = useStewardQueue(formSeed, api.loadForms ? formFetch : null, FORM_DEFAULTS, reload);
  const broadcastsQ = useStewardQueue(broadcastSeed, api.loadBroadcasts ? broadcastFetch : null, BROADCAST_DEFAULTS, reload);
  const [recentReadCounts, setRecentReadCounts] = useState(() => new Map());
  const [readCountsError, setReadCountsError] = useState("");

  useEffect(() => {
    // The live loader and pager already include exact page-scoped counts.
    // Legacy or failed page counts alone need the newest-20 fallback.
    setReadCountsError("");
    if (!api.getBroadcastReadCounts || !broadcastsQ.rows.some((row) => row.readCount == null)) return undefined;
    let cancelled = false;
    api.getBroadcastReadCounts()
      .then((rows) => {
        if (cancelled) return;
        setRecentReadCounts(new Map((Array.isArray(rows) ? rows : []).map((item) => [item.broadcastId, item.readCount])));
      })
      .catch((error) => {
        if (cancelled) return;
        setRecentReadCounts(new Map());
        setReadCountsError(error?.message || t("steward.readCountsUnavailable"));
      });
    return () => { cancelled = true; };
  }, [api, broadcastsQ.rows, t]);

  const loadEmailIntakes = useCallback(async () => {
    if (!api.listEmailIntakes) return;
    setEmailIntakeLoading(true);
    setEmailIntakeError(false);
    try {
      const rows = await api.listEmailIntakes(emailIntakeStatus);
      setEmailIntakes(Array.isArray(rows) ? rows : []);
    } catch {
      setEmailIntakeError(true);
    } finally {
      setEmailIntakeLoading(false);
    }
  }, [api, emailIntakeStatus]);

  useEffect(() => {
    if (!emailIntakeVisible) return;
    loadEmailIntakes();
  }, [loadEmailIntakes, emailIntakeVisible]);

  // One lock per intake row: every action on the row reads pending while any
  // of them runs, so a second action on the same row is refused too.
  function reviewEmailIntake(id, action) {
    return runBusyWrite(busyWriteRef, `email-${id}`, () => reviewEmailIntakeNow(id, action));
  }

  async function reviewEmailIntakeNow(id, action) {
    const key = `email-${id}-${action}`;
    setBusyKeys((current) => new Set(current).add(key));
    try {
      await api.reviewEmailIntake(id, action);
      await loadEmailIntakes();
      onNotice(t("steward.emailIntakeUpdated"));
    } catch (error) {
      onNotice(error.message || t("steward.emailIntakeActionFailed"));
    } finally {
      setBusyKeys((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }

  // Per-key, not global: the desk marks each triage/retract button pending by
  // its own id, so a second click on the SAME action must be a no-op while a
  // different one stays available. Each caller takes that key's lock
  // (runBusyWrite) before run commits the busy key.
  async function run(work, success, busyKey) {
    setBusyKeys((prev) => new Set(prev).add(busyKey));
    try {
      await work();
      await reload();
      onNotice(success);
    } catch (error) {
      onNotice(error.message || t("steward.actionFailed"));
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }

  // One triage path for the row and the request detail: the same api call,
  // busy key and confirmation either way.
  // Closing a request and retracting a broadcast change what a member sees,
  // so each opens a confirmation first (APP-STEWARD-11, -14); acknowledging
  // a request stays one tap.
  const [confirmClose, setConfirmClose] = useState(null);
  const [confirmRetract, setConfirmRetract] = useState(null);
  function triageOrConfirm(item, action) {
    if (action === "close") { setConfirmClose(item); return undefined; }
    return triageRequest(item, action);
  }

  function triageRequest(item, action) {
    const closing = action === "close";
    const busyKey = `${closing ? "close" : "ack"}-${item.id}`;
    return runBusyWrite(busyWriteRef, busyKey, () => run(async () => {
      await api.triage(item.id, action);
      // A closed row can leave the Open filter on reload. Dismiss its detail
      // after the confirmed write so the cached row cannot offer stale actions.
      if (closing) setRequestId((current) => current === item.id ? null : current);
    }, t(closing ? "steward.requestClosed" : "steward.requestAcknowledged"), busyKey));
  }

  // Submitting the composer only opens the confirmation; the broadcast goes
  // out from there once the steward has stated the bilingual step
  // (BroadcastPublishConfirm, APP-STEWARD-11).
  function requestPublish(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get("title") || "").trim();
    const body = String(formData.get("body") || "").trim();
    const locale = formData.get("locale") === "es" ? "es" : "en";
    if (!title || !body || publishBusy) return;
    setPublishConfirm({ form, title, body, locale, pairedTitle: pairPending?.locale === locale ? pairPending.title : null });
  }

  function publish(followUp, completedPair = false) {
    return runBusyWrite(busyWriteRef, "publish", () => publishNow(followUp, completedPair));
  }

  async function publishNow(followUp, completedPair) {
    const pending = publishConfirm;
    if (!pending) return;
    const { form, title, body, locale } = pending;
    broadcastInFlight.current = true;
    setPublishBusy(true);
    try {
      const operationKey = broadcastDraft.current.start(data?.member?.id ?? null);
      await api.publish(title, body, locale, undefined, operationKey);
      broadcastDraft.current.confirm();
      if (activeDraftId && api.resolveDraft) {
        await Promise.resolve(api.resolveDraft(activeDraftId, "published")).catch(() => null);
        setActiveDraftId(null);
        setDraftsRevision((value) => value + 1);
      }
      setPublishConfirm(null);
      await reload();
      form.reset();
      // A new "write the other next" owes a fresh pair; a completed pair owes
      // nothing; a different announcement leaves the owed pair as it was.
      setPairPending((current) => followUp ? { locale: otherBroadcastLocale(locale), title } : completedPair ? null : current);
      if (completedPair) {
        onNotice(t("broadcastConfirm.pairDone"));
      } else if (followUp) {
        // The other language is next: the composer switches to it and keeps
        // the published text beside the steward to translate from.
        form.elements.locale.value = otherBroadcastLocale(locale);
        form.elements.title.value = title;
        form.elements.body.value = body;
        form.elements.title.focus();
        onNotice(t("broadcastConfirm.writeOther", { other: t(broadcastLanguageKey(otherBroadcastLocale(locale))) }));
      } else {
        onNotice(t("steward.published"));
      }
    } catch (error) {
      if (noticeKeyReused(error)) {
        // This draft's first version is already posted; the server refused the
        // edited one. Say so, and let Publish send the edit as a new notice.
        broadcastDraft.current.cancel();
        setPublishConfirm(null);
        onNotice(t("notices.firstVersionPosted"));
        void reload();
        return;
      }
      if (error?.code === "notice_audience_unavailable") onNotice(t("notices.audienceUnavailable"));
      // A lost answer is not a refusal: the notice may be posted. Say so, and
      // that publishing again is safe: every try carries the draft's key.
      else if (broadcastAnswerLost(error)) onNotice(t("steward.publishUnconfirmed"));
      else onNotice(error.message || t("steward.publishFailed"));
    } finally {
      broadcastInFlight.current = false;
      setPublishBusy(false);
    }
  }

  // Scanner: redeem a member's short-lived check-in code. Attendance is a
  // service record, not a reward or participation score, so the notice names
  // who was checked in and never a points total.
  async function redeemCheckin(eventId, token, form) {
    if (!eventId || !token || scanBusyRef.current) return;
    scanBusyRef.current = true;
    setScanBusy(true);
    try {
      const result = await api.scan(eventId, token);
      // UB-EVT-05, finding 1: lead with WHO. Only a name can surface a code
      // redeemed against the wrong person, which is the one error a committee
      // member at a door needs to catch while the person is still standing
      // there. The name is only omitted when the server genuinely has none.
      const name = typeof result?.memberName === "string" ? result.memberName.trim() : "";
      const statusPart = result?.alreadyCheckedIn ? t("steward.scanAlready") : t("steward.scanCheckedIn");
      onNotice(name ? `${name} — ${statusPart}` : statusPart);
      form?.reset();
    } catch (error) {
      onNotice(rpcErrorText(t, error, "steward.scanFailed"));
    } finally {
      scanBusyRef.current = false;
      setScanBusy(false);
    }
  }

  async function scan(event) {
    event.preventDefault();
    cameraScannerRef.current?.stop();
    const form = event.currentTarget;
    const formData = new FormData(form);
    await redeemCheckin(
      String(formData.get("eventId") || ""),
      String(formData.get("token") || "").trim(),
      form,
    );
  }

  async function scanCameraCode(token) {
    const form = scanFormRef.current;
    if (!form) return;
    if (scanTokenRef.current) scanTokenRef.current.value = token;
    await redeemCheckin(String(new FormData(form).get("eventId") || ""), token, form);
  }

  // Open dialogs survive their row leaving the loaded window (sol F6):
  // replying under the "Awaiting reply" filter, or a filter change mid-review,
  // must not unmount the dialog under the steward. The last-seen row is
  // cached; the live row wins whenever it is still loaded.
  const openThreadRef = useRef(null);
  const openFormRef = useRef(null);
  useEffect(() => {
    const row = threadsQ.rows.find((item) => item.id === threadId);
    if (row) openThreadRef.current = row;
    if (!threadId) openThreadRef.current = null;
  }, [threadsQ.rows, threadId]);
  useEffect(() => {
    const row = formsQ.rows.find((item) => item.id === formId);
    if (row) openFormRef.current = row;
    if (!formId) openFormRef.current = null;
  }, [formsQ.rows, formId]);
  const openRequestRef = useRef(null);
  useEffect(() => {
    const row = requestsQ.rows.find((item) => item.id === requestId);
    if (row) openRequestRef.current = row;
    if (!requestId) openRequestRef.current = null;
  }, [requestsQ.rows, requestId]);
  const openRequest = requestsQ.rows.find((item) => item.id === requestId)
    ?? (openRequestRef.current?.id === requestId ? openRequestRef.current : null);
  const thread = threadsQ.rows.find((item) => item.id === threadId)
    ?? (openThreadRef.current?.id === threadId ? openThreadRef.current : null)
    ?? (landed?.threadId === threadId ? landed.thread : null);
  // A review that closes on an approval, a return or a
  // refusal hands focus back to its inbox row, and the re-read after it can
  // drop that row (approved, moved to another page or filter). Focus would
  // then fall to the page, so once the inbox rows next change without the
  // row, and nothing else has taken focus, it moves to the forms inbox.
  const formsInboxRef = useRef(null);
  const formsRowsRef = useRef(formsQ.rows);
  formsRowsRef.current = formsQ.rows;
  const closedReviewRef = useRef(null);
  // BUG-UG-FORMS-REVIEW-LATE-REPLY-CLOSES-ANOTHER-MEMBERS-REVIEW-20261119
  //: the review dialog can be closed while its action runs, so the
  // steward may have another member's form open when the reply lands. A reply
  // closes only the review it came from; the one open now keeps its note.
  const formIdRef = useRef(formId);
  formIdRef.current = formId;
  const closeReview = (id) => {
    if (formIdRef.current !== id) return;
    closedReviewRef.current = { id, rows: formsRowsRef.current };
    setFormId(null);
  };
  useEffect(() => {
    const closed = closedReviewRef.current;
    if (!closed) return;
    if (formId) { closedReviewRef.current = null; return; }
    // A desk re-read that failed keeps the old rows, so
    // the move would wait for some later, unrelated change; it is dropped
    // instead. a review note: not when the forms queue itself fails, which empties
    // its rows at once; focus then goes to the inbox, which shows the error
    // and its Try again.
    if (deskError) { closedReviewRef.current = null; return; }
    if (formsQ.loading || formsQ.rows === closed.rows) return;
    closedReviewRef.current = null;
    if (formsQ.rows.some((item) => item.id === closed.id)) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) formsInboxRef.current?.focus();
  }, [formsQ.rows, formsQ.loading, deskError, formId]);
  const formsInbox = formsQ.rows;
  const reviewForm = formsInbox.find((item) => item.id === formId)
    ?? (openFormRef.current?.id === formId ? openFormRef.current : null);
  const caseload = useMemo(() => desk?.caseload || [], [desk?.caseload]);
  // REQ-UG-STEWARD-ATTENTION-TREND-20261001: one attention read feeds the
  // overview panel and the caseload badges; the previous visit's count lives
  // on this device only.
  const attention = useStewardAttention(caseSignals, "steward");
  const attentionVisit = useAttentionVisit(attention, {
    userId: data.member?.id || null,
    organizationId: data.member?.organizationId || null,
    hat: "steward",
  });
  // / retired the plane's own active/resolved chip: the shared
  // CaseList owns the status facet now, so the caseload in hand IS the
  // filtered set and there is no separate derivation to prune against.
  // The list reports the ids its current page paints, so select-all-visible
  // still means the rows on screen.
  const caseloadIds = useMemo(() => caseload.map((row) => row.id), [caseload]);
  useEffect(() => { setCaseSelection((current) => pruneSelection(current, caseloadIds)); }, [caseloadIds]);
  const [visibleCaseloadIds, setVisibleCaseloadIds] = useState([]);
  // Facet names only, for the export receipt.
  const [caseloadFilterKeys, setCaseloadFilterKeys] = useState([]);
  // Macros are a coordinator tool: casework_apply_macro demands a coordinator,
  // admin or vp role on the organization, and the editor lives on the
  // coordinator plane. Wiring them here would paint a Macros button for every
  // steward that answers a raw 42501 on the first click, so the steward desk
  // gets the bar without them. A steward who also wears the coordinator hat
  // applies macros from the coordinator queue.
  const caseBulkApi = useMemo(() => ({
    bulkUpdateCases: api?.bulkUpdateCases,
    assignCase: api?.assignCase,
    addCaseNote: api?.addCaseNote,
    loadAssignmentCandidates: api?.loadAssignmentCandidates,
    recordCaseExport: api?.recordCaseExport,
  }), [api]);
  // Same rule for the casework hub's two coordinator controls: a steward who
  // also holds a coordinator/advisor/admin/vp hat keeps them, everyone else
  // gets a hub without the methods, so the panel renders neither control.
  // A roles read that failed leaves data.roles empty and closes them too.
  const caseworkOversight = (data?.roles || []).some((role) => CASEWORK_OVERSIGHT_ROLES.includes(role));
  const caseworkHubApi = useMemo(() => caseworkOversight
    ? api
    : Object.fromEntries(Object.entries(api || {}).filter(([name]) => !CASEWORK_OVERSIGHT_METHODS.includes(name))), [api, caseworkOversight]);
  const activeCase = caseload.find((item) => item.id === caseId);
  const openCase = useCallback(async (item) => {
    if (api.recordAccess) {
      if (!accessActor || !item?.subjectUserId) {
        onNotice?.(t("accessHistory.recordFailed"));
        return;
      }
      try {
        const recorded = await api.recordAccess(accessActor, {
          subjectUserId: item.subjectUserId,
          action: "viewed_case",
          entityType: "case",
          entityId: item.id,
        });
        if (!recorded?.ok) {
          onNotice?.(t("accessHistory.recordFailed"));
          return;
        }
      } catch {
        onNotice?.(t("accessHistory.recordFailed"));
        return;
      }
    }
    setCaseId(item.id);
  }, [accessActor, api, onNotice, setCaseId, t]);
  // Attention and next-action rows name a case id; open it through the same
  // audited path as the caseload. A case outside the loaded window says so.
  const openSignalCase = useCallback((id) => {
    const item = caseload.find((row) => row.id === id);
    if (item) void openCase(item);
    else if (overviewOnly && workspace) workspace.open(`/m/steward/caseload?case=${encodeURIComponent(id)}`);
    else onNotice?.(t("caseSignals.caseNotLoaded"));
  }, [caseload, onNotice, openCase, overviewOnly, workspace, t]);
  const recordUpdate = useCallback(async (item) => {
    if (!api.recordAccess) return true;
    if (!accessActor || !item?.subjectUserId) {
      onNotice?.(t("accessHistory.updateRecordFailed"));
      return false;
    }
    try {
      const recorded = await api.recordAccess(accessActor, {
        subjectUserId: item.subjectUserId,
        action: "updated_case",
        entityType: "case",
        entityId: item.id,
      });
      if (recorded?.ok !== true) {
        onNotice?.(t("accessHistory.updateRecordFailed"));
        return false;
      }
      return true;
    } catch {
      onNotice?.(t("accessHistory.updateRecordFailed"));
      return false;
    }
  }, [accessActor, api, onNotice, t]);
  // A URL target is an entry instruction, not durable dialog state. Keep it
  // pending until that target reaches the loaded desk, then consume it before
  // opening so the state update, async access write and later desk reloads
  // cannot replay the instruction over a steward's current work.
  const consumedLinkedThreadRef = useRef(null);
  const consumedLinkedCaseRef = useRef(null);
  // What the steward has open right now, readable from an async answer: a thread,
  // case or form opened by hand while a hydration was in flight supersedes it.
  const selectionRef = useRef({});
  selectionRef.current = { threadId, caseId, formId };
  useEffect(() => () => { landingRun.current += 1; }, []);
  const hydrateThread = useCallback((target, messageId) => {
    landingTarget.current = { threadId: target, messageId };
    const run = ++landingRun.current;
    setLandingStatus("loading");
    api.loadSourceLanding({ conversationId: target, messageId: messageId ?? null }).then((result) => {
      if (run !== landingRun.current) return;
      const open = selectionRef.current;
      if (open.threadId || open.caseId || open.formId) {
        setLandingStatus(null);
        return;
      }
      if (!result?.thread) {
        setLandingStatus("unavailable");
        return;
      }
      setLanded({ threadId: target, thread: result.thread, message: result.message ?? null });
      setLandingStatus(null);
      setThreadId(target);
      if (messageId) setLanding({ threadId: target, messageId });
    }).catch((error) => {
      if (run !== landingRun.current) return;
      setLandingStatus(isPermissionRefusal(error) || isSourceGone(error) ? "unavailable" : "failed");
    });
  }, [api, setThreadId]);
  // Hydrated rows are private content fetched for one steward. When the signed-in
  // steward changes, whatever is in flight is void and nothing hydrated for the
  // previous reader may be shown to the next.
  const readerId = data.member?.id ?? null;
  const readerRef = useRef(readerId);
  useEffect(() => {
    if (readerRef.current === readerId) return;
    readerRef.current = readerId;
    landingRun.current += 1;
    setLanded(null);
    setLanding(null);
    setLandingStatus(null);
  }, [readerId]);
  const dismissLanding = useCallback(() => {
    landingRun.current += 1;
    setLandingStatus(null);
    setLanding(null);
  }, []);
  const retryLanding = useCallback(() => {
    const target = landingTarget.current;
    if (target) hydrateThread(target.threadId, target.messageId);
  }, [hydrateThread]);
  // Applied when the desk mounts, and again when the address changes underneath it:
  // the app's navigate() does not remount a view that is already on screen.
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  useEffect(() => {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const linkedThread = params.get("thread");
    const linkedMessage = params.get("message");
    const linkedCase = params.get("case");
    // One instruction per thread and message: a later link to another message of
    // the same thread applies too, and the same link never applies twice.
    const linkedThreadKey = linkedThread ? `${linkedThread}\u001f${linkedMessage || ""}` : null;
    if (linkedThreadKey && consumedLinkedThreadRef.current !== linkedThreadKey) {
      if (threadsQ.rows.some((item) => item.id === linkedThread)) {
        consumedLinkedThreadRef.current = linkedThreadKey;
        dismissLanding();
        setThreadId(linkedThread);
        if (linkedMessage) setLanding({ threadId: linkedThread, messageId: linkedMessage });
      } else if (api.loadSourceLanding && threadSeed && threadsQ.rows === threadSeed.rows) {
        // The queue has adopted the desk's first page (its rows ARE the seed; in
        // the render where the desk arrives they are still empty, which would
        // read as "not carried") and does not hold this thread: it is on a later
        // page or older than the window. Read exactly it, once, rather than
        // waiting on a page the steward may never walk to.
        consumedLinkedThreadRef.current = linkedThreadKey;
        hydrateThread(linkedThread, linkedMessage);
      }
    }
    const item = linkedCase && consumedLinkedCaseRef.current !== linkedCase
      ? caseload.find((entry) => entry.id === linkedCase)
      : null;
    if (item) {
      consumedLinkedCaseRef.current = linkedCase;
      void openCase(item);
    }
  }, [api, caseload, dismissLanding, hydrateThread, openCase, routeSearch, setThreadId, threadSeed, threadsQ.rows]);

  useEffect(() => {
    let cancelled = false;
    if (!reviewForm?.id || !api.formFilingStatus) {
      setFilingReadiness({ formId: reviewForm?.id || null, loading: false, status: null, error: "" });
      return () => { cancelled = true; };
    }
    setFilingReadiness({ formId: reviewForm.id, loading: true, status: null, error: "" });
    api.formFilingStatus(reviewForm.id).then((status) => {
      if (!cancelled) setFilingReadiness({ formId: reviewForm.id, loading: false, status, error: "" });
    }).catch(() => {
      if (!cancelled) setFilingReadiness({ formId: reviewForm.id, loading: false, status: null, error: t("forms.filing.unavailable") });
    });
    return () => { cancelled = true; };
  }, [api, reviewForm?.id, t]);

  // A submitted form is no longer editable by its filer, so when an
  // attachment's clean verdict ages out past the 24-hour lifetime the reviewer
  // is the only person left who can renew it. The re-check is the ordinary
  // authorized inspection — `{kind: "form", fileId}` and nothing else — and a
  // steward already holds read authorization for a submitted form's confirmed
  // attachments, so no new privilege is introduced. Refreshing the filing
  // status afterwards is what clears the approval gate in the same dialog.
  const recheckFilingAttachment = useCallback(async (row) => {
    if (!api.recheckFormFile || !reviewForm?.id) throw new Error(t("forms.filing.unavailable"));
    const checkedId = reviewForm.id;
    await api.recheckFormFile(row.id);
    const status = await api.formFilingStatus(checkedId);
    //: the steward may have moved to another member's form meanwhile;
    // a late status applies only to the form it was read for.
    if (formIdRef.current === checkedId) setFilingReadiness({ formId: checkedId, loading: false, status, error: "" });
  }, [api, reviewForm?.id, t]);

  // Resolve each inbox form against the EXACT registry version it was filed
  // under (frozen schema), falling back to the static template only if the
  // registry row is missing. The registry row carries both locales, so the
  // steward reads each form's labels in their own language.
  const inboxTemplate = useCallback((item) => {
    const row = (desk?.formTemplateVersions || []).find(
      (tpl) => tpl.key === item.templateKey && tpl.version === item.templateVersion,
    );
    return row ? templateFromDbRow(row, lang) : templateByKey(item.templateKey);
  }, [desk, lang]);

  async function handleFormAction(kind, id, note) {
    // What this review showed: the answers, the stored version of a
    // sealed form, the confirmed attachments and the accepted co-signers. The
    // approval refuses, approving nothing, if the filing changed since. It is
    // the form the dialog renders, kept from openFormRef when the row has left
    // the loaded queue (a filter, a later page); never a fresh queue lookup
    // that can come back empty and send an approval with nothing to compare.
    const shown = reviewForm?.id === id ? reviewForm : null;
    const approving = kind === "approve" || kind === "approveCase";
    if (approving && !shown) {
      onNotice(t("steward.reviewUnavailable"));
      return;
    }
    const review = shown ? {
      templateKey: shown.templateKey, answers: shown.answers, dataVersion: shown.dataVersion ?? null,
      attachmentIds: (filingReadiness.formId === id ? filingReadiness.status?.attachments || [] : [])
        .filter((row) => row?.confirmedAt).map((row) => row.id),
      cosignerIds: (shown.cosigners || []).map((row) => row.id),
    } : null;
    const work = {
      start: () => api.startFormReview(id),
      approve: () => api.approveForm(id, note, review),
      // Single atomic RPC: if the case-open fails server-side the approval
      // rolls back with it, so the form stays reviewable in the inbox.
      approveCase: () => api.approveAndOpenCase(id, note, review),
      return: () => api.returnForm(id, note),
    }[kind];
    const success = {
      start: t("steward.reviewStarted"),
      approve: t("steward.reviewApproved"),
      approveCase: t("steward.reviewApprovedCase"),
      return: t("steward.reviewReturned"),
    }[kind];
    try {
      await work();
    } catch (error) {
      // The workflow gate refuses in one sentence about "an attachment". The
      // reviewer needs to know WHICH one, because clearing it is a per-file
      // re-check they perform in this same dialog — so the status is re-read,
      // which both names the files and re-arms their re-check buttons.
      if (/current inspection/i.test(error?.message || "") && api.formFilingStatus) {
        const status = await api.formFilingStatus(id).catch(() => null);
        //: only while this form is still the open review; another
        // member's open review keeps its own filing status.
        if (status && formIdRef.current === id) setFilingReadiness({ formId: id, loading: false, status, error: "" });
        const names = staleFilingAttachments({ status }).map((row) => row.filename).join(", ");
        if (names) {
          onNotice(t("steward.attachmentsStale", { names }));
          return;
        }
      }
      // The filing changed after this review (a return and resubmission, a
      // co-signer joining or withdrawing): nothing was approved, and never
      // approve on the steward's behalf. a review note: the answers this
      // dialog shows are no longer what is filed, and a form that has left the
      // loaded queue would keep showing them from the dialog's cache, with
      // every Approve refused again. So the dialog closes, its cached copy is
      // dropped, the inbox is read again, and the steward reopens the form to
      // review what is on file now.
      if (error?.details === "form_changed_since_review") {
        // Only this form's cached copy; another member's open review keeps its own .
        if (openFormRef.current?.id === id) openFormRef.current = null;
        closeReview(id);
        await reload();
        formsQ.retry?.();
        onNotice(t("steward.reviewChangedSinceRead"));
        return;
      }
      // A function-missing answer (PGRST202, 42883) or
      // another service-busy refusal reads as the shared service-busy sentence,
      // never the driver's English (UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117).
      onNotice(rpcErrorText(t, error, "steward.reviewFailed"));
      return;
    }
    if (kind !== "start") closeReview(id);
    await reload();
    onNotice(success);
  }

  const kpis = desk?.kpis;
  const coverageMissing = kpis?.membersCovered == null;
  const coverageLabel = coverageMissing ? "steward.kpiCoveredUnavailable"
    : kpis.membersCoveredIsEstimate ? "steward.kpiCoveredEstimate" : "steward.kpiCovered";
  const coverageForm = kpis?.membersCovered === 1 ? "one" : "many";
  const coverageSummary = coverageMissing ? t(coverageLabel) : t(
    kpis.membersCoveredIsEstimate ? `steward.coveredProfileEstimate.${coverageForm}` : `steward.coveredProfiles.${coverageForm}`,
    { count: formatCount(kpis.membersCovered, lang) },
  );
  const headerSub = kpis && requestFigures
    ? kpis.unavailable ? t("steward.kpiUnavailable") : t("cwk.deskSub", { open: formatCount(kpis.openRequests, lang), coverage: coverageSummary })
    : null;

  return (
    <div className="screen cwk-screen">
      <PlaneHeader
        chapterName={data.member?.chapterName}
        title={pageTitle || t("steward.title")}
        sub={headerSub}
      >
        <StewardHeaderActions t={t} onAssistant={onAssistant} onOpenTasks={onOpenTasks} />
      </PlaneHeader>
      <div className="cwk-plane">
        {deskError && (
          <div className="cwk-alert" aria-live="polite">
            <p>{deskError}</p>
            <button className="cwk-btn cwk-btn--green" type="button" onClick={reload}>{t("steward.tryAgain")}</button>
          </div>
        )}
        {!desk && !deskError && <div className="cwk-alert" role="status" aria-live="polite"><p>{t("steward.loading")}</p></div>}
        {/* A link that names a thread this desk cannot show says so, instead of
            leaving the ordinary desk up as if the link had worked. */}
        {landingStatus && (
          <div className="cwk-alert" role={landingStatus === "loading" ? "status" : "alert"} aria-live="polite">
            <p>{t(`linkedMessage.${landingStatus}`)}</p>
            {landingStatus === "failed" && <button className="cwk-btn cwk-btn--green" type="button" onClick={retryLanding}>{t("linkedMessage.retry")}</button>}
            {landingStatus !== "loading" && <button className="cwk-btn cwk-btn--ghost" type="button" onClick={dismissLanding}>{t("linkedMessage.dismiss")}</button>}
          </div>
        )}
        {desk && (
          <>
            <WorkspaceSection name="overview"><div className="pkpi-grid" role="group" aria-label={t("steward.summaryLabel")}>
              <PlaneKpi label={t("steward.kpiOpen")} value={desk.kpis.openRequests ?? "—"} sub={t("steward.kpiOpenDelta")} tone="green" />
              <PlaneKpi label={t(coverageLabel)} value={kpis.membersCovered ?? "—"} tone="green" />
              <PlaneKpi label={t("steward.kpiAwaiting")} value={desk.kpis.awaitingReply ?? "—"} sub={t("steward.kpiAwaitingDelta")} tone="gold" />
              <PlaneKpi label={t("steward.kpiBroadcasts")} value={desk.kpis.broadcasts30d ?? "—"} sub={t("steward.kpiBroadcastsDelta")} tone="gold" />
            </div></WorkspaceSection>
            {/* REQ-UG-STEWARD-AMBIENT-HINTS-20261001: one quiet hint from the
                governed learning library the steward already reads. */}
            <WorkspaceSection name="overview"><StewardAmbientHint data={data} learningContent={learningContent} /></WorkspaceSection>
            {issueSignals && <WorkspaceSection name="overview"><IssueSignalsStaffPanel issueSignals={issueSignals} hat="steward" /></WorkspaceSection>}
            {caseSignals && <WorkspaceSection name="overview">
              <AttentionPanel attention={attention} snapshot={attentionVisit} onOpenCase={openSignalCase} />
              <NextActionsPanel caseSignals={caseSignals} hat="steward" onOpenCase={openSignalCase} />
            </WorkspaceSection>}
            <WorkspaceOverview />

            <WorkspaceSection name="steward-workload"><WorkloadIntelligencePanel intelligence={desk.workloadIntelligence} configuration={data?.workload?.configuration} lang={lang} t={t} /></WorkspaceSection>

            {/* The same five tiles the coordinator plane mounts as a routed
                tab. The steward's are narrower by construction rather than by
                configuration. The aggregates read only cases assigned to the
                steward. Deep links
                therefore land on the steward's caseload, not the coordinator's
                queue. */}
            {api.loadCaseDashboards && (
              <WorkspaceSection name="steward-caseload">
                <Suspense fallback={<p className="cwk-empty" role="status">{t("caseDash.loading")}</p>}>
                  <CaseDashboards api={api} caseListPath="/m/steward" onNotice={onNotice} lookaheadDays={deadlineLookaheadDays(data?.organizationConfiguration)} />
                </Suspense>
              </WorkspaceSection>
            )}

            {caseworkHubReady
              ? <WorkspaceSection name="steward-casework-hub"><CaseworkHubPanel chapterId={data.member.chapterId} caseOptions={caseload} api={caseworkHubApi} onNotice={onNotice} /></WorkspaceSection>
              /* A focused page must never mount as a bare heading: when the hub
                 read is unavailable (fixture/demo desks) or the steward has no
                 chapter connection, name the missing backing explicitly and
                 link the chapter-backed steward desk (audit P0 APP-STEWARD-12). */
              : <WorkspaceSection name="steward-casework-hub"><WorkspaceStatusState
                title={t("steward.caseworkHubUnavailable")}
                body={t("steward.caseworkHubUnavailableBody")}
                hint={t("steward.caseworkHubWhoFixes")}
                links={[
                  { label: t("steward.caseworkHubOpenDesk"), path: "/m/steward" },
                  { label: t("steward.caseworkHubOpenCaseload"), path: "/m/steward/caseload" },
                ]}
              /></WorkspaceSection>}

            <div className="cwk-grid">
              <div className="cwk-col">
                {/* Caseload (UB-CASE-05): the
                    steward's assigned cases, active-first by soonest deadline.
                    A failed read renders the explicit unavailable notice —
                    "no cases assigned" must never be the face of an error. */}
                <WorkspaceSection name="steward-caseload"><section id="steward-caseload" className="cwk-panel role-section-target" tabIndex="-1">
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      <WorkspaceCardTitle as="span" className="cwk-panel__title">{t("steward.caseloadTitle")}</WorkspaceCardTitle>
                      {/* No count chip on a failed read — "0" next to the
                          unavailable notice would still claim an empty
                          caseload. */}
                      {!desk.caseloadUnavailable && <span className="cwk-count">{caseload.length}</span>}
                    </div>
                    <p className="cwk-panel__note">{t("steward.caseloadSub")}</p>
                  </div>
                  {/* The all/active/resolved chip group is gone: status is one
                      of the shared list's six facets, and two filter controls
                      over one caseload disagree the moment a saved view is
                      applied. The procedure board layout is left out:
                      Union Ground issues have no grievance steps to deal
                      cards into (owner decision, 2026-10-13). */}
                  {desk.caseloadUnavailable && <p className="cwk-empty">{t("steward.caseloadUnavailable")}</p>}
                  {/* A full window is disclosed as a slice, never presented
                      as the whole caseload (same rule as UB-CASE-04). */}
                  {!desk.caseloadUnavailable && desk.caseloadTruncated && (
                    <p className="cwk-empty">{t("steward.caseloadTruncated", { active: desk.caseloadWindow?.active ?? 0, resolved: desk.caseloadWindow?.resolved ?? 0 })}</p>
                  )}
                  {!desk.caseloadUnavailable && caseload.length === 0 && <p className="cwk-empty">{t("steward.caseloadEmpty")}</p>}
                  {!desk.caseloadUnavailable && caseload.length > 0 && (
                    <CaseBulkActions rows={caseload} visibleIds={visibleCaseloadIds} selection={caseSelection} onSelectionChange={setCaseSelection} api={caseBulkApi} t={t} onDone={reload} exportPrefix="steward-caseload" exportFilterKeys={caseloadFilterKeys} canWrite={Boolean(api?.bulkUpdateCases)} />
                  )}
                  {/* The list owns facets, sort, URL state and the saved-view
                      switcher over the whole caseload. */}
                  {!desk.caseloadUnavailable && caseload.length > 0 && (
                    <CaseList
                      plane="steward"
                      rows={caseload}
                      onOpenCase={(item) => { void openCase(item); }}
                      savedViewsApi={api}
                      className="case-list--steward"
                      // Lane 5.6: one select box per row, beside the trigger.
                      renderRowLead={(item) => <><CaseSelectBox id={item.id} selection={caseSelection} onSelectionChange={setCaseSelection} label={t("caseBulk.selectCase", { reference: item.reference })} /><AttentionBadge attention={attention} memberId={item.subjectUserId} /></>}
                      onVisibleRowsChange={setVisibleCaseloadIds}
                      onActiveFiltersChange={setCaseloadFilterKeys}
                      // The desk serves a fixed window; when it is full the
                      // facet counts describe that window, not the caseload.
                      countsWindowed={Boolean(desk.caseloadTruncated)}
                      formatStatus={(status) => (CASE_STATUS_KEY[status] ? t(CASE_STATUS_KEY[status]) : status)}
                      formatDeadline={(item) => (item.deadline
                        ? t("steward.caseDeadline", { date: shortDate(`${item.deadline}T00:00:00`, lang) })
                        : t("steward.caseNoDeadline"))}
                    />
                  )}
                </section>
                <StewardCaseIntake api={api} onNotice={onNotice} onChanged={reload} />
                <StewardDeadlineList load={api.listCaseDeadlines} refreshKey={desk} />
                <StewardPrivateReminders api={api} caseOptions={caseload} onNotice={onNotice} />
                {/* REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030:
                    bid deadlines beside the steward's other dated work, then
                    the chapter's seniority list and bids. */}
                {seniorityApi && (data.member?.chapterId || data.member?.organizationId) ? <SeniorityChapterScope api={seniorityApi} defaultChapterId={data.member?.chapterId || null} organizationId={data.member?.organizationId || null} organizationWide={seniorityOrganizationWide(data.member)}>{(chapterId) => <><BidDeadlines api={seniorityApi} chapterId={chapterId} /><SeniorityPanel api={seniorityApi} chapterId={chapterId} /></>}</SeniorityChapterScope> : null}</WorkspaceSection>

                <WorkspaceSection name="steward-requests"><section id="steward-requests" className="cwk-panel role-section-target" tabIndex="-1" data-load-state={requestsQ.loading ? "loading" : "ready"}>
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      <WorkspaceCardTitle as="span" className="cwk-panel__title">{t("steward.requestsTitle")}</WorkspaceCardTitle>
                      {/* The chip is the TRUE filtered total from the server,
                          never the loaded slice's length — a chapter past a
                          page must not read as a chapter of one page. */}
                      {!requestsQ.error && !requestsQ.loading && <span className="cwk-count">{t(requestsQ.params.status === "open" ? "steward.requestsCountOpen" : requestsQ.params.status === "closed" ? "steward.requestsCountClosed" : "steward.requestsCountAll", { count: formatCount(requestsQ.total ?? requestsQ.rows.length, lang) })}</span>}
                    </div>
                    <p className="cwk-panel__note">{t("steward.requestsSub")}</p>
                  </div>
                  <QueueToolbar
                    label={t("steward.requestsToolbarLabel")}
                    searchPlaceholder={t("steward.searchMembersPlaceholder")}
                    query={requestsQ}
                    chips={[
                      { value: "all", label: t("steward.filterAll") },
                      { value: "open", label: t("steward.requestFilterOpen") },
                      { value: "closed", label: t("steward.requestFilterClosed") },
                    ]}
                    sortLabels={{ newest: t("steward.sortNewest"), oldest: t("steward.sortOldest") }}
                  />
                  {requestsQ.loading && requestsQ.rows.length === 0 && !requestsQ.error && <p className="cwk-empty">{t("steward.loadingMore")}</p>}
                  {!requestsQ.loading && !requestsQ.error && requestsQ.rows.length === 0 && (
                    <p className="cwk-empty">
                      {requestsQ.params.status !== "all" || requestsQ.params.search.trim() !== "" ? t("steward.noMatches") : t("steward.requestsEmpty")}
                    </p>
                  )}
                  {requestsQ.rows.map((item) => (
                    <div className="cwk-row cwk-request" key={item.id}>
                      <span className="cwk-av" aria-hidden="true">{item.memberInitials}</span>
                      <div className="cwk-row__main">
                        <div className="cwk-row__top">
                          {/* The member's name opens the request; its hit
                              area covers the row. Acknowledge and Close stay
                              sibling buttons, never controls inside it. */}
                          <button type="button" className="cwk-request__open" aria-haspopup="dialog" onClick={() => setRequestId(item.id)}>
                            <span className="cwk-name">{item.memberName}</span>
                          </button>
                          <span className={`cwk-chip ${QUEUE_CHIP[item.status] || "cwk-chip--rest"}`}>{STATUS_KEY[item.status] ? t(STATUS_KEY[item.status]) : item.status}</span>
                        </div>
                        <div className="cwk-meta">
                          <span className="cwk-time">{shortDate(item.createdAt, lang)}</span>
                          {item.lessonLabel && <span className="cwk-lesson">{item.lessonLabel}</span>}
                        </div>
                        <RequestTriageActions item={item} busyKeys={busyKeys} onTriage={triageOrConfirm} />
                      </div>
                    </div>
                  ))}
                  <QueuePager query={requestsQ} />
                </section></WorkspaceSection>

                {/* Appointments desk (REQ-UG-STEWARD-APPOINTMENTS-20260801):
                    self-loading like the desk itself, so the appointments RPC
                    only fires for stewards who actually render this plane. */}
                <WorkspaceSection name="steward-appointments"><StewardAppointmentsPanel api={api} onNotice={onNotice} /></WorkspaceSection>

                <WorkspaceSection name="steward-forms"><section id="steward-forms" ref={formsInboxRef} className="cwk-panel role-section-target" tabIndex="-1" aria-labelledby="steward-forms-title">
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      {/* a review note: the section focus can move to is named by its title. */}
                      <span className="cwk-panel__title" id="steward-forms-title">{t("steward.formsInboxTitle")}</span>
                      {!formsQ.error && !(formsQ.loading && !formsQ.rows.length) && <span className="cwk-count cwk-count--wait">{t("steward.formsWaiting", { n: formsQ.total ?? formsInbox.length })}</span>}
                    </div>
                    <p className="cwk-panel__note">{t("steward.formsSub")}</p>
                  </div>
                  <QueueToolbar
                    label={t("steward.formsToolbarLabel")}
                    searchPlaceholder={t("steward.searchMembersPlaceholder")}
                    query={formsQ}
                    chips={[
                      { value: "all", label: t("steward.filterAll") },
                      { value: "submitted", label: t("steward.formStatusSubmitted") },
                      { value: "in_review", label: t("steward.formStatusInReview") },
                    ]}
                    sortLabels={{ newest: t("steward.sortNewest"), oldest: t("steward.sortOldest") }}
                  />
                  {formsQ.loading && formsInbox.length === 0 && !formsQ.error && <p className="cwk-empty">{t("steward.loadingMore")}</p>}
                  {!formsQ.loading && !formsQ.error && formsInbox.length === 0 && (
                    <p className="cwk-empty">
                      {formsQ.params.status !== "all" || formsQ.params.search.trim() !== "" ? t("steward.noMatches") : t("steward.formsEmpty")}
                    </p>
                  )}
                  {formsInbox.map((item) => {
                    const template = inboxTemplate(item);
                    return (
                      <button type="button" className="cwk-row cwk-row--tap cwk-row--review" key={item.id} onClick={() => setFormId(item.id)}>
                        <span className="cwk-av cwk-av--round" aria-hidden="true">{item.memberInitials}</span>
                        <span className="cwk-row__main">
                          <span className="cwk-row__top">
                            <span className="cwk-name">
                              <span>{item.memberName}</span>
                              {template ? <span> · {t(template.titleKey)}</span> : null}
                            </span>
                            <span className={`cwk-chip ${FORM_CHIP[item.status] || "cwk-chip--rest"}`}>{FORM_STATUS_KEY[item.status] ? t(FORM_STATUS_KEY[item.status]) : item.status}</span>
                          </span>
                          <span className="cwk-sub">{shortDate(item.submittedAt, lang)}{item.unitName ? ` · ${item.unitName}` : ""}</span>
                        </span>
                        <span className="cwk-btn cwk-btn--green" aria-hidden="true">{t("steward.formsReview")}</span>
                      </button>
                    );
                  })}
                  <QueuePager query={formsQ} />
                </section></WorkspaceSection>

                <WorkspaceSection name="steward-messages"><section id="steward-messages" className="cwk-panel role-section-target" tabIndex="-1">
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      <span className="cwk-panel__title">{t("steward.messagesTitle")}</span>
                      {!threadsQ.error && !(threadsQ.loading && !threadsQ.rows.length) && <span className="cwk-count">{threadsQ.total ?? threadsQ.rows.length}</span>}
                    </div>
                    <p className="cwk-panel__note">{t("steward.messagesSub")}</p>
                  </div>
                  <QueueToolbar
                    label={t("steward.messagesToolbarLabel")}
                    searchPlaceholder={t("steward.searchMembersPlaceholder")}
                    query={threadsQ}
                    chipKey="filter"
                    chips={[
                      { value: "all", label: t("steward.filterAll") },
                      { value: "awaiting", label: t("steward.awaitingReply") },
                    ]}
                  />
                  {threadsQ.loading && threadsQ.rows.length === 0 && !threadsQ.error && <p className="cwk-empty">{t("steward.loadingMore")}</p>}
                  {!threadsQ.loading && !threadsQ.error && threadsQ.rows.length === 0 && (
                    <p className="cwk-empty">
                      {threadsQ.params.filter !== "all" || threadsQ.params.search.trim() !== "" ? t("steward.noMatches") : t("steward.messagesEmpty")}
                    </p>
                  )}
                  {threadRows.map((item) => (
                    <button type="button" className="cwk-row cwk-row--tap" key={item.id} onClick={() => { dismissLanding(); setThreadId(item.id); }}>
                      <span className="cwk-av" aria-hidden="true">{item.memberInitials}</span>
                      <span className="cwk-row__main">
                        <span className="cwk-row__top">
                          <span className="cwk-name">{item.memberName}</span>
                          {item.awaitingReply && <span className="cwk-chip cwk-chip--new">{t("steward.awaitingReply")}</span>}
                          {/* Preservation order marker (legal hold). Only a
                              server-confirmed `true` renders it: an unknown
                              status (failed read) must not read as "not held". */}
                          {item.legalHold === true && <span className="cwk-chip cwk-chip--rest">{t("steward.legalHoldChip")}</span>}
                        </span>
                        <span className="cwk-sub">{notePreview(item.preview)}</span>
                        <span className="cwk-meta"><time className="cwk-time">{shortDate(item.updatedAt, lang)}</time></span>
                      </span>
                    </button>
                  ))}
                  <QueuePager query={threadsQ} />
                </section></WorkspaceSection>

                <WorkspaceSection name="steward-email-intake"><section id="steward-email-intake" className="cwk-panel role-section-target" tabIndex="-1">
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      <span className="cwk-panel__title">{t("steward.emailIntakeTitle")}</span>
                      {!emailIntakeError && <span className="cwk-count">{emailIntakes.length}</span>}
                    </div>
                    <p className="cwk-panel__note">{t("steward.emailIntakeSub")}</p>
                  </div>
                  <div className="cwk-actions" role="group" aria-label={t("steward.emailIntakeFilter")}>{["pending", "reviewing", "accepted", "rejected"].map((status) => (
                    <button key={status} type="button" className={`cwk-btn ${emailIntakeStatus === status ? "cwk-btn--soft" : "cwk-btn--ghost"}`} aria-pressed={emailIntakeStatus === status} onClick={() => setEmailIntakeStatus(status)}>{t(`steward.emailStatus.${status}`)}</button>
                  ))}</div>
                  {emailIntakeLoading && <p className="cwk-empty">{t("steward.emailIntakeLoading")}</p>}
                  {emailIntakeError && <p className="cwk-empty">{t("steward.emailIntakeUnavailable")} <button type="button" className="cwk-btn cwk-btn--ghost" onClick={loadEmailIntakes}>{t("steward.tryAgain")}</button></p>}
                  {!emailIntakeLoading && !emailIntakeError && emailIntakes.length === 0 && <p className="cwk-empty">{t("steward.emailIntakeEmpty")}</p>}
                  {emailIntakes.map((item) => <article className="cwk-email" key={item.id}>
                    <div className="cwk-row__top"><strong className="cwk-name">{item.subject || t("steward.emailNoSubject")}</strong><span className={`cwk-chip ${item.status === "rejected" ? "cwk-chip--new" : item.status === "accepted" ? "cwk-chip--live" : "cwk-chip--rest"}`}>{t(`steward.emailStatus.${item.status}`)}</span></div>
                    <p className="cwk-email__from">{item.from}</p>
                    {(item.autoRoutedAt || item.routeHold) && <p className="cwk-panel__note" data-testid="email-intake-route">
                      {item.autoRoutedAt ? [
                        t("steward.emailRouteAuto"),
                        item.routedCase ? t("steward.emailRouteCase", { reference: item.routedCase.reference }) : null,
                        !item.routedCase && item.caseAttached ? t("steward.emailRouteCaseHidden") : null,
                        item.knowledgeDraft ? t("steward.emailRouteKnowledge") : null,
                      ].filter(Boolean).join(" · ") : t(`steward.emailRouteHold.${item.routeHold}`)}
                    </p>}
                    <p className="cwk-email__body">{item.text}</p>
                    <time className="cwk-time" dateTime={item.receivedAt}>{t("steward.emailReceivedAt", { date: formatEasternTimestamp(item.receivedAt, lang, { daylightName: true })?.text || t("operations.audit.timeUnavailable") })}</time>
                    <div className="cwk-actions">
                      {item.status === "pending" && <BusyButton type="button" className="cwk-btn cwk-btn--soft" pending={[...busyKeys].some((key) => key.startsWith(`email-${item.id}-`))} onClick={() => reviewEmailIntake(item.id, "claim")}>{t("steward.emailClaim")}</BusyButton>}
                      {item.status === "reviewing" && <><BusyButton type="button" className="cwk-btn cwk-btn--green" pending={[...busyKeys].some((key) => key.startsWith(`email-${item.id}-`))} onClick={() => reviewEmailIntake(item.id, "accept")}>{t("steward.emailAccept")}</BusyButton><BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={[...busyKeys].some((key) => key.startsWith(`email-${item.id}-`))} onClick={() => reviewEmailIntake(item.id, "reject")}>{t("steward.emailReject")}</BusyButton></>}
                      {["accepted", "rejected"].includes(item.status) && <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={[...busyKeys].some((key) => key.startsWith(`email-${item.id}-`))} onClick={() => reviewEmailIntake(item.id, "reopen")}>{t("steward.emailReopen")}</BusyButton>}
                    </div>
                  </article>)}
                </section></WorkspaceSection>
              </div>

              <div className="cwk-col">
                {/* The prototype's dark Compass card, without its invented
                    member question and invented answer: Compass is a real
                    retrieval assistant, so the card says what it can answer
                    and opens it. No seeded Q&A, no chips that do nothing. */}
                {onAssistant && (
                  <WorkspaceSection name="steward-caseload"><div className="cwk-compass">
                    <div className="cwk-compass__head">
                      <span className="cwk-compass__glyph" aria-hidden="true">✦</span>
                      <span className="cwk-compass__eyebrow">{t("cwk.compassEyebrow")}</span>
                    </div>
                    <p className="cwk-compass__body">{t("cwk.compassBody")}</p>
                    <button type="button" className="cwk-btn cwk-btn--gold cwk-btn--wide cwk-compass__cta" onClick={onAssistant}>{t("cwk.compassOpen")}</button>
                  </div></WorkspaceSection>
                )}

                <WorkspaceSection name="steward-checkins"><section id="steward-checkins" className="cwk-card role-section-target" tabIndex="-1">
                  <WorkspaceCardTitle className="cwk-card__title">{t("steward.scanTitle")}</WorkspaceCardTitle>
                  <p className="cwk-card__note">{t("steward.scanSub")}</p>
                  {upcomingCheckinEvents.length === 0 ? (
                    <p className="cwk-empty cwk-empty--inset">{t("steward.scanEmpty")}</p>
                  ) : (
                    <form ref={scanFormRef} className="cwk-form" onSubmit={scan}>
                      <label className="cwk-form__label">{t("steward.scanEventLabel")}
                        <select name="eventId" defaultValue={upcomingCheckinEvents[0]?.id} onChange={() => cameraScannerRef.current?.stop()}>
                          {upcomingCheckinEvents.map((event) => (
                            <option key={event.id} value={event.id}>{event.title} · {event.dateLabel}</option>
                          ))}
                        </select>
                      </label>
                      <label className="cwk-form__label">{t("steward.scanCodeLabel")}
                        <input ref={scanTokenRef} name="token" className="cwk-input--upper" maxLength="7" autoComplete="off" spellCheck="false" placeholder={t("steward.scanCodePlaceholder")} required />
                      </label>
                      <CameraCheckinScanner ref={cameraScannerRef} pending={scanBusy} onCode={scanCameraCode} />
                      <BusyButton type="submit" className="cwk-btn cwk-btn--green cwk-btn--wide" pending={scanBusy}>{scanBusy ? t("steward.scanning") : t("steward.scanSubmit")}</BusyButton>
                    </form>
                  )}
                </section></WorkspaceSection>

                <WorkspaceSection name="steward-broadcasts"><section id="steward-broadcasts" className="cwk-card role-section-target" tabIndex="-1">
                  <BroadcastFormLifetime draft={broadcastDraft.current} inFlight={broadcastInFlight} setPublishConfirm={setPublishConfirm} setActiveDraftId={setActiveDraftId} />
                  <WorkspaceCardTitle className="cwk-card__title">{t("steward.broadcastsTitle")}</WorkspaceCardTitle>
                  <p className="cwk-card__note">{t("steward.broadcastsSub")}</p>
                  <AnnouncementDrafts api={api} busy={publishBusy} refreshKey={draftsRevision} onUse={(draft) => {
                    setPairPending(null);
                    const form = composerRef.current;
                    if (!form) return;
                    form.elements.title.value = draft.title;
                    form.elements.body.value = draft.body;
                    broadcastDraft.current.cancel();
                    setActiveDraftId(draft.id);
                    form.elements.title.focus();
                  }} />
                  <form className="cwk-form" onSubmit={requestPublish} ref={composerRef}>
                    <label className="cwk-form__label">{t("steward.broadcastTitleLabel")}<input name="title" maxLength="120" placeholder={t("steward.broadcastTitlePlaceholder")} required /></label>
                    <label className="cwk-form__label">{t("steward.broadcastBodyLabel")}<textarea name="body" maxLength="4000" placeholder={t("steward.broadcastBodyPlaceholder")} required /></label>
                    {/* The row carries this to readers of the other language
                        as an "In English / En español" chip — an honest flag
                        beats a silent language switch. */}
                    <label className="cwk-form__label">{t("steward.broadcastLocaleLabel")}
                      <select name="locale" defaultValue={lang}>
                        <option value="en">English</option>
                        <option value="es">Español</option>
                      </select>
                    </label>
                    <BusyButton type="submit" className="cwk-btn cwk-btn--green cwk-btn--wide" pending={publishBusy}>{publishBusy ? t("steward.publishing") : t("steward.publish")}</BusyButton>
                  </form>
                  {confirmRetract && <ConfirmActionDialog
                    eyebrow={t("steward.retractEyebrow")}
                    title={t("steward.retractConfirmTitle", { title: confirmRetract.title })}
                    effects={[t("steward.retractEffectHidden"), t("steward.retractEffectRead")]}
                    affected={t("steward.retractAffected")}
                    undo={t("steward.retractUndo")}
                    confirmLabel={t("steward.retractConfirm")}
                    busy={busyKeys.has(`retract-${confirmRetract.id}`)}
                    onClose={() => setConfirmRetract(null)}
                    onConfirm={() => { const item = confirmRetract; setConfirmRetract(null); runBusyWrite(busyWriteRef, `retract-${item.id}`, () => run(() => api.retract(item.id), t("steward.retracted.toast"), `retract-${item.id}`)); }}
                  />}
                  {publishConfirm && <BroadcastPublishConfirm title={publishConfirm.title} locale={publishConfirm.locale} pairedTitle={publishConfirm.pairedTitle} busy={publishBusy} onPublish={publish} onClose={() => setPublishConfirm(null)} />}
                </section></WorkspaceSection>

                <WorkspaceSection name="steward-broadcasts"><section className="cwk-panel">
                  <div className="cwk-panel__head">
                    <div className="cwk-panel__heading">
                      <span className="cwk-panel__title">{t("steward.recentBroadcasts")}</span>
                      {!broadcastsQ.error && !(broadcastsQ.loading && !broadcastsQ.rows.length) && <span className="cwk-count">{broadcastsQ.total ?? broadcastsQ.rows.length}</span>}
                    </div>
                  </div>
                  <QueueToolbar
                    label={t("steward.broadcastsToolbarLabel")}
                    searchPlaceholder={t("steward.searchBroadcastsPlaceholder")}
                    query={broadcastsQ}
                    chipKey="filter"
                    chips={[
                      { value: "all", label: t("steward.filterAll") },
                      { value: "active", label: t("steward.broadcastFilterActive") },
                      { value: "retracted", label: t("steward.broadcastFilterRetracted") },
                    ]}
                  />
                  {broadcastsQ.loading && broadcastsQ.rows.length === 0 && !broadcastsQ.error && <p className="cwk-empty">{t("steward.loadingMore")}</p>}
                  {!broadcastsQ.loading && !broadcastsQ.error && broadcastsQ.rows.length === 0 && (
                    <p className="cwk-empty">
                      {broadcastsQ.params.filter !== "all" || broadcastsQ.params.search.trim() !== "" ? t("steward.noMatches") : t("steward.broadcastsEmpty")}
                    </p>
                  )}
                  {readCountsError && <p className="cwk-empty" role="status">{t("steward.readCountsUnavailable")}</p>}
                  {broadcastsQ.rows.map((item) => {
                    const readCount = item.readCount != null ? item.readCount : recentReadCounts.get(item.id);
                    return (
                    <div className="cwk-row" key={item.id}>
                      <span className="cwk-av" aria-hidden="true">CS</span>
                      <div className="cwk-row__main">
                        <div className="cwk-row__top">
                          <span className="cwk-name">{item.title}</span>
                          {item.retracted && <span className="cwk-chip cwk-chip--rest">{t("steward.retracted")}</span>}
                        </div>
                        <p className="cwk-sub">{item.body}</p>
                        <div className="cwk-meta">
                          <span className="cwk-time">{shortDate(item.publishedAt, lang)}</span>
                          {/* readCount null is "not counted", not "nobody read
                              it" — it renders nothing rather than a zero. */}
                          {!item.retracted && readCount != null && (
                            <span className="cwk-note">{readCount === 1 ? t("steward.readByOne", { count: readCount }) : t("steward.readByMany", { count: readCount })}</span>
                          )}
                        </div>
                      </div>
                      {!item.retracted && (
                        <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={busyKeys.has(`retract-${item.id}`)} aria-label={t("steward.retractNamed", { title: item.title })} onClick={() => setConfirmRetract(item)}>{t("steward.retract")}</BusyButton>
                      )}
                    </div>
                    );
                  })}
                  <QueuePager query={broadcastsQ} />
                </section></WorkspaceSection>

                {officerQa && (
                  <WorkspaceSection name="steward-qa"><section id="steward-qa" className="cwk-card role-section-target" tabIndex="-1">
                    {officerQa}
                  </section></WorkspaceSection>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {reviewForm && (
        <FormReviewDialog
          item={reviewForm}
          template={inboxTemplate(reviewForm)}
          ownForm={reviewForm.userId === data.member.id}
          filingReadiness={filingReadiness.formId === reviewForm.id ? filingReadiness : null}
          filingSupported={Boolean(api.formFilingStatus)}
          onRecheckFile={api.recheckFormFile ? recheckFilingAttachment : null}
          onClose={() => setFormId(null)}
          onAction={handleFormAction}
        />
      )}
      {openRequest && (
        <StewardRequestDialog
          item={openRequest}
          linkedCase={caseload.find((row) => openRequest.userId && row.subjectUserId === openRequest.userId && row.status === "active") || null}
          busyKeys={busyKeys}
          onTriage={triageOrConfirm}
          onOpenCase={(item) => { setRequestId(null); void openCase(item); }}
          onClose={() => setRequestId(null)}
        />
      )}
      {confirmClose && (
        <ConfirmActionDialog
          eyebrow={t("steward.requestEyebrow")}
          title={t("steward.closeConfirmTitle", { name: confirmClose.memberName || t("steward.requestMemberLabel") })}
          effects={[t("steward.closeEffectStatus"), t("steward.closeEffectQueue")]}
          affected={t("steward.closeAffected")}
          undo={t("steward.closeUndo")}
          confirmLabel={t("steward.closeRequest")}
          busy={busyKeys.has(`close-${confirmClose.id}`)}
          onClose={() => setConfirmClose(null)}
          onConfirm={() => { const item = confirmClose; setConfirmClose(null); triageRequest(item, "close"); }}
        />
      )}
      {activeCase && <StewardCaseDialog key={activeCase.id} item={activeCase} caseOptions={caseload} api={api} onNotice={onNotice} updatesUnavailable={desk?.caseUpdatesUnavailable} onClose={() => setCaseId(null)} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} onOpenTask={onOpenTask} onChanged={async () => { try { await recordUpdate(activeCase); } finally { await reload(); } }} organizationConfiguration={data?.organizationConfiguration ?? null} />}
      {thread && <StewardThreadDialog key={thread.id} thread={thread} api={api} actorId={data.member?.id} documents={data.product?.documents || []} canCreateEvent={canCreateMessageEvent ?? (data.roles || []).includes("admin")} onNotice={onNotice} onClose={() => setThreadId(null)} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} renderConnectedActions={renderConnectedActions} onOpenTask={onOpenTask} focusMessageId={landing?.threadId === thread.id ? landing.messageId : null} landedMessage={landed?.threadId === thread.id ? landed.message : null} onLegalHoldChange={(conversationId, held) => setHoldOverrides((current) => ({ ...current, [conversationId]: held }))} onSend={async (conversationId, body) => {
        try {
          await api.reply(conversationId, body);
        } catch (error) {
          onNotice(error.message || t("steward.replyFailed"));
          throw error;
        }
        await reload();
        onNotice(t("steward.replySent"));
      }} />}
    </div>
  );
}

function WorkloadIntelligencePanel({ intelligence, configuration, lang, t }) {
  if (!intelligence) return null;
  // An applied workload configuration names and hides categories here too.
  const categories = withConfiguredWorkloadCategories(Array.isArray(intelligence.categories) ? intelligence.categories : [], configuredWorkloadCategories(configuration, lang));
  const rebalancing = intelligence.rebalancing || { stewards: [], suggestions: [] };
  const unavailableKey = {
    anonymity_floor: "steward.workloadFloor",
    insufficient_weeks: "steward.workloadWeeks",
    chapter_unavailable: "steward.workloadChapterUnavailable",
    read_error: "steward.workloadReadError",
  }[intelligence.reason] || "steward.workloadReadError";

  return (
    <section className="cwk-panel cwk-workload" aria-labelledby="steward-workload-title">
      <div className="cwk-panel__head">
        <div className="cwk-panel__heading">
          <WorkspaceCardTitle className="cwk-panel__title" id="steward-workload-title">{t("steward.workloadTitle")}</WorkspaceCardTitle>
          {intelligence.available && <span className="cwk-count">{intelligence.eligibleWeeks}</span>}
        </div>
        <p className="cwk-panel__note">{t("steward.workloadPrivacy")}</p>
      </div>

      {!intelligence.available && <p className="cwk-empty">{t(unavailableKey)}</p>}
      {intelligence.available && (
        <div className="cwk-workload__body">
          <div className="cwk-workload__trends" role="group" aria-label={t("steward.workloadTrends") }>
            {categories.map((category) => (
              <article className="cwk-workload__trend" key={category.key}>
                <strong>{category.name ?? t(`workload.cat.${category.key}`)}</strong>
                <span>{t("steward.workloadForecast", { latest: category.latest, forecast: category.forecast4Weeks })}</span>
                <small>{t(category.slope > 0 ? "steward.workloadRising" : category.slope < 0 ? "steward.workloadFalling" : "steward.workloadSteady", { slope: Math.abs(category.slope) })}</small>
              </article>
            ))}
          </div>
        </div>
      )}

      {intelligence.available && <div className="cwk-workload__rebalance">
        <h3>{t("steward.workloadRebalance")}</h3>
        {(rebalancing.stewards || []).length > 0 && (
          <div className="cwk-workload__roster">
            {rebalancing.stewards.map((steward) => (
              <span key={steward.userId || steward.id}>
                {t("steward.workloadStewardCounts", {
                  name: steward.name, active: steward.activeCases,
                  due: steward.dueSoon, overdue: steward.overdue,
                })}
              </span>
            ))}
          </div>
        )}
        {(rebalancing.suggestions || []).length === 0
          ? <p className="cwk-empty">{t("steward.workloadNoSuggestions")}</p>
          : (
            <ul className="cwk-workload__suggestions">
              {rebalancing.suggestions.map((suggestion) => (
                <li key={`${suggestion.fromUserId || suggestion.fromId}-${suggestion.toUserId || suggestion.toId}`}>
                  {t("steward.workloadSuggestion", {
                    count: suggestion.reviewCount,
                    from: suggestion.fromName,
                    to: suggestion.toName,
                  })}
                </li>
              ))}
            </ul>
          )}
      </div>}
    </section>
  );
}

// In the request detail, Close is named for the request so it is never
// confused with the dialog's own close button.
function RequestTriageActions({ item, busyKeys, onTriage, className = "cwk-actions", closeLabelKey = "steward.close" }) {
  const { t } = useLang();
  return (
    <div className={className}>
      {item.status === "requested" && (
        <BusyButton className="cwk-btn cwk-btn--soft" type="button" pending={busyKeys.has(`ack-${item.id}`)} onClick={() => onTriage(item, "acknowledge")}>{t("steward.acknowledge")}</BusyButton>
      )}
      {item.status !== "closed" && (
        <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={busyKeys.has(`close-${item.id}`)} onClick={() => onTriage(item, "close")}>{t(closeLabelKey)}</BusyButton>
      )}
    </div>
  );
}

// A member request opened from its row: who asked, about what, where it
// stands and when, with the same Acknowledge and Close as the row. The request
// record carries no subject or body of its own; the lesson the member asked
// from is the only topic there is.
function StewardRequestDialog({ item, linkedCase = null, busyKeys, onTriage, onOpenCase, onClose }) {
  const { t, lang } = useLang();
  return (
    <Dialog eyebrow={t("steward.requestEyebrow")} title={item.memberName} onClose={onClose} size="detail">
      <section className="detail-record">
        <h3>{t("steward.requestDetailsTitle")}</h3>
        <dl className="detail-facts">
          <div><dt>{t("steward.requestMemberLabel")}</dt><dd>{item.memberName}</dd></div>
          <div><dt>{t("steward.requestTopicLabel")}</dt><dd>{item.lessonLabel || t("steward.valueDash")}</dd></div>
          <div><dt>{t("steward.requestStatusLabel")}</dt><dd>{STATUS_KEY[item.status] ? t(STATUS_KEY[item.status]) : item.status}</dd></div>
          <div><dt>{t("steward.requestCreatedLabel")}</dt><dd>{shortDate(item.createdAt, lang)}</dd></div>
        </dl>
        <RequestTriageActions item={item} busyKeys={busyKeys} onTriage={onTriage} className="detail-record__actions" closeLabelKey="steward.closeRequest" />
        {linkedCase && (
          <div className="detail-record__actions">
            <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => onOpenCase(linkedCase)}>{t("steward.requestOpenCase", { reference: linkedCase.reference })}</button>
          </div>
        )}
      </section>
    </Dialog>
  );
}

// Detail view for one assigned case: the facts the row summarizes, then the
// member's update timeline (read through the same assignee-scoped RLS). The
// facts stay read-only; the steward's writes (title, deadlines) live in the
// case tools below. Union Ground issues carry no grievance step and no
// contract articles (owner decision, 2026-10-13), so neither is a fact here.
function StewardCaseDialog({ item, caseOptions = [], api, onNotice, updatesUnavailable = false, onClose, onCreateTaskFromSource = null, onResolveSourceTask = null, onOpenTask = null, onChanged = null, organizationConfiguration = null }) {
  const { t, lang } = useLang();
  const [, setToolsReady] = useState(false);
  const [noteRevision, setNoteRevision] = useState(0);
  return (
    <Dialog eyebrow={t("steward.caseEyebrow")} title={`${item.reference} — ${item.title}`} onClose={onClose} size="detail">
      {onCreateTaskFromSource && <SourceTaskAction sourceKind="case" sourceId={item.id} onCreate={onCreateTaskFromSource} onResolve={onResolveSourceTask} onOpenTask={onOpenTask} className="cwk-btn cwk-btn--soft" />}
      <CaseDetailsSummary caseId={item.id} loadDetails={api.loadCaseDetails} />
      <section className="detail-record">
        <h3>{item.memberName}</h3>
        <dl className="detail-facts">
          <div><dt>{t("steward.caseTypeLabel")}</dt><dd>{caseTypeLabel(item.caseType, t)}</dd></div>
          <div><dt>{t("steward.caseDeadlineLabel")}</dt><dd>{item.deadline ? shortDate(`${item.deadline}T00:00:00`, lang) : t("steward.caseNoDeadline")}</dd></div>
          {item.coordinatorName && <div><dt>{t("steward.caseCoordinator")}</dt><dd>{item.coordinatorName}</dd></div>}
          {item.assignedAt && <div><dt>{t("steward.caseAssignedLabel")}</dt><dd>{shortDate(item.assignedAt, lang)}</dd></div>}
        </dl>
        {/* Quiet leadership attribution (SOL-20260813-07): the steward is
            authorized to read the President's review record, so the desk
            where the case is worked says who reviewed it and when. Absent
            covers both "never reviewed" and a failed review read — the
            dialog never asserts either. */}
        {item.review && <p className="detail-record__note cwk-review-note">{t("cases.presidentReviewed", { name: item.review.reviewerName, date: shortDate(item.review.reviewedAt, lang) })}</p>}
      </section>
      {!api?.loadCaseHistory && <section className="detail-record">
        <h3>{t("steward.caseUpdatesTitle")}</h3>
        {/* Three honest timeline states: a failed read says so (never "no
            updates yet"), and a per-case window smaller than the case's
            TRUE total (the RPC reports it) admits exactly how much is
            omitted. Empty genuinely means never updated. */}
        {updatesUnavailable && <p>{t("steward.caseUpdatesUnavailable")}</p>}
        {!updatesUnavailable && item.updates.length === 0 && <p>{t("steward.caseUpdatesEmpty")}</p>}
        {!updatesUnavailable && (item.updatesTotal ?? 0) > item.updates.length && (
          <p><small>{t("steward.caseUpdatesTruncated", { shown: item.updates.length, total: item.updatesTotal })}</small></p>
        )}
        {!updatesUnavailable && item.updates.length > 0 && (
          <ul className="detail-record__list">
            {item.updates.map((update) => (
              <li key={update.id}>
                <small>{item.memberName} · {shortDate(update.createdAt, lang)}</small>
                <CaseNoteBody as="span" className="detail-record__note" body={update.body} mentions={update.mentions || []} />
              </li>
            ))}
          </ul>
        )}
      </section>}
      {api?.loadCaseHistory && !api?.loadCaseworkCase && <CaseHistoryTimeline caseId={item.id} api={api} refreshKey={noteRevision} />}
      {/* A saved steward note also re-reads the case history beside it. */}
      <StewardCaseNoteForm caseId={item.id} onAdd={api.addStewardCaseNote} onSaved={() => { setNoteRevision((value) => value + 1); return onChanged?.(); }} onNotice={onNotice} />
      {api?.loadCaseworkCase && <CaseworkOperationsPanel caseId={item.id} caseOptions={caseOptions} api={api} onNotice={onNotice} onChanged={onChanged} onReadyChange={setToolsReady} organizationConfiguration={organizationConfiguration} historyRefreshKey={noteRevision} />}
    </Dialog>
  );
}

// The dialog owns its message history now (UB-DESK-01): the desk list no
// longer hauls a global 600-message fetch, so opening a thread loads its
// newest window through the thread-message pager and "load earlier" walks
// back through history with the thread's TRUE total always on show. Old api
// doubles without the pager fall back to whatever messages the thread row
// carries (the pre-paging shape).
function MessageEventLimitInput({ t, name, label, limit, maxLength, minLength, placeholder }) {
  const helpId = useId();
  const [count, setCount] = useState(0);
  const [rejected, setRejected] = useState(false);
  const rule = t(limit.rule, limit);
  return <>
    <label>{t(label)}
      <input name={name} required pattern={limit.pattern} minLength={minLength} maxLength={maxLength} placeholder={placeholder}
        title={rule} aria-describedby={helpId} aria-invalid={rejected || undefined}
        onInput={({ currentTarget }) => {
          const { value } = currentTarget;
          if (minLength !== undefined) {
            // The save trims the title and the server counts Unicode code points.
            const belowMinimum = value !== "" && Array.from(value.trim()).length < minLength;
            currentTarget.setCustomValidity(belowMinimum ? rule : "");
          }
          setCount(value.length);
          if (currentTarget.validity.valid) setRejected(false);
        }}
        onInvalid={({ currentTarget }) => {
          const { patternMismatch, tooShort, tooLong, customError } = currentTarget.validity;
          setRejected(patternMismatch || tooShort || tooLong || customError);
        }}
      />
    </label>
    <small id={helpId} className="cwk-note">
      {rejected ? <span role="alert">{rule}</span> : rule}
      <EventTextCount t={t} count={count} max={maxLength} />
    </small>
  </>;
}

function StewardThreadDialog({ thread, api = null, actorId = "", documents = [], canCreateEvent = false, onNotice = () => {}, onClose, onSend, onCreateTaskFromSource = null, onResolveSourceTask = null, renderConnectedActions = null, onOpenTask = null, onLegalHoldChange = null, focusMessageId = null, landedMessage: hydratedMessage = null }) {
  const { t, lang } = useLang();
  const threadDomId = useId();
  // The exact message a link named when it is older than the newest window the
  // pager loaded: the desk's hydration may already carry it (an unknown thread),
  // otherwise this dialog fetches it once its own window has arrived.
  const [fetchedMessage, setFetchedMessage] = useState(null);
  const [messageLanding, setMessageLanding] = useState(null);
  const [messageRetry, setMessageRetry] = useState(0);
  const messageRun = useRef(0);
  const requestedMessage = useRef(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState({ messages: [], earlierCursor: null, total: 0, loading: true, error: false });
  const [contactNotes, setContactNotes] = useState([]);
  const [contactNotesLoading, setContactNotesLoading] = useState(Boolean(api?.listContactNotes));
  const [contactNotesError, setContactNotesError] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  // A reply or private note that failed says so beside its box until the next
  // attempt; the text stays in the box either way.
  const [sendNotSent, setSendNotSent] = useState(false);
  const [noteNotSaved, setNoteNotSaved] = useState(false);
  const sendFormRef = useRef(null);
  const noteFormRef = useRef(null);
  const [eventSource, setEventSource] = useState(null);
  const eventSummaryHelpId = useId();
  const [eventBusy, setEventBusy] = useState(false);
  // Send and cancel-scheduled share `busy`, so they share one
  // lock; the contact note and the event each have their own.
  const threadWriteRef = useRef(new Set());
  const [scheduleFor, setScheduleFor] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [scheduled, setScheduled] = useState([]);
  const [scheduledFailed, setScheduledFailed] = useState(false);
  const gen = useRef(0);

  const loadNewest = useCallback(async () => {
    const g = ++gen.current;
    if (!api?.loadThreadMessages) {
      const fallback = thread.messages || [];
      setHistory({ messages: fallback, earlierCursor: null, total: fallback.length, loading: false, error: false });
      return;
    }
    setHistory((prev) => ({ ...prev, loading: true, error: false }));
    try {
      const page = await api.loadThreadMessages(thread.id);
      if (gen.current !== g) return;
      setHistory({ messages: page.messages, earlierCursor: page.earlierCursor, total: page.total ?? page.messages.length, loading: false, error: false });
    } catch {
      if (gen.current === g) setHistory((prev) => ({ ...prev, loading: false, error: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, thread.id]);

  useEffect(() => { loadNewest(); }, [loadNewest]);

  const landedMessage = fetchedMessage ?? hydratedMessage;
  // The visible history: the pager's window plus the exact message, in
  // chronological position. The pager's own cursor and total are untouched, so
  // "load earlier" walks on as usual and dedupes the message when its page comes.
  const messages = useMemo(() => mergeLandedMessage(history.messages, landedMessage), [history.messages, landedMessage]);
  useEffect(() => () => { messageRun.current += 1; }, []);
  // The dialog's own hydrated copy belongs to the reader it was fetched for.
  const dialogReader = useRef(actorId);
  useEffect(() => {
    if (dialogReader.current === actorId) return;
    dialogReader.current = actorId;
    messageRun.current += 1;
    // The previous reader's instruction is void: mark it asked, so the effect
    // below (which runs in this same commit, often with the new reader's api)
    // does not ask for it again as the new reader.
    requestedMessage.current = focusMessageId;
    setFetchedMessage(null);
    setMessageLanding(null);
  }, [actorId, focusMessageId]);
  useEffect(() => {
    if (!focusMessageId || history.loading || history.error) return;
    if (requestedMessage.current === focusMessageId) return;
    if (messages.some((message) => message.id === focusMessageId)) return;
    if (!api?.loadSourceLanding) return;
    requestedMessage.current = focusMessageId;
    const run = ++messageRun.current;
    setMessageLanding("loading");
    api.loadSourceLanding({ conversationId: thread.id, messageId: focusMessageId }).then((result) => {
      if (run !== messageRun.current) return;
      if (!result?.message) {
        setMessageLanding("unavailable");
        return;
      }
      setFetchedMessage(result.message);
      setMessageLanding(null);
    }).catch((error) => {
      if (run !== messageRun.current) return;
      setMessageLanding(isPermissionRefusal(error) || isSourceGone(error) ? "unavailable" : "failed");
    });
  }, [api, focusMessageId, history.error, history.loading, messages, messageRetry, thread.id]);
  useLandOnMessage(focusMessageId, threadDomId, messages);

  const loadContactNotes = useCallback(async () => {
    if (!api?.listContactNotes) return;
    setContactNotesLoading(true);
    setContactNotesError(false);
    try {
      const rows = await api.listContactNotes(thread.id);
      setContactNotes(Array.isArray(rows) ? rows : []);
    } catch {
      setContactNotesError(true);
    } finally {
      setContactNotesLoading(false);
    }
  }, [api, thread.id]);

  useEffect(() => { loadContactNotes(); }, [loadContactNotes]);

  const loadScheduled = useCallback(async () => {
    if (!api?.listScheduled) return;
    // A failed read says so: an empty list would tell the steward nothing is
    // scheduled, and they could schedule the same message twice
    // (SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113).
    const result = await readResult(() => api.listScheduled(thread.id));
    setScheduledFailed(result.state === READ_STATES.failed);
    setScheduled(Array.isArray(result.value) ? result.value : []);
  }, [api, thread.id]);
  useEffect(() => { loadScheduled(); }, [loadScheduled]);

  async function loadEarlier() {
    if (!history.earlierCursor || history.loading || !api?.loadThreadMessages) return;
    const g = gen.current;
    setHistory((prev) => ({ ...prev, loading: true }));
    try {
      const page = await api.loadThreadMessages(thread.id, { cursor: history.earlierCursor });
      if (gen.current !== g) return;
      setHistory((prev) => {
        const messages = [...page.messages, ...prev.messages];
        const total = page.total ?? prev.total;
        return {
          messages,
          // Accumulated window covers the thread — no phantom earlier page
          // on an exact boundary (sol F5).
          earlierCursor: total != null && messages.length >= total ? null : page.earlierCursor,
          total,
          loading: false,
          error: false,
        };
      });
    } catch {
      if (gen.current === g) setHistory((prev) => ({ ...prev, loading: false, error: true }));
    }
  }

  function submit(event) {
    event.preventDefault();
    return runBusyWrite(threadWriteRef, "send", () => submitNow(event.currentTarget), event);
  }

  async function submitNow(form) {
    const body = String(new FormData(form).get("message") || "").trim();
    if (!body && !resourceId) return;
    setBusy(true);
    try {
      if (scheduleFor && api?.schedule) {
        await api.schedule(thread.id, body, new Date(scheduleFor).toISOString());
        setScheduleFor("");
        await loadScheduled();
        onNotice(t("inbox.scheduled"));
      } else if (resourceId && api?.sendResource) {
        await api.sendResource(thread.id, resourceId, body);
        setResourceId("");
        await loadNewest();
        onNotice(t("inbox.resourceShared"));
      } else {
        await onSend(thread.id, body);
        // The reply is on the server; refetch the newest window so the dialog
        // shows it without pretending a local echo is the record.
        await loadNewest();
      }
      form.reset();
      setSendNotSent(false);
    } catch {
      // The text stays in the box; say so beside it until the next attempt.
      setSendNotSent(true);
    } finally { setBusy(false); }
  }

  function addContactNote(event) {
    event.preventDefault();
    return runBusyWrite(threadWriteRef, "note", () => addContactNoteNow(event.currentTarget), event);
  }

  async function addContactNoteNow(form) {
    const note = String(new FormData(form).get("note") || "").trim();
    if (!note || !api?.createContactNote) return;
    setNoteBusy(true);
    setNoteNotSaved(false);
    try {
      await api.createContactNote(thread.id, note, null);
      form.reset();
      await loadContactNotes();
      onNotice(t("steward.contactNoteSaved"));
    } catch (error) {
      setNoteNotSaved(true);
      onNotice(error.message || t("steward.contactNoteFailed"));
    } finally {
      setNoteBusy(false);
    }
  }

  function createEvent(event) {
    event.preventDefault();
    return runBusyWrite(threadWriteRef, "event", () => createEventNow(event.currentTarget), event);
  }

  async function createEventNow(form) {
    if (!eventSource || !api?.createEventFromMessage) return;
    const fields = Object.fromEntries(new FormData(form));
    fields.startsAt = new Date(fields.startsAt).toISOString();
    fields.summary = oneParagraph(fields.summary);
    setEventBusy(true);
    try {
      await api.createEventFromMessage(eventSource.id, fields);
      setEventSource(null);
      onNotice(t("steward.messageEventCreated"));
    } catch (error) {
      onNotice(error.message || t("steward.messageEventFailed"));
    } finally {
      setEventBusy(false);
    }
  }

  return (
    <Dialog eyebrow={t("steward.threadEyebrow")} title={thread.memberName} onClose={onClose} size="detail">
      <ConversationLegalHoldControls conversationId={thread.id} api={api} onNotice={onNotice} onChange={onLegalHoldChange} />
      {history.error && (
        <p className="cwk-empty">
          {t("steward.threadHistoryUnavailable")}{" "}
          <button className="cwk-btn cwk-btn--ghost" type="button" onClick={loadNewest}>{t("steward.tryAgain")}</button>
        </p>
      )}
      {!history.error && history.loading && history.messages.length === 0 && <p className="cwk-empty">{t("steward.threadLoadingMessages")}</p>}
      {!history.error && history.earlierCursor && (
        <button type="button" className="cwk-btn cwk-btn--soft cwk-more" disabled={history.loading} onClick={loadEarlier}>
          {history.loading ? t("steward.loadingMore") : t("steward.threadEarlier")}
        </button>
      )}
      {!history.error && history.total > history.messages.length && history.messages.length > 0 && (
        <p className="cwk-empty cwk-toolbar__count">{t("steward.threadShowingOf", { shown: history.messages.length, total: history.total })}</p>
      )}
      {messageLanding && (
        <p className="cwk-empty" role={messageLanding === "loading" ? "status" : "alert"}>
          {t(`linkedMessage.${messageLanding}`)}
          {messageLanding === "failed" && <>{" "}<button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => { requestedMessage.current = null; setMessageLanding(null); setMessageRetry((value) => value + 1); }}>{t("linkedMessage.retry")}</button></>}
        </p>
      )}
      <div className="thread-list">{messages.map((message) => {
        const timestamp = formatEasternTimestamp(message.created_at, lang, { daylightName: true });
        // The common connected-workflow control for THIS exact row. A callback
        // that returns nothing for it leaves the row on its standalone controls.
        const connected = renderConnectedActions && isDeliveredMessage(message) ? renderConnectedActions("private_message", message) : null;
        // In the steward's view the steward is "me": reuse the member-side
        // bubble styles with the roles swapped so the steward's own replies
        // sit on the sending side.
        return (
        <article key={message.id} id={`${threadDomId}-message-${message.id}`} tabIndex={message.id === focusMessageId ? -1 : undefined} className={`thread-message thread-message--${message.sender_kind === "steward" ? "member" : "steward"}`}>
          <strong>{message.sender_kind === "steward" ? message.sender_name : thread.memberName}</strong>
          <p>{message.body}</p>
          {message.resource && <a className="inbox-resource" href={`/m/organize?document=${encodeURIComponent(message.resource.documentId)}`}><span><strong>{message.resource.title}</strong><small>{message.resource.documentType}</small></span></a>}
          <time id={`${threadDomId}-sent-${message.id}`} dateTime={timestamp?.dateTime}>{timestamp?.text || t("operations.audit.timeUnavailable")}</time>
          <MessageActions sourceKind="private" message={message} actorId={actorId} api={api} onNotice={onNotice} connectedActions={connected}
            onMessageChange={(next) => {
              setHistory((current) => ({ ...current, messages: current.messages.map((row) => row.id === next.id ? next : row) }));
              // A hydrated message lives outside the pager's window: keep its own
              // copy current too, or a removal would leave the original text behind.
              if (next.id === landedMessage?.id) setFetchedMessage(next);
            }}
            onReply={(reply) => setHistory((current) => ({ ...current, messages: [...current.messages.filter((row) => row.id !== reply.id), reply].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) }))} />
          {/* The task belongs to this exact message, not to whichever one is newest.
              The desk hands onCreateTaskFromSource only to an authorized staff hat;
              the server still requires a staff role and visibility of the member.
              Shown only while no common connected control (which carries the task
              shortcut) is offered for this row. */}
          {!connected && onCreateTaskFromSource && canOfferSourceTask(message) && (
            <SourceTaskAction
              variant="message"
              sourceKind="message"
              sourceId={message.id}
              describedBy={`${threadDomId}-sent-${message.id}`}
              className="cwk-btn cwk-btn--ghost"
              onCreate={onCreateTaskFromSource}
              onResolve={onResolveSourceTask}
              onOpenTask={onOpenTask ? (task) => onOpenTask(task, { sourceKind: "message", sourceId: message.id, conversationId: thread.id }) : null}
            />
          )}
          {canCreateEvent && message.sender_kind === "member" && <button type="button" className="cwk-btn cwk-btn--ghost cwk-message-event" onClick={() => setEventSource(message)}>{t("steward.messageToEvent")}</button>}
        </article>
        );
      })}</div>
      {scheduledFailed && <p className="inbox-scheduled" role="alert">{t("inbox.scheduledLoadFailed")} <button type="button" className="cwk-btn cwk-btn--ghost" onClick={loadScheduled}>{t("inbox.scheduledRetry")}</button></p>}
      {scheduled.length > 0 && <section className="inbox-scheduled" aria-label={t("inbox.scheduledMessages")}><div><strong>{t("inbox.scheduledMessages")}</strong>{scheduled.map((item) => (
        <div className="inbox-scheduled__row" key={item.id}>
          <p>{formatEasternTimestamp(item.scheduled_for, lang, { daylightName: true })?.text || t("operations.audit.timeUnavailable")} · {item.body}</p>
          {api?.cancelScheduled && (
            <BusyButton
              type="button"
              className="cwk-btn cwk-btn--ghost"
              pending={busy}
              onClick={(event) => runBusyWrite(threadWriteRef, "send", async () => {
                setBusy(true);
                try {
                  await api.cancelScheduled(item.id);
                  setScheduled((current) => current.filter((row) => row.id !== item.id));
                  onNotice(t("inbox.scheduledCancelled"));
                } catch (error) {
                  onNotice(error?.message || t("inbox.actionFailed"));
                } finally {
                  setBusy(false);
                }
              }, event)}
            >
              {t("inbox.cancelScheduled")}
            </BusyButton>
          )}
        </div>
      ))}</div></section>}
      {eventSource && <form className="stack-form cwk-event-from-message" onSubmit={createEvent}>
        <div><strong>{t("steward.messageEventTitle")}</strong><p>{t("steward.messageEventSub")}</p></div>
        <MessageEventLimitInput t={t} name="id" label="steward.messageEventId" limit={EVENT_FORM_LIMITS.id} maxLength={EVENT_FORM_LIMITS.id.max} />
        <MessageEventLimitInput t={t} name="title" label="steward.messageEventName" limit={EVENT_FORM_LIMITS.title}
          minLength={EVENT_FORM_LIMITS.title.min} maxLength={EVENT_FORM_LIMITS.title.max} />
        <label>{t("steward.messageEventStarts")}<input type="datetime-local" name="startsAt" required /></label>
        <label>{t("steward.messageEventLocation")}<input name="location" maxLength="120" required /></label>
        <label>{t("steward.messageEventSummary")}<textarea name="summary" maxLength="500" required onKeyDown={keepOneParagraph} onInput={(event) => { const text = oneParagraph(event.currentTarget.value); if (text !== event.currentTarget.value) event.currentTarget.value = text; }} aria-describedby={eventSummaryHelpId} /></label>
        <small id={eventSummaryHelpId} className="cwk-note">{t("admin.fieldSummaryHelp")}</small>
        <MessageEventLimitInput t={t} name="checkInCode" label="steward.messageEventCode" limit={MESSAGE_EVENT_CODE_LIMIT}
          maxLength={MESSAGE_EVENT_CODE_LIMIT.maxLength} placeholder="SG-ABC123" />
        <div className="cwk-actions"><BusyButton type="submit" className="cwk-btn cwk-btn--green" pending={eventBusy}>{eventBusy ? t("steward.messageEventCreating") : t("steward.messageEventCreate")}</BusyButton><button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => setEventSource(null)}>{t("tasks.cancel")}</button></div>
      </form>}
      <form ref={sendFormRef} className="thread-composer" onSubmit={submit}><textarea name="message" placeholder={t("steward.threadPlaceholder")} maxLength="4000" required={!resourceId} /><div className="inbox-composer-tools"><label><span>{t("inbox.shareResource")}</span><select value={resourceId} onChange={(event) => setResourceId(event.target.value)} disabled={Boolean(scheduleFor)} aria-label={t("inbox.shareResource")}><option value="">{t("inbox.none")}</option>{documents.filter((document) => document.status === "published" && document.visibility === "chapter").map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label><label><span>{t("inbox.scheduleFor")}</span><input type="datetime-local" aria-label={t("inbox.scheduleFor")} value={scheduleFor} onChange={(event) => setScheduleFor(event.target.value)} disabled={Boolean(resourceId)} /></label></div><BusyButton type="submit" className="dialog-primary" pending={busy}>{busy ? t("steward.threadSending") : t("steward.threadSend")}</BusyButton></form>
      {sendNotSent && !busy && <p role="alert" className="composer-not-sent">{t("inbox.notSent")} <button type="button" className="composer-not-sent__retry" onClick={() => sendFormRef.current?.requestSubmit()}>{t("inbox.notSentRetry")}</button></p>}
      <section className="cwk-contact-notes" aria-labelledby={`contact-notes-${thread.id}`}>
        <div><strong id={`contact-notes-${thread.id}`}>{t("steward.contactNotesTitle")}</strong><p>{t("steward.contactNotesPrivate")}</p></div>
        {contactNotesLoading && <p>{t("steward.contactNotesLoading")}</p>}
        {contactNotesError && <p>{t("steward.contactNotesUnavailable")} <button type="button" className="cwk-btn cwk-btn--ghost" onClick={loadContactNotes}>{t("steward.tryAgain")}</button></p>}
        {!contactNotesLoading && !contactNotesError && contactNotes.length === 0 && <p>{t("steward.contactNotesEmpty")}</p>}
        {contactNotes.map((note) => {
          const timestamp = formatEasternTimestamp(note.createdAt, lang, { daylightName: true });
          return <article key={note.id}><p>{note.note}</p><time dateTime={timestamp?.dateTime}>{timestamp?.text || t("operations.audit.timeUnavailable")}</time></article>;
        })}
        <form ref={noteFormRef} className="thread-composer" onSubmit={addContactNote}><textarea name="note" placeholder={t("steward.contactNotePlaceholder")} maxLength="2000" required /><BusyButton type="submit" className="dialog-primary" pending={noteBusy}>{noteBusy ? t("steward.contactNoteSaving") : t("steward.contactNoteSave")}</BusyButton></form>
        {noteNotSaved && !noteBusy && <p role="alert" className="composer-not-sent">{t("steward.contactNoteNotSaved")} <button type="button" className="composer-not-sent__retry" onClick={() => noteFormRef.current?.requestSubmit()}>{t("steward.tryAgain")}</button></p>}
      </section>
    </Dialog>
  );
}

function FormReviewDialog({ item, template: templateProp, ownForm, filingReadiness, filingSupported, onRecheckFile = null, onClose, onAction }) {
  const { t } = useLang();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const reviewWriteRef = useRef(new Set());
  const template = templateProp || templateByKey(item.templateKey);
  const grievance = item.templateKey === "grievance" || item.templateKey === "alliance_grievance";
  // A template that is not a signed statement is approved without a filer
  // signature (REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111);
  // an older server that does not say so is read as requiring one.
  const filingReady = !filingSupported || filingReadiness?.status?.filerSigned === true
    || filingReadiness?.status?.signatureRequired === false;
  // The same gate `approve_form` applies, evaluated here so the reviewer reads
  // it as a list of files with a re-check button rather than as a refusal
  // sentence after the fact.
  const staleAttachments = staleFilingAttachments(filingReadiness);
  // Sealed FMLA answers that could not be opened  are never approved unseen.
  const filingBlocked = Boolean(item.answersUnavailable) || (filingSupported
    && (filingReadiness?.loading || filingReadiness?.error || !filingReady || staleAttachments.length > 0));

  // One lock for the dialog, as every action reads pending while
  // any of them runs.
  function run(kind) {
    return runBusyWrite(reviewWriteRef, "review", async () => {
      setBusy(kind);
      try { await onAction(kind, item.id, note.trim()); } finally { setBusy(""); }
    });
  }

  function renderValue(field) {
    const value = item.answers[field.key];
    if (Array.isArray(value)) return value.length ? value.join(", ") : t("steward.valueDash");
    if (value === true) return t("steward.valueYes");
    if (value == null || String(value).trim() === "") return t("steward.valueDash");
    return String(value);
  }

  return (
    <Dialog eyebrow={t("steward.reviewEyebrow")} title={`${item.memberName} — ${template ? t(template.titleKey) : item.templateKey}`} onClose={onClose} size="detail">
      {item.answersUnavailable && <p role="alert">{t("forms.sealedAnswersUnavailable")}</p>}
      {(template && !item.answersUnavailable ? template.steps : []).map((step) => (
        <section key={step.titleKey} className="detail-record">
          <h3>{t(step.titleKey)}</h3>
          <dl className="detail-facts">
            {step.fields.map((field) => (
              <div key={field.key}><dt>{t(field.labelKey)}</dt><dd>{renderValue(field)}</dd></div>
            ))}
          </dl>
        </section>
      ))}
      {item.cosigners?.length > 0 && (
        <p role="note">{t("steward.cosignedBy", { names: cosignerNamesWithKind(item.cosigners, filingReadiness?.status, t) })}</p>
      )}
      {filingSupported && filingReadiness?.loading && <p className="form-filing__hint" role="status">{t("forms.filing.loading")}</p>}
      {filingSupported && filingReadiness?.error && <p className="form-filing__status form-filing__status--error" role="alert">{filingReadiness.error}</p>}
      {filingSupported && filingReadiness?.status && (
        <>
          <FormFilingControls
            t={(key, vars) => t(`forms.filing.${key}`, vars)}
            files={filingReadiness.status.attachments || []}
            signatureCurrent={filingReadiness.status.filerSigned === true}
            onRecheckFile={onRecheckFile}
          />
          {staleAttachments.length > 0 && (
            <p className="form-filing__status form-filing__status--error" role="alert">
              {t("steward.attachmentsStale", { names: staleAttachments.map((row) => row.filename).join(", ") })}
            </p>
          )}
          <FilerSignatureKindNote status={filingReadiness.status} accountName={item.memberName} t={t} />
          {!filingReadiness.status.filerSigned && filingReadiness.status.signatureRequired !== false && <p className="form-filing__warning" role="note">{t("steward.signatureMissing")}</p>}
        </>
      )}
      {ownForm ? (
        <p role="note">{t("steward.ownForm")}</p>
      ) : (
        <form className="stack-form" onSubmit={(event) => event.preventDefault()}>
          <label>{t("steward.noteLabel")}
            <textarea value={note} maxLength="4000" onChange={(event) => setNote(event.target.value)} placeholder={t("steward.notePlaceholder")} />
          </label>
          <div className="cwk-actions">
            {item.status === "submitted" && (
              <BusyButton className="cwk-btn cwk-btn--soft" type="button" pending={busy !== ""} onClick={() => run("start")}>{t("steward.startReview")}</BusyButton>
            )}
            <BusyButton className="cwk-btn cwk-btn--green" type="button" pending={busy !== ""} disabled={filingBlocked} onClick={() => run("approve")}>{t("steward.approve")}</BusyButton>
            {grievance && (
              <BusyButton className="cwk-btn cwk-btn--green" type="button" pending={busy !== ""} disabled={filingBlocked} onClick={() => run("approveCase")}>{t("steward.approveCase")}</BusyButton>
            )}
            <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={busy !== ""} disabled={note.trim() === ""} onClick={() => run("return")}>{t("steward.returnWithNote")}</BusyButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}
