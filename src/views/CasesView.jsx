import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { EvidenceUpload } from "../components/EvidenceUpload.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zipSync } from "fflate";
// Union Ground issues carry no grievance procedure, no grievance step, no
// contract articles and no ULP or legal deadline: the ULP deadline chip and
// notice, the procedure-step progress panel, the step field and the articles
// field are left out of this view on purpose (owner decision, 2026-10-13).
import { CaseHistoryTimeline } from "../components/CaseHistoryTimeline.jsx";
import { Dialog } from "../components/Dialog.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { noStewardCopy } from "../lib/stewardConversations.js";
import { MemberApiError } from "../lib/memberApi.js";
import { caseDeadlinePhrase, sentenceStart } from "../lib/caseNextDeadline.js";
import { calendarDaysUntil } from "../features/memberHome/whatMattersNow.js";
import { useEasternCalendarDay } from "../lib/useLocalCalendarDay.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import { withObjectUrl } from "../lib/privateFileAccess.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { localeFor } from "../lib/i18n.js";
import { caseOutcomeLabelKey, caseOutcomeT } from "../lib/i18n/caseOutcome.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { CompassCaseHelp } from "../features/compass/CompassCaseHelp.jsx";
import { todayIso } from "../features/caseNotes/api.js";
import { CaseDetailsFields, CaseDetailsSummary, caseFieldsFromForm } from "../features/caseIntake/CaseDetailsFields.jsx";
import "../lib/i18n/features/caseNotesStrings.js";
import { caseStepLabel } from "../lib/caseHistoryValue.js";
import { caseTypeLabel } from "../lib/caseRowLine.js";
import { notePreview } from "../lib/notePreview.js";

// "Steward Sam Okafor · Coordinator Jordan Patel" — the design's assignee
// line, rendered only from server-stamped names (assign_member_case). Absent
// names mean an unassigned case and the line simply isn't there.
function assigneeLine(item, t) {
  const parts = [
    item.stewardName && `${t("cases.stewardLabel")} ${item.stewardName}`,
    item.coordinatorName && `${t("cases.coordinatorLabel")} ${item.coordinatorName}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// "May 28"-style short date for timeline nodes, in the member's language.
function shortDate(value, lang) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(localeFor(lang), { month: "short", day: "numeric" });
}

// The month tag on a closed-case row ("Mar"). The design stamps the month the
// case closed; the row has no closed_at, so the nearest real date is the last
// note's timestamp, else the deadline. No date at all → no tag.
function closedWhen(item, lang) {
  const last = item.updates?.length ? item.updates[item.updates.length - 1].created_at : null;
  const value = last || (item.deadlineValue ? `${item.deadlineValue}T00:00:00` : null);
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(localeFor(lang), { month: "short" });
}

// Chronological copy of a case's notes — memberApi loads them ascending, but
// the sort keeps the timeline honest if a caller ever hands them over unsorted.
function orderedUpdates(item) {
  return [...(item.updates ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// `details` is the separately read case record (description, incident date,
// remedy, informal or filed); null before the details exist, and then the
// packet simply has no details block.
export async function buildCasePacket(item, readFile, details = null) {
  const files = {};
  const manifest = (item.files || []).map(({ filename, mimeType, sizeBytes, createdAt }) => ({ filename, mimeType, sizeBytes, createdAt }));
  const summary = {
    reference: item.reference,
    title: item.title,
    type: item.type,
    status: item.status,
    deadline: item.deadlineValue || null,
    assignees: { steward: item.stewardName || null, coordinator: item.coordinatorName || null },
    ...(details ? { details: {
      description: details.description ?? null,
      incidentDate: details.incidentDate ?? null,
      remedySought: details.remedySought ?? null,
      filingStatus: details.filingStatus ?? null,
    } } : {}),
    // occurredOn is the date the member gave the note; null on older notes.
    notes: orderedUpdates(item).map(({ body, occurred_on, created_at }) => ({ body, occurredOn: occurred_on ?? null, createdAt: created_at })),
    documents: manifest,
    exportedAt: new Date().toISOString(),
  };
  for (const [index, file] of (item.files || []).entries()) {
    files[`documents/${String(index + 1).padStart(2, "0")}-${file.filename}`] = new Uint8Array(await readFile(file));
  }
  files["case-summary.json"] = new Uint8Array(new TextEncoder().encode(JSON.stringify(summary, null, 2)));
  return zipSync(files, { level: 6 });
}

export function CasesView({ data, renderAutomationLink = null, caseHelp = null, loadCaseDetails = null, onMessages, onCreateCase, onUpdateCase, onAddCaseUpdate, onAddCaseFile, onRemoveCaseFile, onOpenCaseFile, onRecheckCaseFile = null, focus = null, desktop = false, caseIntakeAvailable = true, stewardPresence = null, caseworkApi = null, onNotice = () => {} }) {
  const { t, lang } = useLang();
  const today = useEasternCalendarDay();
  const [newOpen, setNewOpen] = useDeviceParityState("cases.newOpen", false);
  const [selectedCaseId, setSelectedCaseId] = useDeviceParityState("cases.selectedCaseId", null);
  let urlCaseId = null;
  try { urlCaseId = new URLSearchParams(window.location.search).get("case"); } catch { /* keep the ordinary surface */ }
  const missingSourceReference = Boolean(urlCaseId && !data.cases.some((item) => item.id === urlCaseId));

  // URL navigation is an entry instruction, not durable selection state: the
  // link is consumed exactly once, but it keeps waiting until the projection
  // actually contains its target, so a saved copy or an older projection cannot
  // swallow it. Once consumed, refreshed arrays never reopen or replace the
  // dialog the member is looking at or has closed.
  const consumedUrlCaseRef = useRef(null);
  useEffect(() => {
    if (!urlCaseId || consumedUrlCaseRef.current === urlCaseId) return;
    if (!data.cases.some((item) => item.id === urlCaseId)) return;
    consumedUrlCaseRef.current = urlCaseId;
    setSelectedCaseId(urlCaseId);
  }, [urlCaseId, data.cases, setSelectedCaseId]);

  // The open case is the page's address (REQ-UG-STEWARD-CASEWORK-GAPS-20261030):
  // opening one writes ?case=<id>, closing it removes the parameter, so the
  // address bar can be copied, bookmarked or reloaded onto the same case.
  const writtenCaseRef = useRef(null);
  useEffect(() => {
    let url;
    try { url = new URL(window.location.href); } catch { return; }
    const current = url.searchParams.get("case");
    if (selectedCaseId && current !== selectedCaseId && data.cases.some((item) => item.id === selectedCaseId)) {
      consumedUrlCaseRef.current = selectedCaseId;
      writtenCaseRef.current = { path: url.pathname, id: selectedCaseId };
      url.searchParams.set("case", selectedCaseId);
    } else if (!selectedCaseId && current && consumedUrlCaseRef.current === current) {
      writtenCaseRef.current = null;
      url.searchParams.delete("case");
    } else return;
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [selectedCaseId, data.cases]);
  // Leaving the page drops the address this page wrote, unless navigation
  // already replaced it (another route, or another plane's own ?case= link).
  useEffect(() => () => {
    const written = writtenCaseRef.current;
    if (!written) return;
    let url;
    try { url = new URL(window.location.href); } catch { return; }
    if (url.pathname !== written.path || url.searchParams.get("case") !== written.id) return;
    url.searchParams.delete("case");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // Search deep-link: open the case dialog directly. The old filter part of
  // the payload is obsolete — every case is always on screen now (open cases
  // as cards, the rest under Closed), so nothing needs unhiding first.
  useEffect(() => {
    if (focus?.caseId) setSelectedCaseId(focus.caseId);
  }, [focus?.caseId, focus?.nonce, setSelectedCaseId]);

  // Deadline-first, like the design's caseload ordering; undated cases last.
  // A case runs to its first open deadline (a step deadline before its own).
  const firstDue = (item) => (item.nextDeadline?.kind === "step" ? item.nextDeadline.dueOn : item.deadlineValue) || "9999";
  const openCases = data.cases
    .filter((item) => item.status === "active")
    .sort((a, b) => firstDue(a).localeCompare(firstDue(b)));
  const closedCases = data.cases.filter((item) => item.status !== "active");
  const selectedCase = data.cases.find((item) => item.id === selectedCaseId);
  const caseScopeKey = JSON.stringify([data.member?.id, data.member?.organizationId, data.member?.chapterId, data.member?.membershipStatus]);

  // The gold "now" node's deadline line — the design paints it red because it
  // is the employer's clock. Overdue keeps the existing wording.
  const dueLine = (item) => {
    // BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
    // an open step deadline before the case's own deadline is the date shown,
    // labeled, in the words staff What to do next uses; a missed one reads as
    // passed.
    const next = item.nextDeadline;
    if (next?.kind === "step") {
      return sentenceStart(caseDeadlinePhrase(t, { kind: "step", label: next.label, days: calendarDaysUntil(next.dueOn, today, next.timeZone), dueOn: next.dueOn }, lang));
    }
    // deadline is ALWAYS a label (the API stamps "Not set" for null), so the
    // honest gate is deadlineValue — otherwise an undated case reads the
    // grammatical accident "Due Not set".
    if (!item.deadlineValue) return t("mcases.noDeadline");
    const date = shortDate(`${item.deadlineValue}T12:00:00`, lang);
    return item.overdue ? `${t("cases.overdue")} — ${date}` : t("mcases.due", { date });
  };

  // #9595: with no steward named for the reader (stewardPresence), step 2
  // does not promise a steward's review within 24 hours, step 2 says who is
  // missing and who can name one, and the way into Messages (where the
  // chapter's officers are listed) is Go to Messages, not Talk to your steward.
  const noStewardStep = noStewardCopy(stewardPresence);
  const emptyBlock = (
    <>
      <section className="mcases-empty">
        <h2>{t(caseIntakeAvailable ? "mcases.emptyTitle" : "mcases.setupTitle")}</h2>
        {/* #9595 (Grok read of #9682, P2): no "your steward walks with you" with no steward named. */}
        <p>{t(!caseIntakeAvailable ? "mcases.setupBody" : noStewardStep ? "mcases.emptyBodyNoSteward" : "mcases.emptyBody")}</p>
      </section>
      <h2 className="mcases-eyebrow">{t("mcases.howItWorks")}</h2>
      <div className="mcases-steps">
        {[1, 2, 3].map((n) => (
          <div className="mcases-step" key={n}>
            <span className="mcases-step__num" aria-hidden="true">{n}</span>
            <span className="mcases-step__copy">
              <span className="mcases-step__title">{n === 2 && noStewardStep ? t(noStewardStep.title) : t(`mcases.how${n}Title`)}</span>
              <span className="mcases-step__sub">{n === 2 && noStewardStep ? t(noStewardStep.who) : t(`mcases.how${n}Sub`)}</span>
            </span>
          </div>
        ))}
      </div>
      {caseIntakeAvailable && <button className="mcases-primary" type="button" onClick={() => setNewOpen(true)}>{t("mcases.startCase")}</button>}
      {typeof onMessages === "function" && (
        <button className="mcases-ghost" type="button" onClick={onMessages}>{t(noStewardStep ? "mcases.openMessages" : "mcases.talkSteward")}</button>
      )}
    </>
  );

  // Mobile open-case card: status chip + reference, title, assignees, then the
  // design's vertical timeline — every real note a green node, the open
  // issue the glowing gold node carrying the deadline.
  const mobileCase = (item) => {
    const updates = orderedUpdates(item);
    const due = dueLine(item);
    return (
      <article className="mcases-case" key={item.id}>
        <div className="mcases-case__top">
          <span className="mcases-case__stepchip">{t("mcases.openChip")}</span>
          <span className="mcases-case__ref">{item.reference}</span>
        </div>
        <button className="mcases-case__title" type="button" onClick={() => setSelectedCaseId(item.id)}>
          {item.title} <span className="mcases-case__chev" aria-hidden="true">›</span>
        </button>
        {assigneeLine(item, t) && <p className="mcases-case__who">{assigneeLine(item, t)}</p>}
        <div className="mcases-tl" aria-label={t("mcases.timelineAria")}>
          {updates.map((update) => (
            <div className="mcases-tl__row" key={update.id}>
              <div className="mcases-tl__rail"><span className="mcases-tl__dot" /><span className="mcases-tl__line" /></div>
              <div className="mcases-tl__copy">
                <div className="mcases-tl__label">{notePreview(update.body)}</div>
                <div className="mcases-tl__sub">{shortDate(update.created_at, lang)}</div>
              </div>
            </div>
          ))}
          <div className="mcases-tl__row">
            <div className="mcases-tl__rail"><span className="mcases-tl__dot mcases-tl__dot--now" /></div>
            <div className="mcases-tl__copy">
              <div className="mcases-tl__label">{t("mcases.openChip")}</div>
              {due && <div className={`mcases-tl__due${item.deadlineValue ? "" : " mcases-tl__due--none"}`}>{due}</div>}
            </div>
          </div>
        </div>
      </article>
    );
  };

  // Desktop open-case card (pg.mycases "stat lift"): header row with dotted
  // title + step chip, a horizontal stage strip (the stages before the
  // current one, the gold current node, an empty Resolution node), and the
  // Latest bar. #9569: the strip shows stages only; a case note is never a
  // step, and an earlier stage is drawn like Resolution, with no completion
  // mark. The latest note is in the Latest bar and every note is in the case
  // dialog's history, as the phone's case timeline shows them.
  const desktopCase = (item) => {
    const updates = orderedUpdates(item);
    // No grievance stages in this edition: the strip is the open node and Resolution.
    const strip = [];
    const latest = updates.length ? updates[updates.length - 1] : null;
    const due = dueLine(item);
    return (
      <article className="mcases-desk" key={item.id}>
        <div className="mcases-desk__head">
          <button className="mcases-desk__title" type="button" onClick={() => setSelectedCaseId(item.id)}>
            <span className="mcases-desk__titletext">{item.title}</span>
            <span className="mcases-desk__chip">{t("mcases.openChip")}</span>
          </button>
          <p className="mcases-desk__meta">{[item.reference, assigneeLine(item, t)].filter(Boolean).join(" · ")}</p>
        </div>
        <div className={`mcases-desk__strip${strip.length === 0 ? " mcases-desk__strip--center-current" : ""}`}>
          {strip.map((stage) => (
            <div className="mcases-desk__node" key={stage}>
              <span className="mcases-desk__icon mcases-desk__icon--todo" aria-hidden="true" />
              <div className="mcases-desk__nlabel mcases-desk__nlabel--todo">{caseStepLabel(stage, t)}</div>
            </div>
          ))}
          <div className="mcases-desk__node">
            <span className="mcases-desk__icon mcases-desk__icon--now" aria-hidden="true">●</span>
            <div className="mcases-desk__nlabel">{t("mcases.openChip")}</div>
            {due && <div className={`mcases-desk__nsub${item.deadlineValue ? " mcases-desk__nsub--due" : ""}`}>{due}</div>}
          </div>
          <div className="mcases-desk__node">
            <span className="mcases-desk__icon mcases-desk__icon--todo" aria-hidden="true" />
            <div className="mcases-desk__nlabel mcases-desk__nlabel--todo">{t("mcases.resolution")}</div>
            <div className="mcases-desk__nsub">—</div>
          </div>
        </div>
        {latest && (
          <button className="mcases-desk__latest" type="button" onClick={() => setSelectedCaseId(item.id)}>
            <span className="mcases-desk__latesttext">
              {t("mcases.latest")} — <b>{shortDate(latest.created_at, lang)}:</b> {notePreview(latest.body)}
            </span>
            <span className="mcases-desk__full">{t("mcases.fullCase")}</span>
          </button>
        )}
      </article>
    );
  };

  const dialogs = (
    <>
      {missingSourceReference && <p role="status">{t("cases.unavailable")}</p>}
      {caseIntakeAvailable && newOpen && <NewCaseDialog onClose={() => setNewOpen(false)} onCreate={onCreateCase} />}
      {selectedCase && <CaseDetailDialog key={`${caseScopeKey}:${selectedCase.id}`} scopeKey={caseScopeKey} automationLink={renderAutomationLink?.(selectedCase.id)} caseHelp={caseHelp} loadCaseDetails={loadCaseDetails} item={selectedCase} onClose={() => setSelectedCaseId(null)} onUpdate={onUpdateCase} onAddUpdate={onAddCaseUpdate} onAddFile={onAddCaseFile} onRemoveFile={onRemoveCaseFile} onOpenFile={onOpenCaseFile} onRecheckFile={onRecheckCaseFile} caseworkApi={caseworkApi} onNotice={onNotice} />}
    </>
  );

  if (desktop) {
    return (
      <div className="screen mcases mcases--desktop">
        <header className="mcases-ph">
          <div className="mcases-ph__copy">
            <h1 className="mcases-ph__title">{t("nav.myCases")}</h1>
            <p className="mcases-ph__sub">{t("mcases.deskSubtitle")}</p>
          </div>
          {caseIntakeAvailable && <button className="mcases-ph__new" type="button" onClick={() => setNewOpen(true)}>{t("mcases.startNewCase")}</button>}
        </header>
        {openCases.length === 0 && emptyBlock}
        {openCases.map(desktopCase)}
        {closedCases.length > 0 && (
          <section className="mcases-panel" aria-label={t("mcases.closedCases")}>
            <h2 className="mcases-panel__title">{t("mcases.closedCases")}</h2>
            <div className="mcases-panel__list">
              {closedCases.map((item) => (
                <button className="mcases-panel__row" type="button" key={item.id} onClick={() => setSelectedCaseId(item.id)}>
                  <span className="mcases-panel__chip">{t("mcases.resolvedChip")}</span>
                  <span className="mcases-panel__rowtitle">{item.title}</span>
                  {closedWhen(item, lang) && <span className="mcases-panel__when">{closedWhen(item, lang)}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="screen mcases">
      <div className="mcases-head">
        <div className="mcases-head__row">
          <h1 className="mcases-title">{t("nav.myCases")}</h1>
          {caseIntakeAvailable && <button className="mcases-new" type="button" onClick={() => setNewOpen(true)}>{t("mcases.new")}</button>}
        </div>
        <p className="mcases-sub">{t("mcases.subtitle")}</p>
      </div>
      {openCases.length === 0 ? emptyBlock : openCases.map(mobileCase)}
      {closedCases.length > 0 && (
        <div>
          <h2 className="mcases-eyebrow">{t("mcases.closed")}</h2>
          <div className="mcases-closed">
            {closedCases.map((item) => (
              <button className="mcases-closed__row" type="button" key={item.id} onClick={() => setSelectedCaseId(item.id)}>
                <span className="mcases-closed__chip">{t("mcases.resolvedChip")}</span>
                <span className="mcases-closed__title">{item.title}</span>
                {closedWhen(item, lang) && <span className="mcases-closed__when">{closedWhen(item, lang)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function NewCaseDialog({ onClose, onCreate }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy) return;
      const form = new FormData(event.currentTarget);
      setSaveError("");
      return async (releaseBusyWrite) => {
        setBusy(true);
        try {
          await onCreate(caseFieldsFromForm(form));
          onClose();
        } catch (error) {
          // Stay open so the draft survives. mutate()'s shell notice sits behind
          // modal isolation, so the refusal is announced here, in catalogue copy.
          setSaveError(rpcErrorKeyStrict(error, "toast.saveFailed"));
        } finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  return <Dialog eyebrow={t("cases.intakeEyebrow")} title={t("cases.startNewCase")} onClose={onClose}><form className="stack-form" onSubmit={submit}><CaseDetailsFields pending={busy} own />{saveError && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, saveError)}</p>}<BusyButton className="dialog-primary" pending={busy}>{busy ? t("cases.creating") : t("cases.createCase")}</BusyButton></form></Dialog>;
}

function CaseDetailDialog({ item, scopeKey, automationLink = null, caseHelp = null, loadCaseDetails = null, onClose, onUpdate, onAddUpdate, onAddFile, onRemoveFile, onOpenFile, onRecheckFile = null, caseworkApi = null, onNotice = () => {} }) {
  const busyWriteRef = useRef(new Set());
  const { t, lang } = useLang();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [caseSaved, setCaseSaved] = useState(false);
  // Inputs remain editable during a save; a late response confirms only its draft.
  const caseEditRevision = useRef(0);
  const [noteError, setNoteError] = useState("");
  const noteSaving = useRef(false);
  const noteSequence = useRef(0);
  const awaitingHistory = useRef(new Map());
  const [savedNoteRevision, setSavedNoteRevision] = useState(0);
  const [noteSaved, setNoteSaved] = useState(false);
  const [duplicateNote, setDuplicateNote] = useState(null);
  // A committed note must invalidate history even if the parent projection's
  // follow-up read failed or kept the same item. The keyed dialog scopes this
  // signal (and any late save completion) to its original case.
  const historyRefreshKey = useMemo(() => ({ item, savedNoteRevision }), [item, savedNoteRevision]);
  const historyLoaded = useCallback((key) => {
    // A read begun before a later save cannot unlock that later note. Only an
    // authoritative first page, or an explicit repeat, releases the guard.
    for (const [body, revision] of awaitingHistory.current) {
      if (revision <= key.savedNoteRevision) awaitingHistory.current.delete(body);
    }
    setDuplicateNote((body) => awaitingHistory.current.has(body) ? body : null);
  }, []);
  const [fileError, setFileError] = useState("");
  // Three states the old boolean `busy` could not express:
  //   checking — bytes are up, the verdict is not in, nothing is attached yet
  //   rejected — a decision about these bytes; permanent, no retry offered
  //   stale    — the clean verdict aged out; one re-check is the whole fix
  const [phase, setPhase] = useState("");
  const [staleFileId, setStaleFileId] = useState("");
  // A case a steward or coordinator holds is moved by the representative
  // (#7980): the member reads its status and deadline, and
  // update_my_member_case refuses an edit. (No organization procedure governs
  // an issue in this edition.)
  // The server answers for an assignment the row carries by account only.
  const getMyCaseManaged = caseworkApi?.getMyCaseManaged || null;
  const [serverManaged, setServerManaged] = useState(false);
  useEffect(() => {
    let live = true;
    setServerManaged(false);
    if (!getMyCaseManaged) return undefined;
    Promise.resolve().then(() => getMyCaseManaged(item.id)).then((result) => { if (live) setServerManaged(result === true); }).catch(() => { if (live) setServerManaged(false); });
    return () => { live = false; };
  }, [getMyCaseManaged, item.id, item.stewardName, item.coordinatorName]);
  const managedByStaff = Boolean(item.stewardName || item.coordinatorName || serverManaged);
  // The outcome a coordinator recorded (#7195): the member sees what was
  // decided and its summary, not only the Resolved status. CaseOutcome reads
  // it (#9984).
  const loadCaseOutcome = caseworkApi?.loadCaseOutcome || null;
  const resolved = item.status === "resolved";
  function clearFileState() {
    setFileError("");
    setPhase("");
    setStaleFileId("");
  }
  // A rejection is final, so the surface must not offer a retry that cannot
  // succeed; everything else is an ordinary failure the member may repeat.
  // A MemberApiError message is `${label}: ${driver text}` and never reaches
  // the member; copy the app authored itself (demo vault, etc.) still does.
  function reportFileError(error) {
    const code = error?.privateFileCode || "";
    if (code === "rejected") { setPhase("rejected"); setFileError(t("uploads.rejected")); return; }
    if (code === "rate-limited") { setPhase(""); setFileError(t("uploads.rateLimited")); return; }
    if (code === "pending-check") { setPhase(""); setFileError(t("uploads.pendingCheck")); return; }
    if (code === "unsupported-format") { setPhase(""); setFileError(t("uploads.unsupportedFormat")); return; }
    setPhase("");
    setFileError(error instanceof MemberApiError ? t("cases.fileFailed") : (error?.message || t("cases.fileFailed")));
  }
  async function save(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy) return;
      const form = new FormData(event.currentTarget);
      return async (releaseBusyWrite) => {
        setBusy(true);
        setSaveError("");
        const fields = { status: String(form.get("status")), deadline: String(form.get("deadline")) };
        const submittedRevision = caseEditRevision.current;
        setCaseSaved(false);
        try {
          await onUpdate(item.id, fields);
          setCaseSaved(caseEditRevision.current === submittedRevision);
        }
        catch (error) { setSaveError(rpcErrorKeyStrict(error, "toast.saveFailed")); }
        finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  async function addUpdate(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy || noteSaving.current) return;
      const formElement = event.currentTarget;
      const draft = String(new FormData(formElement).get("update") || "");
      const occurredOn = String(new FormData(formElement).get("occurredOn") || "");
      const body = draft.trim();
      if (!body) return;
      return async (releaseBusyWrite) => {
        setNoteError("");
        const repeatConfirmed = event.nativeEvent.submitter?.name === "repeatSavedNote" && duplicateNote === body;
        if (awaitingHistory.current.has(body) && !repeatConfirmed) {
          setDuplicateNote(body);
          setNoteSaved(true);
          releaseBusyWrite();
          return;
        }
        noteSaving.current = true;
        setDuplicateNote(null);
        setNoteSaved(false);
        setBusy(true);
        try {
          await onAddUpdate(item.id, body, occurredOn || null);
          const revision = ++noteSequence.current;
          if (caseworkApi?.loadCaseHistory && caseworkApi.caseNoteWritesAvailable !== false) awaitingHistory.current.set(body, revision);
          setSavedNoteRevision(revision);
          // Keep a newer draft entered while this note was being saved, and do not
          // show "saved" beside it: only the submitted text was stored.
          const unchanged = String(new FormData(formElement).get("update") || "") === draft;
          // A fixture can read history while its note writer remains a no-op;
          // the parent owns that preview notice.
          setNoteSaved(unchanged && Boolean(caseworkApi?.loadCaseHistory) && caseworkApi.caseNoteWritesAvailable !== false);
          if (unchanged) formElement.reset();
        } catch (error) { setNoteError(rpcErrorKeyStrict(error, "toast.saveFailed")); }
        finally { noteSaving.current = false; setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  async function addFile(file, options) {
    clearFileState();
    return onAddFile(item.id, file, options);
  }
  async function openFile(file) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy) return;
      return async (releaseBusyWrite) => {
        setBusy(true);
        clearFileState();
        // Open the tab synchronously on the tap so Safari/iOS keep the transient
        // user-activation window; awaiting the bytes first (the old code) consumes
        // activation and window.open silently opens nothing there.
        // Passing `noopener` can make Safari return null even when it opened the
        // tab. Keep the WindowProxy long enough to navigate it, but sever the
        // opener synchronously before the authenticated read starts.
        const popup = window.open("", "_blank");
        if (!popup) { setFileError(t("uploads.popupBlocked")); setBusy(false); releaseBusyWrite(); return; }
        popup.opener = null;
        try {
          const blob = await onOpenFile(file);
          // withObjectUrl defers the revoke: the tab has not fetched the URL yet
          // when this returns, and revoking in the same turn shows a blank viewer.
          withObjectUrl(blob, (url) => { popup.location = url; });
        } catch (error) {
          popup.close();
          // Storage refusing an otherwise-authorized read means the clean verdict
          // aged out. One re-check fixes it, so offer that instead of a dead end.
          if (error?.privateFileCode === "stale" && onRecheckFile) {
            setStaleFileId(file.id);
            setFileError(t("uploads.stale"));
          } else {
            reportFileError(error);
          }
        } finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    });
  }

  async function recheckFile(file) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy || !onRecheckFile) return;
      return async (releaseBusyWrite) => {
        setBusy(true);
        setPhase("checking");
        setFileError("");
        try {
          await onRecheckFile(file);
          setStaleFileId("");
          setPhase("");
        } catch (error) {
          setPhase("");
          setFileError(error?.privateFileCode === "rejected" ? t("uploads.rejected") : t("uploads.recheckFailed"));
          if (error?.privateFileCode === "rejected") setStaleFileId("");
        } finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    });
  }
  async function removeFile(file) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy) return;
      return async (releaseBusyWrite) => {
        setBusy(true);
        clearFileState();
        try { await onRemoveFile(item.id, file); }
        catch (error) { reportFileError(error); }
        finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    });
  }
  async function exportPacket() {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy) return;
      return async (releaseBusyWrite) => {
        setBusy(true);
        clearFileState();
        // Only the attachment name is shown; the underlying error text is not.
        let failedFile = "";
        try {
          // Read each attachment through the same authenticated download the open
          // button uses. A stale verdict is reported per file and never re-checked
          // automatically: one export over a large case would otherwise spend the
          // member's whole hourly inspection allowance in a single click.
          // The case details travel with the packet (REQ-UG-STEWARD-CASEWORK-GAPS-20261030).
          // A real read failure fails the export rather than dropping them.
          const details = loadCaseDetails ? await loadCaseDetails(item.id) : null;
          const packet = await buildCasePacket(item, async (file) => {
            try {
              const blob = await onOpenFile(file);
              return await blob.arrayBuffer();
            } catch (error) {
              failedFile = file.filename;
              throw error;
            }
          }, details);
          const blob = new Blob([packet], { type: "application/zip" });
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          anchor.download = `${String(item.reference || "grievance").replace(/[^a-zA-Z0-9_-]/g, "-")}-packet.zip`;
          anchor.click();
          URL.revokeObjectURL(anchor.href);
        } catch { setFileError(failedFile ? t("cases.packetFileFailed", { name: failedFile }) : t("cases.packetFailed")); }
        finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    });
  }
  // The case type rides the detail copy line: the redesigned cards drop the
  // old type pill, and this dialog is where the field stays reachable.
  return <Dialog eyebrow={item.reference} title={item.title} onClose={onClose} wide>{automationLink}<p className="case-detail-copy">{caseTypeLabel(item.type, t)}</p><CaseDetailsSummary caseId={item.id} loadDetails={loadCaseDetails} />{assigneeLine(item, t) && <p className="case-assignees">{assigneeLine(item, t)}</p>}<CaseOutcome item={item} loadCaseOutcome={loadCaseOutcome} />{managedByStaff ? <div className="stack-form case-managed-fields"><p className="case-step-managed"><span>{t("cases.status")}</span><br /><strong>{resolved ? t("cases.statusResolved") : t("cases.statusActive")}</strong></p><p className="case-step-managed"><span>{t("cases.deadlineField")}</span><br /><strong>{item.deadlineValue ? item.deadline : t("mcases.noDeadline")}</strong></p><p><small>{t("cases.managedByRepresentative")}</small></p></div> : <form className="stack-form stack-form--grid" onSubmit={save} onChange={() => { caseEditRevision.current += 1; setCaseSaved(false); }}><label>{t("cases.status")}<select name="status" defaultValue={item.status}><option value="active">{t("cases.statusActive")}</option><option value="resolved">{t("cases.statusResolved")}</option></select></label><label>{t("cases.deadlineField")}<input name="deadline" type="date" defaultValue={item.deadlineValue} /></label>{saveError && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, saveError)}</p>}<BusyButton className="dialog-primary" pending={busy}>{busy ? t("cases.saving") : caseSaved ? t("cases.saved") : t("cases.saveCase")}</BusyButton>{caseSaved && <p role="status">{t("cases.saveConfirmed")}</p>}</form>}<section className="case-files" aria-labelledby={`case-files-${item.id}`}><div className="case-files__head"><div><h3 id={`case-files-${item.id}`}>{t("cases.documents")}</h3><p>{t("caseNotes.memberDocumentsHelp")}</p></div><BusyButton type="button" className="dialog-secondary" pending={busy} onClick={exportPacket}>{t("cases.exportPacket")}</BusyButton></div>{onAddFile && <EvidenceUpload scopeKey={item.id} label={t("cases.addDocument")} disabled={busy} onBusyChange={setBusy} onUpload={addFile} />}{phase === "checking" && <p className="case-files__checking" role="status" aria-live="polite">{t("uploads.checking")}</p>}{fileError && <p className="case-files__error" role="alert">{fileError}</p>}{(item.files || []).length ? <ul className="case-files__list">{item.files.map((file) => <li key={file.id}><span><b>{file.filename}</b><small>{Math.ceil(file.sizeBytes / 1024)} KB</small></span><span className="case-files__actions"><BusyButton type="button" pending={busy} aria-label={`${t("cases.openDocument")}: ${file.filename}`} onClick={() => openFile(file)}>{t("cases.openDocument")}</BusyButton>{staleFileId === file.id && onRecheckFile && <BusyButton type="button" pending={busy} aria-label={`${busy ? t("uploads.rechecking") : t("uploads.recheck")}: ${file.filename}`} onClick={() => recheckFile(file)}>{busy ? t("uploads.rechecking") : t("uploads.recheck")}</BusyButton>}<BusyButton type="button" pending={busy} aria-label={`${t("cases.removeDocument")}: ${file.filename}`} onClick={() => removeFile(file)}>{t("cases.removeDocument")}</BusyButton></span></li>)}</ul> : <p className="case-files__empty">{t("cases.noDocuments")}</p>}</section>{caseHelp && <CompassCaseHelp caseId={item.id} ask={caseHelp.ask} includesNarrative={caseHelp.includesNarrative} onAddNote={caseHelp.addNote || null} />}{caseworkApi?.loadRetaliationReports && <RetaliationPanel caseId={item.id} api={caseworkApi} onNotice={onNotice} />}{caseworkApi?.loadCaseHistory ? <CaseHistoryTimeline caseId={item.id} api={caseworkApi} memberOnly scopeKey={scopeKey} refreshKey={historyRefreshKey} onFirstPageLoaded={historyLoaded} /> : <section className="case-timeline"><h3>{t("cases.caseNotes")}</h3>{item.updates.length ? item.updates.map((update) => { const timestamp = formatEasternTimestamp(update.created_at, lang); return <article key={update.id}><p>{update.body}</p><time dateTime={timestamp?.dateTime}>{timestamp?.text || t("operations.audit.timeUnavailable")}</time></article>; }) : <p>{t("cases.noNotes")}</p>}</section>}<form className="thread-composer" onSubmit={addUpdate}><textarea onChange={() => { setDuplicateNote(null); setNoteSaved(false); }} name="update" placeholder={t("caseNotes.memberNotePlaceholder")} required /><label className="case-note-date">{t("caseNotes.dateLabel")}<input type="date" name="occurredOn" defaultValue={todayIso()} max={todayIso()} /></label>{noteError && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, noteError)}</p>}<BusyButton className="dialog-primary" pending={busy}>{t("cases.addNote")}</BusyButton>{noteSaved && <p role="status">{t("toast.caseNoteSaved")}</p>}{duplicateNote && <><p role="alert">{t("cases.noteAlreadySaved")}</p><BusyButton className="dialog-secondary" type="submit" name="repeatSavedNote" pending={busy}>{t("cases.addNoteAgain")}</BusyButton></>}</form></Dialog>;
}

// The member's words for a recorded outcome live in ./lib/i18n/caseOutcome.js.
// Only a resolved case shows it (reopening keeps the earlier outcome row), and
// every refreshed projection of the case re-reads it, so a correction that
// keeps the case resolved still reaches an open dialog (#7195).
// BUG-UG-MEMBER-CASE-OUTCOME-VANISHES-ON-A-FAILED-READ-20261125 (#9984,
// from #9465): a failed read is not "no outcome recorded". A refusal for role
// or scope (42501) still shows nothing; any other failure says the outcome
// could not be loaded, or, after a refresh, that the one shown may be out of
// date. "No outcome to show yet" is said only after a retry the server
// answered with no row; it never claims that nothing was recorded, since a
// row the reader may not see also reads as none. The retry lock and pending state belong to one case scope; focus
// moves to the heading only when Try again still held it; and while a retry
// runs a loading line replaces the alert, so a second failure is announced.
const NO_OUTCOME = Object.freeze({ caseId: null, outcome: null, failed: false, retried: false });

function CaseOutcome({ item, loadCaseOutcome }) {
  const { lang } = useLang();
  const caseId = item.id;
  const resolved = item.status === "resolved";
  const [state, setState] = useState(NO_OUTCOME);
  const [retrying, setRetrying] = useState(false);
  const scopeRef = useRef(null);
  const retryRef = useRef(null);
  const headingRef = useRef(null);
  const focusHeadingRef = useRef(false);
  useEffect(() => {
    if (!focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    // #9984: only when no other control took focus since the check.
    const active = globalThis.document?.activeElement;
    if (!active || active === globalThis.document.body || active === retryRef.current) headingRef.current?.focus();
  });
  useEffect(() => {
    let live = true;
    setRetrying(false);
    // A refreshed projection of the same resolved case keeps what is shown
    // until its read lands. Without a loader, or on a case that is not
    // resolved, nothing is kept: the section shows nothing, as before.
    setState((current) => (resolved && loadCaseOutcome && current.caseId === caseId ? current : NO_OUTCOME));
    if (!loadCaseOutcome || !resolved) return undefined;
    let latest = 0;
    const load = (retried = false) => {
      const mine = ++latest;
      return Promise.resolve().then(() => loadCaseOutcome(caseId)).then((result) => {
        if (!live || mine !== latest) return;
        // Checked before the commit that removes Try again.
        if (retried && retryRef.current && retryRef.current === globalThis.document?.activeElement) focusHeadingRef.current = true;
        setState({ caseId, outcome: result || null, failed: false, retried });
      }, (error) => {
        if (!live || mine !== latest) return;
        setState((current) => (error?.code === "42501" ? NO_OUTCOME : { ...(current.caseId === caseId ? current : NO_OUTCOME), caseId, failed: true }));
      });
    };
    const scope = { load, locks: { current: new Set() }, isLive: () => live };
    scopeRef.current = scope;
    load();
    return () => { live = false; if (scopeRef.current === scope) scopeRef.current = null; };
  }, [loadCaseOutcome, item, caseId, resolved]);
  function retry() {
    const scope = scopeRef.current;
    if (!scope) return undefined;
    return runBusyWrite(scope.locks, "retrying", async (releaseBusyWrite) => {
      setRetrying(true);
      try { await scope.load(true); } finally {
        if (scope.isLive()) setRetrying(false);
        releaseBusyWrite();
      }
    });
  }
  const shown = resolved && loadCaseOutcome && state.caseId === caseId ? state : NO_OUTCOME;
  const { outcome, failed, retried } = shown;
  if (!outcome && !failed && !retried) return null;
  const recorded = outcome ? shortDate(outcome.updatedAt || outcome.recordedAt, lang) : "";
  return <section className="case-outcome" aria-labelledby={`case-outcome-${caseId}`}>
    <h3 id={`case-outcome-${caseId}`} ref={headingRef} tabIndex={-1}>{caseOutcomeT(lang, "caseOutcome.title")}</h3>
    {outcome && <><p><strong>{caseOutcomeT(lang, caseOutcomeLabelKey(outcome.outcome))}</strong>{recorded && <small>{" · "}{caseOutcomeT(lang, "caseOutcome.recordedOn", { date: recorded })}</small>}</p><p>{outcome.summary}</p></>}
    {failed && <>
      {retrying
        ? <p key="loading" role="status">{caseOutcomeT(lang, "caseOutcome.loading")}</p>
        : <p key="failed" role="alert">{caseOutcomeT(lang, outcome ? "caseOutcome.staleError" : "caseOutcome.loadError")}</p>}
      <BusyButton ref={retryRef} type="button" pending={retrying} onClick={() => void retry()}>{caseOutcomeT(lang, "caseOutcome.retry")}</BusyButton>
    </>}
    {!failed && !outcome && <p role="status">{caseOutcomeT(lang, "caseOutcome.none")}</p>}
  </section>;
}

function RetaliationPanel({ caseId, api, onNotice }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  // A refused write shows its alert inside the form that was used, directly
  // above that form's button, because a long case dialog scrolls and an alert
  // at the top of the panel sits outside the visible area (A11Y-UNIONGROUND-
  // SHOW-REFUSED-RETALIATION-REPORT-S-ERROR-NEXT-SUBMIT-20261013). The message
  // is a catalogue key translated at render; the source is "submit" or the
  // withdrawn report's id.
  const [writeError, setWriteError] = useState({ message: "", source: "" });
  const [writeStatus, setWriteStatus] = useState("");
  const [state, setState] = useState({ loading: true, error: false, rows: [] });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: false }));
    try { setState({ loading: false, error: false, rows: await api.loadRetaliationReports(caseId) }); }
    catch { setState({ loading: false, error: true, rows: [] }); }
  };
  useEffect(() => { void load(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault(); if (busy) return;
      setWriteError({ message: "", source: "" });
      return async (releaseBusyWrite) => { setWriteStatus("");
      setBusy(true); const form = event.currentTarget; const values = new FormData(form);
      try {
        await api.submitRetaliationReport({ caseId, incidentAt: new Date(String(values.get("incidentAt"))).toISOString(), managementPerson: String(values.get("managementPerson")), protectedActivity: String(values.get("protectedActivity")), adverseAction: String(values.get("adverseAction")), requestedSupport: String(values.get("requestedSupport") || "") });
        form.reset(); await load();
        setWriteStatus(t("cases.retaliation.saved")); onNotice(t("cases.retaliation.saved"));
      } catch (error) {
        const message = rpcErrorKeyStrict(error, "cases.retaliation.failed");
        setWriteError({ message, source: "submit" }); onNotice(t(message));
      } finally { setBusy(false);
        releaseBusyWrite();
      }
          };
    }, event);
  }
  async function withdraw(event, reportId) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault(); if (busy) return;
      setWriteError({ message: "", source: "" });
      return async (releaseBusyWrite) => { setWriteStatus("");
      setBusy(true); const form = event.currentTarget;
      try { await api.withdrawRetaliationReport(reportId, String(new FormData(form).get("reason"))); await load(); setWriteStatus(t("cases.retaliation.withdrawn")); onNotice(t("cases.retaliation.withdrawn")); }
      catch (error) {
        const message = rpcErrorKeyStrict(error, "cases.retaliation.failed");
        setWriteError({ message, source: reportId }); onNotice(t(message));
      } finally { setBusy(false);
        releaseBusyWrite();
      }
          };
    }, event);
  }
  return <section className="case-files" aria-labelledby={`retaliation-${caseId}`}><div className="case-files__head"><div><h3 id={`retaliation-${caseId}`}>{t("cases.retaliation.title")}</h3><p>{t("cases.retaliation.help")}</p></div></div><p role="status" aria-live="polite">{writeStatus}</p>{state.loading ? <p>{t("cases.retaliation.loading")}</p> : state.error ? <p role="status">{t("cases.retaliation.unavailable")}</p> : state.rows.length === 0 ? <p>{t("cases.retaliation.none")}</p> : state.rows.map((row) => <article className="thread-message" key={row.id}><p><strong>{row.management_person}</strong> · {t("cases.retaliation.status")}: {row.status}</p><p>{row.adverse_action}</p>{row.status === "submitted" && <form className="stack-form" onSubmit={(event) => withdraw(event, row.id)}><label>{t("cases.retaliation.reason")}<input name="reason" minLength={3} maxLength={1000} required /></label>{writeError.message && writeError.source === row.id && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, writeError.message)}</p>}<BusyButton className="dialog-secondary" pending={busy}>{t("cases.retaliation.withdraw")}</BusyButton></form>}</article>)}<form className="stack-form" onSubmit={submit}><label>{t("cases.retaliation.person")}<input name="managementPerson" minLength={2} maxLength={200} required /></label><label>{t("cases.retaliation.incident")}<input name="incidentAt" type="datetime-local" required /></label><label>{t("cases.retaliation.activity")}<textarea name="protectedActivity" minLength={8} maxLength={4000} required /></label><label>{t("cases.retaliation.action")}<textarea name="adverseAction" minLength={8} maxLength={4000} required /></label><label>{t("cases.retaliation.support")}<textarea name="requestedSupport" maxLength={2000} /></label>{writeError.message && writeError.source === "submit" && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, writeError.message)}</p>}<BusyButton className="dialog-primary" pending={busy}>{t("cases.retaliation.submit")}</BusyButton></form></section>;
}
