import { FormAnswerReview as ReviewStep } from "../components/FormAnswerReview.jsx";
import { DraftSharingPanel, DraftSharingUnavailable } from "../features/chapterAccess/DraftSharingPanel.jsx";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, FilePenLine, FileText } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { chipStyle } from "../lib/chipStyle.js";
import { EmptyState } from "../components/Primitives.jsx";
import { CARD_CLASS, Switch } from "../components/Surfaces.jsx";
import { Dialog } from "../components/Dialog.jsx";
import { BusyButton, BusyInput } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { FormFilingControls } from "../components/FormFilingControls.jsx";
import { RadioGroup } from "../components/RadioGroup.jsx";
import { EMPTY_SIGNATURE, SignatureChoice } from "../components/SignatureChoice.jsx";
import { signatureIsReady } from "../lib/typedSignature.js";
import { OrganizationHtmlForms } from "../components/OrganizationHtmlForms.jsx";
import { FormAutofillOffer, ProfileFilledMark, useFormAutofill } from "../components/FormAutofillOffer.jsx";
import { pendingAutofillRecord, rememberPendingAutofill, restoredProfileFilled, templateAutofillFields } from "../lib/formAutofill.js";
import { FORM_TEMPLATES, formTemplatesForDues, templateByKey, formProgress, healthNoticeKeys, HEALTH_NOTICE_TEMPLATE_KEYS, templateRequiresSignature } from "../lib/formTemplates.js";
import { UnitWorkflowChoice, useUnitWorkflow } from "../features/chapterAccess/UnitWorkflowChoice.jsx";
import { unitSettingChoices } from "../lib/unitSettings.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { returnFocusAfterModal, useModalExit } from "../lib/useTransitionPresence.js";
import { advanceFormDraftLane, forgetListedReplayedForms, forgetReplayedNewForm, formDraftLaneTurn, formDraftSessionGeneration, memberDraftSaves, mountFormEditor, newFormEditorToken, replayedNewFormFor } from "../lib/formDraftSessions.js";
import "../lib/i18n/features/formAutofillStrings.js";
import "./formsView.css";

// Forms P4b (GAP-401/402) — the member-facing forms surface. A hub lists any
// in-progress (draft|returned) forms with their completion, offers the seven
// templates, and shows already-submitted forms read-only; a single schema-driven
// editor renders whichever template you open (fields switched on field.type),
// autosaves the draft on step change and ~1.2s after edits, and submits for
// steward review. All copy flows through t(); the parent owns the network
// (onSaveDraft/onSubmit) and its own toast — in demo both resolve null, the
// editor still tracks answers locally and returns to the hub.

const IN_PROGRESS = new Set(["draft", "returned"]);
const REVIEWED = ["submitted", "in_review", "approved"];

const STATUS_KEY = {
  draft: "forms.statusDraft",
  submitted: "forms.statusSubmitted",
  in_review: "forms.statusInReview",
  approved: "forms.statusApproved",
  returned: "forms.statusReturned",
};

const INPUT = {
  width: "100%",
  minHeight: 46,
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--input)",
  color: "var(--ink)",
  font: "inherit",
  // 16px is load-bearing: sub-16 focusable controls make iOS Safari zoom.
  fontSize: 16,
};

const AUTOSAVE_MS = 1200;
const NO_FORM_FILES = Object.freeze([]);
const NO_COSIGNERS = Object.freeze([]);
const NO_CLOSED_FORMS = Object.freeze([]);
const NO_DISCARDS = Object.freeze([]);
const DISCARDS_KEPT = 20;
const untrackedDiscard = (_templateKey, _formId, work) => work();

// The API upserts one in-progress form per member/template. Keep that writer
// ordered across editor mounts and handler re-renders, not just within one
// component. Idle entries retain the confirmed answers/version pair; promise
// callbacks and pending snapshots are released when the request settles.
// A rejected snapshot stays until a later save resolves, so a
// remounted editor still resumes and re-sends those answers (#5827 r7s2).
// Member lanes belong to one authentication session (formDraftSessions.js):
// an editor captures the session generation at mount, and once that session
// ends its saves and snapshots are refused, never applied or replayed (#6205).
// Identity-less previews use a weak handler scope rather than sharing another
// member's lane.
const previewDraftSaves = new WeakMap();
const KNOWN_SERVER_VERSIONS_LIMIT = 32;
let nextDraftSaveVersion = 0;
// Order-insensitive identity for stored answers; an absent row reads as empty.
function answersKey(answers) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(answers ?? {}));
}
// Data versions this lane has held as its baseline: the one it started from,
// versions its saves confirmed and versions adopted from a fresh load.
function rememberVersion(queue, version) {
  queue.versions.delete(version);
  queue.versions.add(version);
  if (queue.versions.size > KNOWN_SERVER_VERSIONS_LIMIT) queue.versions.delete(queue.versions.values().next().value);
}
function draftLane(memberId, generation, save, templateKey) {
  if (memberId && generation !== formDraftSessionGeneration()) return undefined;
  return (memberId ? memberDraftSaves.get(memberId) : previewDraftSaves.get(save))?.get(templateKey);
}
// Starts the lane again from a null baseline: the form it saved is no longer
// the member's in-progress form of this template. It keeps only its version
// floor and withdraws anything still queued.
function resetDraftLane(queue) {
  queue.snapshot = null;
  queue.withdrawnThrough = queue.version;
  queue.versions.clear();
  queue.reconciliation += 1;
  queue.formEpoch = (queue.formEpoch ?? 0) + 1;
  queue.baseVersion = null;
  queue.confirmed = { answers: {}, baseVersion: null, revision: 0 };
  queue.savedSinceLoad = false;
  queue.formId = null;
  rememberVersion(queue, null);
}
// Keep loaded answers and their version together. A known older projection
// uses the confirmed pair instead. A changed load can recover an uncertain
// save only when it matches that pending snapshot; historical answer equality
// alone never authorizes replaying a rejected edit (#6289 r1s1/r1s2).
// The lane belongs to one form. A fresh projection that shows that form no
// longer in progress (submitted on another device, or a submission whose
// reply was lost), or that opens a different form of the template, resets the
// lane first, so a new draft never inherits the old form's version (#6329).
// Retirement is by identity only. A lane learns its form id before its first
// answers are sent (the save prepares the draft and reports its id), so a
// lost save reply never leaves a lane that wrote answers unbound (#6363
// round 2).
function laneFormClosed(queue, templateKey, closedForms) {
  return Boolean(queue.formId) && closedForms.some((form) => form.templateKey === templateKey && form.id === queue.formId);
}
// A form's absence from a forms list never resets a lane: no list proves the
// draft is gone, whatever its age, freshness or completeness (#8309 finals
// 5 and 6). A lane bound to a draft discarded in another tab or device keeps
// it until a save naming it is refused (PT409 form_not_editable); the editor
// then ends as Main's closed-elsewhere state and the lane retires (#8702).
// An ordinary form's load names the revision it read (#9092). The lane takes
// it only when it is higher than the one the lane holds: a load at or below
// it (a list row read before the lane's last save landed, #8972, or one
// that only caught up with it) is an older or the same write, whatever its
// answers. The lane also remembers whether its confirmed answers came from
// its own last confirmed save (savedSinceLoad, set in saveDraftInOrder): a
// load that names no revision, or the very revision that save wrote, is not
// newer than it, so it never reconciles the lane back to older answers —
// the reopen after a failed forms refresh (#8972). A higher revision, or a
// sealed load at another version, is newer and still reconciles.
function pendingDraftFor(memberId, generation, save, templateKey,
  { serverAnswers, serverVersion = null, serverRevision = undefined, serverFormId = null, closedForms = [] } = {}) {
  const queue = draftLane(memberId, generation, save, templateKey);
  if (!queue) return undefined;
  if (serverAnswers === undefined) return queue.snapshot || undefined;
  if (laneFormClosed(queue, templateKey, closedForms) || (queue.formId && serverFormId && serverFormId !== queue.formId)) {
    resetDraftLane(queue);
  }
  // Only a load naming the very form this lane last saved can be the stale
  // row of #8972; a fresh form's load (no form named) reconciles as before.
  const savedFormLoad = Boolean(queue.savedSinceLoad && serverFormId && queue.formId && serverFormId === queue.formId);
  if (serverFormId) queue.formId = serverFormId;
  if (Number.isSafeInteger(serverRevision)) {
    const held = queue.confirmed.revision ?? 0;
    if (serverRevision > held) {
      if (!queue.snapshot || answersKey(serverAnswers) !== answersKey(queue.snapshot.answers)) {
        queue.snapshot = null;
        queue.withdrawnThrough = queue.version;
      }
      queue.reconciliation += 1;
      queue.confirmed = { answers: serverAnswers ?? {}, baseVersion: queue.confirmed.baseVersion ?? null, revision: serverRevision };
      queue.savedSinceLoad = false;
    } else if (serverRevision === held && !savedFormLoad && queue.baseVersion === null && answersKey(serverAnswers) !== answersKey(queue.confirmed.answers)) {
      // The same revision with other answers: a lane whose saves named no
      // revision (a reply without one) still at 0. A sealed lane is never
      // here: it is named by the data version of a write the server made, and
      // a new form's load (revision 0) never replaces that write (#9392 round
      // 1, r1s2 and r2s1).
      queue.confirmed = { ...queue.confirmed, answers: serverAnswers ?? {} };
    }
    // Any other load at or below the lane's revision is an older or the same
    // write and changes nothing.
    return queue.snapshot || queue.confirmed;
  }
  if (serverVersion !== queue.baseVersion && queue.versions.has(serverVersion)) {
    return queue.snapshot || queue.confirmed;
  }
  if (serverVersion !== queue.baseVersion || (!savedFormLoad && answersKey(serverAnswers) !== answersKey(queue.confirmed.answers))) {
    if (!queue.snapshot || answersKey(serverAnswers) !== answersKey(queue.snapshot.answers)) {
      queue.snapshot = null;
      queue.withdrawnThrough = queue.version;
    }
    queue.reconciliation += 1;
    queue.baseVersion = serverVersion;
    queue.confirmed = { answers: serverAnswers ?? {}, baseVersion: serverVersion, revision: queue.confirmed.revision ?? 0 };
    queue.savedSinceLoad = false;
    rememberVersion(queue, serverVersion);
  }
  return queue.snapshot || queue.confirmed;
}
// A confirmed submission ends the in-progress form this lane saved; the next
// form of the template is a new draft with no envelope. The lane keeps only
// its version floor, withdraws anything still queued and starts again from a
// null baseline (#6281).
// The lane's form was found gone by a fresh direct read (#8574): forget the
// form, its answers and its baseline, but keep the draft about to be sent, so
// it starts a new draft instead of naming the deleted one.
function forgetLaneForm(queue) {
  queue.versions.clear();
  queue.reconciliation += 1;
  queue.baseVersion = null;
  queue.formEpoch = (queue.formEpoch ?? 0) + 1;
  queue.confirmed = { answers: {}, baseVersion: null, revision: 0 };
  queue.savedSinceLoad = false;
  queue.formId = null;
  rememberVersion(queue, null);
}
// The form this lane (or the editor, formId) wrote was submitted here or
// closed elsewhere: a replay note naming it is dropped too, so no later editor
// opens on it (#9457 round 1).
function retireDraftLane(memberId, generation, save, templateKey, formId = null) {
  const queue = draftLane(memberId, generation, save, templateKey);
  if (memberId && generation === formDraftSessionGeneration()) {
    for (const id of new Set([formId, queue?.formId])) if (id) forgetReplayedNewForm(memberId, templateKey, id);
  }
  if (queue) resetDraftLane(queue);
}
// Discards in flight and done, per draft owner (#8309 final r6s1). A pending
// discard fences its template's saves even when no save lane exists yet, and
// a discarded form's id never saves again, whichever editor holds it.
// The marks belong to one draft session: a sign-out or account switch starts
// a new one, so no mark outlives the session it was made in (#8966 r2s3).
const draftDiscards = new Map();
function currentDiscardRecord(owner) {
  const record = draftDiscards.get(owner);
  if (record && record.generation !== formDraftSessionGeneration()) {
    draftDiscards.delete(owner);
    return undefined;
  }
  return record;
}
function draftDiscardRecord(owner) {
  let record = currentDiscardRecord(owner);
  if (!record) {
    record = { pending: new Map(), discarded: new Set(), settling: new Map(), generation: formDraftSessionGeneration() };
    draftDiscards.set(owner, record);
  }
  return record;
}
function draftDiscardPending(owner, templateKey) {
  return (currentDiscardRecord(owner)?.pending.get(templateKey) || 0) > 0;
}
function draftDiscarded(owner, formId) {
  return Boolean(formId) && Boolean(currentDiscardRecord(owner)?.discarded.has(formId));
}
// An editor that unmounts while a discard of its form is pending (the rail,
// Back, a layout change) leaves its unsaved edits here: they are sent through
// the save lane if the discard is refused, and dropped if it succeeded or was
// superseded by a session change (#8966 final r3s1/r4s1).
function afterDraftDiscard(owner, formId, settle) {
  const waiting = formId ? currentDiscardRecord(owner)?.settling.get(formId) : null;
  if (!waiting) return false;
  waiting.add(settle);
  return true;
}
// A discarded draft stays unopenable until a list shows it gone. Then its mark
// goes too, so an id that legitimately returns (a reset demo) opens again.
function forgetListedDiscards(owner, listed) {
  const record = currentDiscardRecord(owner);
  if (!record) return;
  for (const formId of record.discarded) if (!listed.has(formId)) record.discarded.delete(formId);
}
// Discarding a draft (list or editor) coordinates with its template's lane
// (#8309 gate round 1). While the delete is pending the lane takes no new
// save, and a save it already dispatched settles first, so nothing recreates
// the draft after the delete. The lane retires (forgetting the form id,
// answers and baseline) only after the delete succeeded; a refused delete
// leaves it exactly as it was. A lane bound to another form is left alone.
async function discardWithLane(memberId, generation, save, templateKey, formId, discard) {
  const lane = draftLane(memberId, generation, save, templateKey);
  const queue = lane && (!lane.formId || lane.formId === formId) ? lane : null;
  const record = draftDiscardRecord(memberId || save);
  record.pending.set(templateKey, (record.pending.get(templateKey) || 0) + 1);
  if (queue) queue.discarding = (queue.discarding || 0) + 1;
  const waiting = formId ? (record.settling.get(formId) || new Set()) : null;
  if (waiting) record.settling.set(formId, waiting);
  let outcome = "refused";
  try {
    if (queue?.tail) await queue.tail.catch(() => {}); // swallow-ok: waits only for the lane's last save to settle; that save reports its own failure
    const result = await discard();
    // Only a delete the server confirmed marks the form and retires the lane;
    // a superseded operation answers nothing and wrote nothing (#8966 r2s3).
    if (result == null) {
      outcome = "superseded";
      return result;
    }
    outcome = "confirmed";
    if (formId) record.discarded.add(formId);
    // A replay note naming the discarded form goes with it (#9457 round 1).
    if (memberId && formId && generation === formDraftSessionGeneration()) forgetReplayedNewForm(memberId, templateKey, formId);
    if (queue) resetDraftLane(queue);
    return result;
  } finally {
    if (queue) queue.discarding -= 1;
    const left = record.pending.get(templateKey) - 1;
    if (left > 0) record.pending.set(templateKey, left);
    else record.pending.delete(templateKey);
    // Edits left by an editor that unmounted meanwhile, once the fence is down.
    if (waiting) {
      if (record.settling.get(formId) === waiting) record.settling.delete(formId);
      for (const settle of waiting) settle(outcome);
    }
  }
}
function saveDraftInOrder(memberId, generation, save, draft) {
  if (memberId && generation !== formDraftSessionGeneration()) return Promise.reject(new Error("form-draft-session-ended"));
  const owners = memberId ? memberDraftSaves : previewDraftSaves;
  const owner = memberId || save;
  if (draftDiscardPending(owner, draft.templateKey)) return Promise.reject(new Error("form-draft-discard-pending"));
  if (draftDiscarded(owner, draft.formId)) return Promise.reject(new Error("form-draft-discarded"));
  let templates = owners.get(owner);
  if (!templates) { templates = new Map(); owners.set(owner, templates); }
  let queue = templates.get(draft.templateKey);
  if (!queue) {
    queue = { version: 0, tail: null, versions: new Set(), withdrawnThrough: 0, baseVersion: draft.baseVersion ?? null,
      confirmed: { answers: draft.base ?? {}, baseVersion: draft.baseVersion ?? null, revision: draft.baseRevision ?? 0 }, reconciliation: 0,
      formEpoch: 0, formId: draft.formId ?? null };
    rememberVersion(queue, queue.baseVersion);
    templates.set(draft.templateKey, queue);
  }
  if (queue.discarding) return Promise.reject(new Error("form-draft-discard-pending"));
  if (draft.version < queue.version) return Promise.reject(new Error("form-draft-save-superseded"));
  if (draft.version === queue.version && queue.tail) return queue.tail;
  // The editor whose save this is made the lane's latest save: a replay of an
  // entry it queued may move the lane, an entry another editor queued may not
  // (formDraftSessions.js, moveTheQueuingEditorsLane).
  queue.editorToken = draft.editorToken ?? null;
  queue.version = draft.version;
  queue.snapshot = draft;
  // An outbox replay of this template takes its turn in the same lane, so this
  // save builds its base only after the replay's confirmation (#8938).
  const request = formDraftLaneTurn(queue, memberId, draft.templateKey).then(async () => {
    if (draft.version <= queue.withdrawnThrough) throw new Error("form-draft-superseded-by-server");
    // REQ-UG-FORMS-RETIRE-RETAINED-LANE-AFTER-REMOTE-DISCARD-20261112
    // (#8574): a fresh editor that inherited the lane's form asks, once and
    // before its first save, whether that form still exists. The read starts
    // here, after the lane's last save settled, and goes to the database
    // directly, so no list kept, cached, truncated or read before the bind can
    // answer it. Only a successful "no such form" forgets the form; a failed
    // read, a found row, or a lane rebound meanwhile changes nothing. No
    // refused save is ever resent: this happens before anything is sent.
    // One check per editor: every draft of that editor shares the token, and
    // the first one dispatched spends it, so a later save (after this editor
    // saved the form itself) never checks and never starts a new draft. The
    // form checked is the one the lane names now, so a lane bound after the
    // editor mounted (an earlier editor's delayed save) is checked too
    // (#8966 r12s1); an unbound lane has nothing to check.
    const verify = draft.verify && !draft.verify.spent ? draft.verify : null;
    if (verify) verify.spent = true;
    if (verify && queue.formId) {
      const checked = queue.formId;
      const reconciled = queue.reconciliation;
      // An unanswered check (a failed read, a changed member) keeps the lane
      // bound, the safe default; a refused save then ends the editor as Main's
      // closed-elsewhere state.
      const exists = await Promise.resolve(verify.check(checked)).then((found) => found, () => null);
      if (memberId && generation !== formDraftSessionGeneration()) throw new Error("form-draft-session-ended");
      // A form found deleted is never opened again from a replay note naming
      // it, so a reopened editor cannot pick it over the replacement this
      // save is about to create (#9457 round 1, r1s1 and r2s1).
      if (exists === false && memberId) forgetReplayedNewForm(memberId, draft.templateKey, checked);
      // The editor that asked stops naming the deleted form too, so its
      // refused save recovers by template (a replacement made elsewhere) and
      // nothing it does later names the deleted id (#9457 final, r3s1).
      if (exists === false) {
        verify.absent = checked;
        verify.onAbsent?.(checked);
      }
      if (draft.version <= queue.withdrawnThrough) throw new Error("form-draft-superseded-by-server");
      if (exists === false && queue.formId === checked && queue.reconciliation === reconciled) forgetLaneForm(queue);
    }
    // The lane's previous save, and the check above, can yield to a sign-in
    // as someone else: no answers leave under a session that ended (#8966
    // final, the await audit).
    if (memberId && generation !== formDraftSessionGeneration()) throw new Error("form-draft-session-ended");
    const reconciliation = queue.reconciliation;
    const epoch = queue.formEpoch ?? 0;
    // A dispatched request names the baseline it was built on; the server
    // refuses it under the form lock if that version moved meanwhile, even
    // after this lane withdrew it (#6233). Sealed saves report the version
    // they stored, which becomes the lane's next baseline.
    // An unbound lane asks the save to prepare the draft and report its id
    // before the answers are sent; a bound lane names its form on every save
    // and retry, so one whose form was submitted elsewhere is refused instead
    // of landing in a new draft (#6395).
    const bound = queue.formId ? { formId: queue.formId } : { onFormId: (formId) => {
      if (formId && queue.reconciliation === reconciliation && !queue.formId) queue.formId = formId;
    } };
    // An ordinary save also names the revision it was based on, the write
    // this lane last knew as stored; the server refuses it, writing nothing,
    // when another session saved since (#8719, #9092). An unbound lane names
    // 0, no open draft: the save may still meet a draft another session
    // created meanwhile, and must not overwrite it.
    // Its reply names the revision it wrote, and the lane moves to it unless
    // it already holds a higher one (advanceFormDraftLane).
    return Promise.resolve(save({ templateKey: draft.templateKey, answers: draft.answers, step: draft.step,
      expectedDataVersion: queue.baseVersion, ...bound, baseRevision: queue.confirmed.revision ?? 0,
      // The editor that typed these answers: an outbox entry this save queues
      // names it (a plain string through the outbox's clone).
      ...(draft.editorToken ? { editorToken: draft.editorToken } : {}) })).then((result) => {
      const formId = result && typeof result === "object" ? result.formId : result;
      // A confirmed save: from now on the lane holds the form of this
      // template, so a replay note for it is no longer what an editor opens
      // (#9457 round 1).
      if (formId && memberId && generation === formDraftSessionGeneration()) forgetReplayedNewForm(memberId, draft.templateKey);
      if (result && typeof result === "object" && Number.isSafeInteger(result.revision)) {
        if (advanceFormDraftLane(queue, { formId, revision: result.revision, answers: draft.answers, epoch })) queue.savedSinceLoad = true;
        return formId;
      }
      // The form this save wrote, unless a newer load reset the lane meanwhile.
      if (formId && queue.reconciliation === reconciliation) queue.formId = formId;
      if (!result || typeof result !== "object") {
        // An ordinary save answers with the form id, and what it stored is
        // this request's answers: they are the next save's base, unless a
        // newer load reconciled the lane meanwhile.
        if (formId && queue.reconciliation === reconciliation) {
          queue.confirmed = { ...queue.confirmed, answers: draft.answers ?? {} };
          queue.savedSinceLoad = true;
        }
        return result;
      }
      if (typeof result.dataVersion === "string" || result.dataVersion === null) {
        rememberVersion(queue, result.dataVersion);
        // A newer load may have reconciled while this response was delayed.
        // Its confirmed pair remains authoritative (#6289 r1s3).
        if (queue.reconciliation === reconciliation) {
          queue.baseVersion = result.dataVersion;
          queue.confirmed = { answers: draft.answers, baseVersion: result.dataVersion, revision: queue.confirmed.revision ?? 0 };
          queue.savedSinceLoad = true;
        }
      }
      return result.formId;
    });
  });
  queue.tail = request;
  const settle = (resolved) => () => {
    if (queue.tail !== request) return;
    queue.tail = null;
    if (resolved && queue.snapshot === draft) queue.snapshot = null;
  };
  request.then(settle(true), settle(false));
  return request;
}

// adoptStoredForm's marker for a refused first save: the stored form is the
// template's open draft, found by template because no id was ever learned.
const OPEN_DRAFT_OF_TEMPLATE = Symbol("open-draft-of-template");

// A stable empty list for fresh drafts. A `[]` literal in the JSX would be a
// new array identity on every FormEditor render, which is what made
// CosignerPanel's mirror effect wipe a just-sent invite (see the panel below).

// The proto's forms page folds the service-request template out of the grid
// into its own footer strip on the same card, so the hub special-cases that
// key. Everything else in the grid is data-driven off the template registry.
const SERVICE_KEY = "service_request";

// Wave 2c (pixel-match, pg.forms): the Wave-2b `.strip-head` placeholder is
// replaced with the prototype page's own in-page header — h1 "Forms" (21px
// Archivo) + the one-line promise sub. The global MobileTopBar still owns all
// top chrome; this header is page content. The Compass/assistant button is not
// in the proto header but its flow must survive, so it keeps its seat at the
// right edge of the row. Profile is the top bar's avatar, so onProfile is not
// read here; the parent still passes it and other views still use it.
export function FormsView({
  data, demo = false, desktop = false, onAssistant, onSaveDraft, onSubmit, onInviteCosigner,
  onRespondCosign, onWithdrawCosign, onSignForm, onAddFormFile,
  onOpenFormFile, onRecheckFormFile, onRemoveFormFile, onDownloadForm, canShareForm, onShareForm,
  focus = null, organizationFormsApi = null, draftSharingApi = null, formAutofillApi = null,
  dues = true, // false only when the organization runs no dues (duesNavigation.js)
  // BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
  // (#9594, D2-4): the same rule as My cases (App passes both
  // Boolean(data.member.chapterId)). With no chapter, no new form is started:
  // a submission goes to the chapter for review, and there is none to see it.
  // The page says why; drafts the member already has stay listed.
  chapterAvailable = true,
  onDiscardDraft = null,
  // The server's filing status for a saved form (get_form_filing_status):
  // the editor drops the signature only when the server says it may.
  onFormFilingStatus = null,
  unitSettingsApi = null,
  onCheckDraft = null,
}) {
  const { t } = useLang();
  const workflow = useUnitWorkflow(unitSettingsApi, `${data.member?.id}:${data.member?.chapterId}:${data.member?.organizationId}`, data.member);
  const unitEnabled = unitSettingsApi && !workflow.context?.legacy;
  const resumeUnitReason = unitEnabled && !workflow.ready
    ? t(workflow.phase === "loading" ? "mforms.resumeUnitsLoading"
      : workflow.phase === "error" ? "unitSettings.loadError"
        : "mforms.resumeChooseUnit")
    : null;
  const [unitNotice, setUnitNotice] = useState(null);
  const filingT = (key, vars) => t(`forms.filing.${key}`, vars);
  const draftSaveOwner = data.member?.id ? `${demo ? "demo" : "member"}:${data.member.id}` : null;
  const pageTitleRef = useRef(null);
  // editor === null → hub; otherwise { templateKey, form } (form is the row
  // being resumed, or null for a fresh start).
  const [editor, setEditor] = useDeviceParityState(unitSettingsApi ? `forms.editor:${data.member?.id}:${data.member?.chapterId}` : "forms.editor", null);
  // Pre-edit warning (co-signer spec D4): resuming an alliance form that
  // already has ACCEPTED co-signers pauses on an alertdialog first — changing
  // any answer resets those co-signatures to "reaffirm_needed" and notifies
  // the co-signers (save_form_draft does the reset server-side, and only when
  // the answers actually differ; this dialog is the member's consent to that).
  // Invited/reaffirm-needed rows are not reset, so they do not trigger it.
  const [confirmEdit, setConfirmEdit] = useDeviceParityState(unitSettingsApi ? `forms.confirmEdit:${data.member?.id}:${data.member?.chapterId}` : "forms.confirmEdit", null);
  const [partialListBlocked, setPartialListBlocked] = useState(false);
  const forms = data.forms || [];
  const inProgress = forms.filter((form) => IN_PROGRESS.has(form.status));
  // Forms this projection shows as no longer in progress; an editor's save
  // lane that still belongs to one of them starts again (#6329).
  const closedForms = forms.filter((form) => !IN_PROGRESS.has(form.status));
  const acceptedCosigners = (form) => (form?.cosigners || []).filter((c) => c.status === "accepted");
  // Discards pending or done, shared with the paired desktop and phone trees
  // (each runs its own save lanes). No entry point opens an editor on a
  // template whose draft is being discarded, or on a discarded draft, and an
  // open editor holding that draft in the other tree stops saving (#8309
  // final r6s1).
  const [discards, setDiscards] = useDeviceParityState("forms.discards", NO_DISCARDS);
  const discardBlocked = (templateKey, formId) => draftDiscardPending(draftSaveOwner || onSaveDraft, templateKey)
    || discards.some((entry) => (entry.state === "pending" && entry.templateKey === templateKey)
      || (Boolean(formId) && entry.formId === formId));
  useEffect(() => {
    const listed = new Set(inProgress.map((form) => form.id));
    forgetListedReplayedForms(draftSaveOwner, new Set(forms.map((form) => form.id)));
    forgetListedDiscards(draftSaveOwner || onSaveDraft, listed);
    if (discards.some((entry) => entry.state === "done" && !listed.has(entry.formId))) {
      setDiscards((current) => current.filter((entry) => entry.state !== "done" || listed.has(entry.formId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a new list arrives
  }, [forms]);
  async function trackDiscard(templateKey, formId, work) {
    setDiscards((current) => [...current.filter((entry) => entry.formId !== formId), { templateKey, formId, state: "pending" }].slice(-DISCARDS_KEPT));
    try {
      const result = await work();
      // A superseded discard deleted nothing: it is dropped, never "done" (r2s3).
      setDiscards((current) => (result == null
        ? current.filter((entry) => entry.formId !== formId)
        : current.map((entry) => (entry.formId === formId ? { ...entry, state: "done" } : entry))));
      return result;
    } catch (error) {
      setDiscards((current) => current.filter((entry) => entry.formId !== formId));
      throw error;
    }
  }
  function openEditor(templateKey, form) {
    if (discardBlocked(templateKey, form?.id)) return;
    if (unitEnabled && !form?.unitPinned && !workflow.ready) return;
    setPartialListBlocked(false);
    const next = { templateKey, form, ...(unitEnabled ? { unitId: form?.unitPinned ? form.unitId : workflow.context.unitId } : {}) };
    if (form && acceptedCosigners(form).length > 0) { setConfirmEdit(next); return; }
    setEditor(next);
  }

  // A list read before an outbox replay wrote a new form
  // of this template has no row for it. The editor opens on the replay's
  // write (its answers and revision), as the list read after the replay will
  // show it, so the next edit saves on top of it instead of being refused
  // from a blank form. Only for the same person and template, a list that
  // names the form in no status, and an editor that saves where the replay
  // saved: the same unit, chapter and organization in the unit workflow, no
  // unit in the chapter workflow. The form is not proven by a list, so the
  // editor asks once whether it still exists before its first save (#8574).
  function replayedNewForm(templateKey) {
    const written = replayedNewFormFor(draftSaveOwner, templateKey);
    if (!written || forms.some((form) => form.id === written.id)) return null;
    const sameTarget = unitEnabled
      ? written.unitId !== undefined && written.unitId === workflow.context?.unitId
        && written.chapterId === data.member?.chapterId && written.organizationId === data.member?.organizationId
      : written.unitId === undefined;
    if (!sameTarget) return null;
    return { id: written.id, templateKey, status: "draft", step: written.step, answers: { ...written.answers }, revision: written.revision,
      cosigners: [], unitId: null, unitName: null, unitPinned: false, replayedNewForm: true };
  }

  function openTemplate(templateKey, preferredForm = null) {
    const existing = preferredForm || inProgress.find((form) => form.templateKey === templateKey) || replayedNewForm(templateKey) || null;
    if (!chapterAvailable && !existing) return;
    if (unitEnabled && !preferredForm && (!workflow.ready || !workflow.context.effective.forms.includes(templateKey))) { setUnitNotice("unitSettings.formUnavailable"); return; }
    if (unitEnabled && !preferredForm && existing?.unitPinned && existing.unitId !== workflow.context.unitId) { setUnitNotice("unitSettings.formConflict"); return; }
    setUnitNotice(null);
    openEditor(templateKey, existing);
  }

  // The alertdialog is a modal layer: Escape cancels the edit (same as the
  // "Keep my answers" button) and — through the shared stack — no longer
  // leaks down to the non-modal Compass panel beneath it.
  // It closes with the prototype modal's 200 ms fade (useModalExit) and keeps
  // the key through it, so a second Escape mid-fade is swallowed, not passed
  // down.
  const editExit = useModalExit(confirmEdit);
  const editClosingRef = useRef(false);
  editClosingRef.current = editExit.closing;
  useEffect(() => {
    if (!editExit.shown) return undefined;
    return registerEscapeLayer(() => {
      if (!editClosingRef.current) setConfirmEdit(null);
      return undefined;
    }, { modal: true });
  }, [editExit.shown, setConfirmEdit]);

  // Search deep-link: open the editor on a template (fresh start) or resume
  // the matched draft/returned row. Submitted rows stay on the hub — the
  // editor is not a reader, and the hub already lists them with status.
  const handledUnitFocus = useRef(null);
  useEffect(() => {
    if (!focus?.templateKey) return;
    if (unitEnabled && (!workflow.ready || handledUnitFocus.current === focus)) return;
    handledUnitFocus.current = focus;
    const focusedRow = focus.formId ? forms.find((form) => form.id === focus.formId) : null;
    if (focus.formId && !focusedRow && data.formsTruncated) {
      setEditor(null);
      setPartialListBlocked(true);
      return;
    }
    if (focusedRow && !IN_PROGRESS.has(focusedRow.status)) { setEditor(null); return; }
    openTemplate(focus.templateKey, focusedRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot deep-link: data.forms is read only to resolve the focused row, and adding it would re-open (or reset) the editor on every refresh that reshapes the list.
  }, [focus, unitEnabled, workflow.ready]);

  // DB registry templates (already resolved to this member's language by
  // loadMemberApp) win; the static array is the demo/offline fallback.
  const allTemplates = Array.isArray(data.formTemplates) ? data.formTemplates : FORM_TEMPLATES;
  const offeredTemplates = formTemplatesForDues(allTemplates, dues);
  const templates = unitEnabled ? (workflow.ready ? unitSettingChoices(offeredTemplates, workflow.context.effective.forms) : []) : offeredTemplates;
  const byKey = (key) => templates.find((template) => template.key === key) || templateByKey(key);
  // Existing form rows render under their PINNED version: submit_form validates
  // the required keys of the version the draft was filed with, so rendering the
  // current version instead could hide a still-required old field and make the
  // form unsubmittable. Fresh starts (form === null) use the active version.
  const pinnedTemplate = (form) =>
    (data.formTemplateVersions || []).find(
      (template) => template.key === form.templateKey && template.version === form.templateVersion,
    ) || allTemplates.find((template) => template.key === form.templateKey) || templateByKey(form.templateKey);

  const reviewed = forms.filter((form) => REVIEWED.includes(form.status));
  const cosignRequests = data.cosignRequests || [];

  const gridTemplates = templates.filter((template) => template.key !== SERVICE_KEY);
  const serviceTemplate = templates.find((template) => template.key === SERVICE_KEY) || null;

  const header = (
    <header className="mforms-ph">
      <div className="mforms-ph__copy">
        <h1 ref={pageTitleRef} className="mforms-title" tabIndex={-1}>{t("nav.forms")}</h1>
        <p className="mforms-sub">{t("mforms.sub")}</p>
      </div>
      {onAssistant && (
        <button type="button" className="icon-button" aria-label={t("header.assistant")} onClick={onAssistant}>
          <Bot size={19} />
        </button>
      )}
    </header>
  );

  // Sealed FMLA answers (#5747) that could not be opened are never edited as
  // empty, so an autosave cannot overwrite the stored draft.
  if (editor?.form?.answersUnavailable) {
    return (
      <div className="screen">
        {header}
        <p className="mforms-row-meta" role="alert">{t("forms.sealedAnswersUnavailable")}</p>
        <button type="button" className="outline-pill" onClick={() => setEditor(null)}>{t("forms.back")}</button>
      </div>
    );
  }

  if (editor && unitEnabled && !workflow.ready && !editor.form?.unitPinned) return <div className="screen">{header}<UnitWorkflowChoice workflow={workflow} /></div>;
  if (editor) {
    return (
      <div className="screen">
        {header}
        {unitEnabled && <p>{editor.form?.unitName || workflow.context?.units.find((unit) => unit.id === editor.unitId)?.name || t("unitSettings.chapter")}</p>}
        {/* UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111:
            the editor and the sharing panel are siblings, so their keys must
            differ. Both used the form id, and React then kept the old editor on
            screen after Close, beside the next one, until a reload. */}
        <FormEditor
          key={editor.form ? editor.form.id : `new-${editor.templateKey}`}
          templateKey={editor.templateKey}
          template={editor.form ? pinnedTemplate(editor.form) : byKey(editor.templateKey)}
          form={editor.form}
          saveOwner={draftSaveOwner}
          t={t}
          onSaveDraft={unitEnabled ? (fields) => onSaveDraft({ ...fields, unitId: editor.form?.unitPinned ? editor.form.unitId : (editor.unitId ?? workflow.context.unitId), actorId: data.member.id, chapterId: data.member.chapterId, organizationId: data.member.organizationId }) : onSaveDraft}
          onSubmit={onSubmit}
          onInviteCosigner={onInviteCosigner}
          demo={demo}
          desktop={desktop}
          filingT={filingT}
          onSignForm={onSignForm}
          onAddFormFile={onAddFormFile}
          onOpenFormFile={onOpenFormFile}
          onRecheckFormFile={onRecheckFormFile}
          onRemoveFormFile={onRemoveFormFile}
          onClose={() => setEditor(null)}
          onDiscard={onDiscardDraft}
          trackDiscard={trackDiscard}
          discards={discards}
          closedForms={closedForms}
          autofillApi={demo ? null : formAutofillApi}
          storedForms={forms}
          checkDraft={!demo && onCheckDraft && data.member?.id ? (formId) => onCheckDraft(formId, data.member.id) : null}
          filingStatusApi={demo ? null : onFormFilingStatus}
        />
        {/* An editor opened on a remembered form no list has shown yet offers no sharing; opened from a list that
            shows the form, it does. The remembered form may be one the
            editor finds deleted and stops naming (#9457 final, r3s1). */}
        {draftSharingApi && editor.form?.id && !editor.form.replayedNewForm && (HEALTH_NOTICE_TEMPLATE_KEYS.includes(editor.templateKey) ? <DraftSharingUnavailable /> : <DraftSharingPanel key={`share-${editor.form.id}`} api={draftSharingApi} formId={editor.form.id} />)}
      </div>
    );
  }

  return (
    <div className="screen">
      {header}
      {unitEnabled && <UnitWorkflowChoice workflow={workflow} />}
      {unitNotice && <p role="alert">{t(unitNotice)}</p>}
      <div className="mforms-body">
        {data.formsTruncated && (
          <p className="mforms-row-meta" role="note">{t("forms.formsTruncated", { count: forms.length })}</p>
        )}
        {partialListBlocked && (
          <p className="mforms-row-meta" role="alert">{t("forms.partialListStartBlocked")}</p>
        )}
        <section className={`${CARD_CLASS} mforms-shell`}>
          {inProgress.map((form) => (
            <div key={form.id}>{form.unitName && <p>{form.unitName}</p>}<DraftStrip
              key={form.id}
              form={form}
              template={pinnedTemplate(form)}
              t={t}
              onResume={() => openEditor(form.templateKey, form)}
              resumeReason={form.unitPinned ? null : resumeUnitReason}
              onDiscard={onDiscardDraft ? () => trackDiscard(form.templateKey, form.id, () => discardWithLane(draftSaveOwner,
                formDraftSessionGeneration(), onSaveDraft, form.templateKey, form.id, () => onDiscardDraft(form.id, form.templateKey))) : null}
            />{draftSharingApi && (HEALTH_NOTICE_TEMPLATE_KEYS.includes(form.templateKey) ? <DraftSharingUnavailable /> : <DraftSharingPanel api={draftSharingApi} formId={form.id} />)}</div>
          ))}
          {!chapterAvailable && (
            <div className="mforms-svc" role="note" data-forms-no-chapter="">
              <span className="mforms-svc__icon" aria-hidden="true"><FileText size={20} /></span>
              <span className="mforms-svc__copy"><b>{t("mforms.noChapterTitle")}</b> — {t("mforms.noChapterBody")}</span>
            </div>
          )}
          {chapterAvailable && <div className="mforms-grid">
            {gridTemplates.map((template) => (
              <button
                key={template.key}
                type="button"
                className="mforms-tile"
                onClick={() => openTemplate(template.key)}
              >
                <span className="mforms-tile__icon" aria-hidden="true"><FileText size={20} /></span>
                <span className="mforms-tile__title">{t(template.titleKey)}</span>
                <span className="mforms-tile__blurb">{t(template.blurbKey)}</span>
              </button>
            ))}
          </div>}
          {chapterAvailable && serviceTemplate && (
            <div className="mforms-svc">
              <span className="mforms-svc__icon" aria-hidden="true"><FileText size={20} /></span>
              <span className="mforms-svc__copy">
                <b>{t(serviceTemplate.titleKey)}</b> — {t(serviceTemplate.blurbKey)}
              </span>
              <button
                type="button"
                className="mforms-btn mforms-btn--ghost"
                onClick={() => openTemplate(serviceTemplate.key)}
              >
                {t("mforms.start")}
              </button>
            </div>
          )}
        </section>

        {cosignRequests.length > 0 && (
          <CosignRequestsSection
            requests={cosignRequests}
            t={t}
            templateFor={pinnedTemplate}
            onRespond={onRespondCosign}
            onWithdraw={onWithdrawCosign}
            emptyFocusRef={pageTitleRef}
          />
        )}

        {reviewed.length > 0 && (
          <section className={`${CARD_CLASS} mforms-shell`}>
            <div className="mforms-cardhead">
              <span className="mforms-cardhead__title">{t("forms.submittedTitle")}</span>
            </div>
            {reviewed.map((form) => {
              const template = pinnedTemplate(form);
              return (
                <article key={form.id} className="mforms-row mforms-row--stack">
                  <div className="mforms-filing-row">
                    <span className="mforms-row__icon" aria-hidden="true"><FileText size={18} /></span>
                    <div className="mforms-row__copy">
                      <div className="mforms-row-title">{template ? t(template.titleKey) : form.templateKey}</div>
                      {form.unitName && <div className="mforms-row-meta">{form.unitName}</div>}
                      {form.filerSignedAt && <div className="mforms-row-meta">{t("forms.filing.signedReady")}</div>}
                      {form.status === "approved" && form.reviewNote && (
                        <div className="mforms-row-meta" role="note">{t("forms.approvedNote", { note: form.reviewNote })}</div>
                      )}
                      {form.answersUnavailable ? (
                        <div className="mforms-row-meta" role="status">{t("forms.sealedAnswersUnavailable")}</div>
                      ) : template ? (
                        <details className="mforms-submission-review">
                          <summary className="outline-pill">{t("forms.readSubmission")}</summary>
                          <div role="region" aria-label={t("forms.submissionDetails")}>
                            <ReviewStep template={template} answers={form.answers || {}} t={t} />
                          </div>
                        </details>
                      ) : (
                        <div className="mforms-row-meta" role="status">{t("forms.submissionUnavailable")}</div>
                      )}
                    </div>
                    <StatusChip status={form.status} t={t} />
                  </div>
                  {form.status === "approved" && (
                    <FormFilingControls
                      t={filingT}
                      headingLevel={desktop ? 2 : 3}
                      approved
                      demo={demo}
                      files={form.files || []}
                      filesUnavailable={form.filesUnavailable === true}
                      onOpenFile={onOpenFormFile}
                      onRecheckFile={onRecheckFormFile}
                      onDownload={onDownloadForm ? () => onDownloadForm(form.id) : null}
                      canShare={canShareForm}
                      onShare={onShareForm}
                    />
                  )}
                </article>
              );
            })}
          </section>
        )}

        {organizationFormsApi && <OrganizationHtmlForms api={organizationFormsApi} autofillApi={demo ? null : formAutofillApi} />}

        {editExit.shown && (
          <CosignEditConfirm
            count={acceptedCosigners(editExit.value.form).length}
            closing={editExit.closing}
            onTransitionEnd={editExit.onTransitionEnd}
            onKeep={() => setConfirmEdit(null)}
            onEdit={() => { if (!discardBlocked(confirmEdit.templateKey, confirmEdit.form?.id)) setEditor(confirmEdit); setConfirmEdit(null); }}
          />
        )}
      </div>
    </div>
  );
}

// The co-signed edit warning is a modal alertdialog in the prototype modal's
// manner: the page behind it
// is isolated and its scroll locked, Tab stays inside, a press on the scrim
// keeps the answers as signed, and focus goes back to the control that
// opened it. Escape is answered through the shared stack (FormsView). It
// closes over the 200 ms scrim fade (`closing`), holding focus and ignoring
// every further answer until it has gone.
function CosignEditConfirm({ count, closing = false, onTransitionEnd, onKeep, onEdit }) {
  const { t } = useLang();
  const layerRef = useRef(null);
  const surfaceRef = useRef(null);
  const returnFocusRef = useRef(typeof document === "undefined" ? null : document.activeElement);
  useModalIsolation(layerRef);
  // Also a microtask after the commit that removes the warning, before any
  // later task, so focus is back on the opener before the page (or a test
  // resuming from a DOM observer) acts again; the passive cleanup alone ran a
  // task after the backdrop had gone (OPS-UG-ROOT-SHARD-FLAKES-ON-DEPOT-20261031).
  useLayoutEffect(() => () => { queueMicrotask(() => returnFocusAfterModal(returnFocusRef.current)); }, []);
  useEffect(() => () => { returnFocusAfterModal(returnFocusRef.current); }, []);
  const keep = () => { if (!closing) onKeep(); };
  const edit = () => { if (!closing) onEdit(); };
  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...surfaceRef.current.querySelectorAll("button:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={layerRef}
      className="dialog-backdrop"
      role="presentation"
      data-state={closing ? "closing" : undefined}
      onTransitionEnd={onTransitionEnd}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        keep();
      }}
    >
      <section ref={surfaceRef} className="task-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cosign-edit-title" aria-describedby="cosign-edit-body" onKeyDown={trapFocus}>
        <h2 id="cosign-edit-title">{t("forms.cosign.editWarnTitle")}</h2>
        <div id="cosign-edit-body">
          <p>{t("forms.cosign.editWarnBody", { n: count })}</p>
          <p>{t("forms.cosign.editWarnNoChange")}</p>
        </div>
        <footer>
          {/* Safe action first and focused, like the task-delete confirm. */}
          <button type="button" className="task-confirm__keep" autoFocus onClick={keep}>{t("forms.cosign.editWarnCancel")}</button>
          <button type="button" className="dialog-primary" onClick={edit}>{t("forms.cosign.editWarnConfirm")}</button>
        </footer>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- hub pieces */

// The proto's amber draft strip at the top of the forms card: 📝, "Draft —
// {template}", "{pct}% complete · next field" meta, and a green Resume button.
// One strip per in-progress row (the proto seeds exactly one); returned rows
// reuse the strip with the steward's note as the bold amber line.
// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111: an
// unsubmitted draft can be discarded after one confirmation. A returned form
// was submitted before, so it keeps only Resume.
function DiscardDraftControl({ t, onDiscard }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A second press in the same tick, before busy commits, is
  // refused by this lock; Discard stays focusable while it runs.
  const discardLockRef = useRef(new Set());
  function discard(event) {
    return runBusyWrite(discardLockRef, "discard", async () => {
      setBusy(true); setFailed(false);
      let result;
      try { result = await onDiscard(); }
      catch { setFailed(true); setBusy(false); return; }
      // A superseded discard deleted nothing: the draft stays, so the control
      // goes back to its plain button instead of staying busy.
      if (result == null) { setBusy(false); setConfirming(false); }
    }, event);
  }
  if (!confirming) {
    return (
      <button type="button" className="mforms-btn mforms-btn--ghost" onClick={() => setConfirming(true)}>
        {t("mforms.discardDraft")}
      </button>
    );
  }
  return (
    <div role="group" aria-label={t("mforms.discardDraft")} style={{ display: "grid", gap: 6 }}>
      <p className="mforms-row-meta" role="alert" style={{ margin: 0 }}>{t("mforms.discardConfirm")}</p>
      {failed && <p className="mforms-row-meta" role="alert" style={{ margin: 0 }}><b className="mforms-warn">{t("mforms.discardFailed")}</b></p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <BusyButton type="button" className="mforms-btn mforms-btn--primary" pending={busy} onClick={(event) => { void discard(event); }}>{t("mforms.discardYes")}</BusyButton>
        <button type="button" className="mforms-btn mforms-btn--ghost" disabled={busy} onClick={() => { setConfirming(false); setFailed(false); }}>{t("mforms.discardKeep")}</button>
      </div>
    </div>
  );
}

function DraftStrip({ form, template: templateProp, t, onResume, resumeReason, onDiscard = null }) {
  const template = templateProp || templateByKey(form.templateKey);
  const { pct, nextFieldKey } = formProgress(template || { steps: [] }, form.answers);
  const nextLabelKey = nextFieldKey ? fieldLabelKey(template, nextFieldKey) : null;
  const returned = form.status === "returned";
  const completion = returned ? null : t("forms.pctComplete", { pct });
  const title = template ? t(template.titleKey) : form.templateKey;

  return (
    <div className="mforms-draft">
      <span className="mforms-draft__icon" aria-hidden="true"><FilePenLine size={18} /></span>
      <div className="mforms-row__copy">
        <div className="mforms-row-title">
          {t(returned ? "mforms.returnedTitle" : "mforms.draftTitle", { title })}
        </div>
        {(completion || nextLabelKey) && (
          <div className="mforms-row-meta">
            {completion}
            {nextLabelKey && (
              <>
                {completion && " · "}
                <b className="mforms-warn">{t("forms.nextField", { label: t(nextLabelKey) })}</b>
              </>
            )}
          </div>
        )}
        {returned && form.reviewNote && (
          <div className="mforms-row-meta" role="note">
            <b className="mforms-warn">{t("forms.returnedNote", { note: form.reviewNote })}</b>
          </div>
        )}
      </div>
      <div>
        <BusyButton type="button" className="mforms-btn mforms-btn--primary" onClick={onResume}
          disabled={Boolean(resumeReason)} disabledReason={resumeReason}>
          {t("mforms.resumeDraft")}
        </BusyButton>
      </div>
      {onDiscard && form.status === "draft" && <DiscardDraftControl t={t} onDiscard={onDiscard} />}
    </div>
  );
}

function StatusChip({ status, t }) {
  const approved = status === "approved";
  return (
    <span
      className="reward-chip"
      style={{
        flexShrink: 0,
        padding: "5px 10px",
        fontSize: 11,
        fontWeight: 800,
        background: approved ? "var(--green-soft)" : "var(--card)",
        borderColor: approved ? "var(--green)" : "var(--border)",
        color: approved ? "var(--green)" : "var(--muted-foreground)",
      }}
    >
      {t(STATUS_KEY[status] || "forms.statusSubmitted")}
    </span>
  );
}

/* ----------------------------------------------------- co-sign requests */

// The invitee's inbox: alliance grievances another member has asked them to
// co-sign. Pre-accept the invitee never reads the grievance — only the
// definer-supplied one-line summary + filer name — so accepting is a
// deliberate, informed act. Accepting unlocks the full read; declining and
// withdrawing revoke it. Local state mirrors the loaded requests so an action
// updates instantly (and persists in demo, where there is no server refresh).
// Wave 2c: styled as a proto review-inbox card (header row + waiting chip,
// divider rows) — logic untouched.
// An accept sends the reviewDigest of the preview on screen (#8703). The
// signing dialog reads the latest loaded request, so what it shows is what it
// sends; when the filer changed the grievance after that preview, nothing is
// co-signed, the dialog closes and the row says so over the re-read preview.
function CosignRequestsSection({ requests, t, templateFor, onRespond, onWithdraw, emptyFocusRef }) {
  const [items, setItems] = useState(requests);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [signing, setSigning] = useState(null);
  const [signature, setSignature] = useState(EMPTY_SIGNATURE);
  const [consent, setConsent] = useState(false);
  const [changedIds, setChangedIds] = useState(() => new Set());
  const signingOpenerRef = useRef(null);
  // A row's controls stay focusable while its write runs, so the
  // write takes a synchronous per-row lock before React commits busyIds.
  const writeRef = useRef(new Set());
  const signingReq = signing ? (items.find((r) => r.formId === signing.formId) || signing) : null;

  useEffect(() => setItems(requests), [requests]);

  const markChanged = (formId, changed) => setChangedIds((previous) => {
    if (previous.has(formId) === changed) return previous;
    const next = new Set(previous);
    if (changed) next.add(formId);
    else next.delete(formId);
    return next;
  });

  function act(req, kind, signatureStrokes = null, signatureConsent = false) {
    return runBusyWrite(writeRef, `cosign:${req.formId}`, () => actNow(req, kind, signatureStrokes, signatureConsent));
  }

  async function actNow(req, kind, signatureStrokes, signatureConsent) {
    setBusyIds((previous) => new Set(previous).add(req.formId));
    try {
      if (kind === "withdraw") await onWithdraw(req.formId);
      else await onRespond(req.formId, kind === "accept", signatureStrokes, signatureConsent, kind === "accept" ? req.reviewDigest ?? null : null);
      markChanged(req.formId, false);
      setItems((previous) => kind === "accept"
        ? previous.map((r) => (r.formId === req.formId ? { ...r, status: "accepted" } : r))
        : previous.filter((r) => r.formId !== req.formId));
      if (kind !== "accept") {
        window.setTimeout(() => {
          const nextAction = document.querySelector(".mforms-cosign-action:not([disabled])");
          (nextAction || emptyFocusRef?.current)?.focus?.();
        }, 0);
      }
      if (kind === "accept") {
        setSigning(null);
        setSignature(EMPTY_SIGNATURE);
        setConsent(false);
      }
    } catch (error) {
      // The app surfaces the error toast; keep the row so the member can retry.
      // A grievance changed after its preview is never retried with the old
      // preview: the dialog closes, and the next accept starts from the
      // re-read request.
      if (kind === "accept" && error?.details === "cosign_changed_since_preview") {
        markChanged(req.formId, true);
        setSigning(null);
        setSignature(EMPTY_SIGNATURE);
        setConsent(false);
      }
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous);
        next.delete(req.formId);
        return next;
      });
    }
  }

  if (items.length === 0) return null;

  const pending = items.filter((req) => req.status !== "accepted").length;

  return (
    <section className={`${CARD_CLASS} mforms-shell`}>
      <div className="mforms-cardhead">
        <span className="mforms-cardhead__title">{t("forms.cosign.title")}</span>
        {pending > 0 && <span className="mforms-chip">{t("mforms.waitingCount", { n: pending })}</span>}
      </div>
      {items.map((req) => {
        // The preview RPC coalesces filerName to a non-empty value, so this
        // is effectively always set; "" only if that read errored.
        const name = req.filerName || "";
        const leadKey = req.status === "accepted"
          ? "forms.cosign.youCosigned"
          : req.status === "reaffirm_needed"
            ? "forms.cosign.reaffirmYou"
            : "forms.cosign.invitedYou";
        const busy = busyIds.has(req.formId);
        return (
          <article key={req.formId} className="mforms-row mforms-row--stack">
            <div className="mforms-row-title">{t(leadKey, { name })}</div>
            {req.summary && (
              <div className="mforms-row-meta" style={{ overflowWrap: "anywhere" }}>
                {t("forms.cosign.issueLabel")}: {req.summary}
              </div>
            )}
            {req.status !== "accepted" && changedIds.has(req.formId) && (
              <div className="mforms-row-meta" role="alert">{t("forms.cosign.changedSincePreview", { name })}</div>
            )}
            {req.status !== "accepted" && (
              <div className="mforms-row-meta">{t("forms.cosign.afterAcceptNote")}</div>
            )}
            {req.status === "accepted" && req.grievance && (
              <details className="mforms-cosign-review">
                <summary className="outline-pill">{t("forms.cosign.reviewGrievance")}</summary>
                <div role="region" aria-label={t("forms.cosign.grievanceDetails")}>
                  <ReviewStep template={templateFor(req.grievance)} answers={req.grievance.answers || {}} t={t} />
                </div>
              </details>
            )}
            {req.status === "accepted" && !req.grievance && (
              <div className="mforms-row-meta" role="status">{t("forms.cosign.grievanceUnavailable")}</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {req.status === "accepted" ? (
                <BusyButton type="button" className="outline-pill mforms-cosign-action" pending={busy} onClick={() => act(req, "withdraw")}>
                  {t("forms.cosign.withdraw")}
                </BusyButton>
              ) : (
                <>
                  <BusyButton type="button" className="dialog-primary mforms-cosign-action" pending={busy} onClick={(event) => { signingOpenerRef.current = event.currentTarget; setSigning(req); setSignature(EMPTY_SIGNATURE); setConsent(false); }} style={{ minWidth: 120 }}>
                    {req.status === "reaffirm_needed" ? t("forms.cosign.reaffirmCta") : t("forms.cosign.accept")}
                  </BusyButton>
                  <BusyButton type="button" className="outline-pill" pending={busy} onClick={() => act(req, "decline")}>
                    {t("forms.cosign.decline")}
                  </BusyButton>
                </>
              )}
            </div>
          </article>
        );
      })}
      {signingReq && (
        <Dialog title={t("forms.cosign.signTitle")} returnFocusRef={signingOpenerRef} onClose={() => { if (!busyIds.has(signingReq.formId)) setSigning(null); }}>
          <div className="form-cosign-sign">
            {signingReq.summary && <p className="form-filing__review-summary"><strong>{t("forms.cosign.issueLabel")}:</strong> {signingReq.summary}</p>}
            <p className="form-filing__hint">{t("forms.cosign.signLead")}</p>
            <SignatureChoice
              value={signature}
              onChange={setSignature}
              pending={busyIds.has(signingReq.formId)}
              labels={{
                legend: t("forms.filing.signatureWay"), draw: t("forms.filing.signatureWayDraw"), type: t("forms.filing.signatureWayType"),
                nameLabel: t("forms.filing.typedName"), nameHint: t("forms.cosign.typedNameHint"),
                problems: { hidden: t("forms.filing.typedNameHidden"), length: t("forms.filing.typedNameLength"), letter: t("forms.filing.typedNameLetter") },
              }}
              padProps={{
                label: t("forms.cosign.signature"),
                instructions: t("forms.cosign.signatureInstructions"),
                clearLabel: t("forms.filing.clearSignature"),
                emptyStatus: t("forms.filing.emptySignature"),
                strokeStatus: (count) => t("forms.filing.strokeCount", { n: count }),
                capStatus: t("forms.cosign.signatureCapReached"),
                statusRole: "note",
              }}
            />
            <label className="form-filing__consent">
              <BusyInput type="checkbox" checked={consent} pending={busyIds.has(signingReq.formId)} onChange={(event) => setConsent(event.target.checked)} />
              <span>{t(signature.kind === "typed" ? "forms.cosign.typedConsent" : "forms.cosign.signatureConsent")}</span>
            </label>
            <div className="form-filing__delivery">
              <BusyButton type="button" className="outline-pill form-filing__action" pending={busyIds.has(signingReq.formId)} onClick={() => setSigning(null)}>
                {t("forms.cosign.signCancel")}
              </BusyButton>
              <BusyButton
                type="button"
                className="dialog-primary form-filing__action"
                pending={busyIds.has(signingReq.formId)}
                disabled={!signatureIsReady(signature) || !consent}
                // #9460 W4-17: names only what is missing.
                disabledReason={signatureIsReady(signature) ? t("forms.filing.signatureTickBox") : t(consent ? "forms.filing.signatureSignFirst" : "forms.cosign.signAndTick")}
                onClick={() => act(signingReq, "accept", signature.kind === "typed" ? signature : signature.strokes, true)}
              >
                {busyIds.has(signingReq.formId) ? t("forms.cosign.signing") : t("forms.cosign.signAccept")}
              </BusyButton>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- editor */

function FormEditor({
  templateKey, template: templateProp, form, saveOwner, t, onSaveDraft, onSubmit,
  onInviteCosigner, demo, desktop, filingT, onSignForm, onAddFormFile,
  onOpenFormFile, onRecheckFormFile = null, onRemoveFormFile, onClose, closedForms = NO_CLOSED_FORMS,
  onDiscard = null,
  trackDiscard = untrackedDiscard,
  discards = NO_DISCARDS,
  autofillApi = null, storedForms = NO_CLOSED_FORMS,
  checkDraft = null,
  filingStatusApi = null,
}) {
  const template = useMemo(() => templateProp || templateByKey(templateKey), [templateProp, templateKey]);
  const steps = template ? template.steps : [];
  const reviewIndex = steps.length; // last virtual step is Review & submit
  const totalSteps = steps.length + 1;

  const parityKey = form?.id || templateKey;
  // Resume from our pending write, not an earlier server projection captured
  // before its delayed response. Editing C must retain B's other fields too.
  // The session this editor's saves belong to, and the server answers it
  // started from. A rejected snapshot resumes only within the same session and
  // only while the server still holds answers this session saw (#6205).
  const [draftGeneration] = useState(formDraftSessionGeneration);
  const [serverBase] = useState(() => form?.answers ?? null);
  const [serverBaseVersion] = useState(() => form?.dataVersion ?? null);
  // The write an ordinary form was loaded at (#9092); 0 for a new form.
  const [serverBaseRevision] = useState(() => (form ? form.revision : 0));
  // This editor's own token, taken once at mount, and its registration as a
  // mounted editor of the template while it stays mounted (StrictMode's
  // second effect run registers the same token again). An outbox replay moves
  // this editor's lane only for an entry its own save queued
  // (formDraftSessions.js, moveTheQueuingEditorsLane).
  const [editorToken] = useState(newFormEditorToken);
  useEffect(() => mountFormEditor(saveOwner, templateKey, editorToken), [saveOwner, templateKey, editorToken]);
  const [pendingDraft] = useState(() => pendingDraftFor(saveOwner, draftGeneration, onSaveDraft, templateKey,
    { serverAnswers: serverBase, serverVersion: serverBaseVersion, serverRevision: serverBaseRevision, serverFormId: form?.id ?? null, closedForms }));
  // A fresh form whose template's lane names an earlier draft (#8574): that
  // form is checked once, before this editor's first save. Every fresh editor
  // carries the token, because the lane may be bound only after this editor
  // mounted, by an earlier editor's delayed save (#8966 r12s1); the lane reads
  // the form to check when the first save is dispatched, after its previous
  // save settled. An editor opened on a listed form never checks; one opened
  // on a new form a replay wrote, which no list has shown, checks it the same
  // way: deleted on another device meanwhile, the save
  // starts a new draft instead of naming the deleted one.
  // When that check finds the editor's own form deleted (absent), the editor
  // forgets the form as its identity: formIdRef and savedId through onAbsent,
  // and the opening form's id through shownFormId (#9457 final, r3s1).
  const absentRef = useRef(null);
  const [inheritedCheck] = useState(() => ((!form || form.replayedNewForm) && checkDraft
    ? { check: checkDraft, spent: false, absent: null, onAbsent: (id) => absentRef.current?.(id) } : null));
  const shownFormId = (id) => (id && id === inheritedCheck?.absent ? null : id ?? null);
  const [answers, setAnswers] = useDeviceParityState(`forms.${parityKey}.answers`, () => ({ ...(pendingDraft?.answers || form?.answers || {}) }));
  const [stepIndex, setStepIndex] = useDeviceParityState(`forms.${parityKey}.stepIndex`, () =>
    clamp(pendingDraft?.step ?? (form && Number.isInteger(form.step) ? form.step : 0), 0, reviewIndex),
  );
  const stepHeadingRef = useRef(null);
  const focusStepRef = useRef(false);
  // "Go to <label>" on Review names a field; focus lands on it.
  const focusFieldRef = useRef(null);
  // The heading says the step; a Go to move skips it, so a polite region says it once.
  const [stepAnnouncement, setStepAnnouncement] = useState("");
  const stepPositionId = useId();
  useLayoutEffect(() => {
    // Move only after an explicit Next/Back transition commits, never on an
    // answer edit, autosave response or background device-parity update.
    if (!focusStepRef.current) return;
    focusStepRef.current = false;
    const fieldKey = focusFieldRef.current;
    focusFieldRef.current = null;
    const editor = stepHeadingRef.current?.closest("section");
    const shell = fieldKey && editor && [...editor.querySelectorAll("[data-field-key]")].find((node) => node.dataset.fieldKey === fieldKey);
    const control = shell?.querySelector("input, textarea, select, button");
    const heading = stepHeadingRef.current;
    if (control) control.focus();
    else heading?.focus();
    setStepAnnouncement(control && heading ? `${heading.textContent}. ${document.getElementById(stepPositionId)?.textContent ?? ""}` : "");
  }, [stepIndex, stepPositionId]);
  const [busy, setBusy] = useState(false);
  // Submit and Close share `busy`, and their controls stay
  // focusable while it is set, so both take this synchronous lock first.
  const editorWriteRef = useRef(new Set());
  // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the fields this
  // editor filled from the member's profile ({ fieldKey: kind }), kept with the
  // form's other editor state. A field the member edits is theirs again.
  const [profileFilled, setProfileFilled] = useDeviceParityState(`forms.${parityKey}.profileFilled`, null);
  const autofillFields = useMemo(() => templateAutofillFields(template, t), [template, t]);
  // The accepted kinds travel with the draft's saves: every change (a yes, an
  // edit that makes a field the member's own) is dirty until a save of the
  // draft has recorded it, and a record that failed stays pending on this
  // device under the draft's id. A strict save (submit, close) refuses to
  // finish while it is still dirty.
  const provenanceRef = useRef(null);
  const recordChainRef = useRef(Promise.resolve());
  // Before the draft has an id (its first save failed or went to the offline
  // outbox) a pending record is kept under the member and template instead,
  // and moves to the draft once a save names it.
  const laneProvenanceKey = saveOwner ? `${saveOwner}:${templateKey}` : null;
  if (provenanceRef.current === null && profileFilled) {
    provenanceRef.current = { filled: profileFilled, dirty: Boolean(form?.id && pendingAutofillRecord(form.id)) };
  }
  // A reopened draft gets back what was accepted on it: the kinds a record
  // that failed left on this device first, else the kinds the draft carries.
  // The offer waits for that check, so a draft never asks twice.
  // A save the shared draft lane still holds carries its own unrecorded fields.
  const lanePending = pendingDraft?.provenance ?? null;
  const [provenanceChecked, setProvenanceChecked] = useState(() => !((form?.id || lanePending || (laneProvenanceKey && pendingAutofillRecord(laneProvenanceKey))) && autofillApi?.load && profileFilled === null));
  useEffect(() => {
    if (provenanceChecked) return undefined;
    let live = true;
    // A pending record (even an empty one, which clears the draft's record)
    // must still be written; a recorded one is rewritten only when a field it
    // names has since been emptied or left the form.
    // A pending map is kept whole (its answers may still be on their way from
    // the outbox) and left where it is stored; only a recorded one is pruned
    // to the fields that still hold a value.
    const restore = (recorded, pending = false) => {
      if (!live) return;
      if (recorded && pending) setProvenance(recorded, { store: false });
      else if (recorded && Object.keys(recorded).length) {
        const restored = restoredProfileFilled(autofillFields, recorded, answersRef.current);
        setProvenance(restored, { dirty: Object.keys(restored).length !== Object.keys(recorded).length });
      }
      setProvenanceChecked(true);
    };
    const pending = lanePending ?? (form?.id ? pendingAutofillRecord(form.id) : null) ?? (laneProvenanceKey ? pendingAutofillRecord(laneProvenanceKey) : null);
    if (pending) restore(pending, true);
    else if (form?.id && autofillApi.loadRecorded) Promise.resolve().then(() => autofillApi.loadRecorded(form.id)).then((recorded) => restore(recorded), () => restore(null));
    else restore(null);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const autofill = useFormAutofill(autofillApi, autofillFields, answers, { enabled: provenanceChecked && profileFilled === null });
  const [autofillRecordFailed, setAutofillRecordFailed] = useState(false);
  const [signatureReady, setSignatureReady] = useState(Boolean(form?.filerSignatureDigest));
  const [signatureStale, setSignatureStale] = useState(Boolean(form?.filerSignedAt && !form?.filerSignatureDigest));
  // The form id whose signature was refused as changed since review; its
  // stored answers replace the ones on screen (saveSignature below).
  const [reviewReload, setReviewReload] = useState(null);
  // Set when Submit was refused because the form changed elsewhere after
  // review (#8705); cleared by the next edit or signature.
  const [submitChanged, setSubmitChanged] = useState(false);
  // Set when a save naming this form was refused because the form was
  // submitted or closed elsewhere (PT409 form_not_editable, #8702). Terminal:
  // nothing typed here afterwards is saved, and Close leaves without a save.
  const closedElsewhereRef = useRef(false);
  const [closedElsewhere, setClosedElsewhere] = useState(false);
  // Set when a save was refused because another session saved this draft
  // after the answers it was based on (PT409 form_saved_elsewhere, #8719):
  // the stored answers replace the ones here and the edit is not resent.
  const [savedElsewhere, setSavedElsewhere] = useState(false);
  // Mirror of the persisted form id in state (formIdRef alone would not
  // re-render), so the co-signers panel appears the moment a fresh alliance
  // draft first saves and gains an id.
  const [savedId, setSavedId] = useDeviceParityState(`forms.${parityKey}.savedId`, form ? form.id : null);

  // Refs so the debounced / async saves always read the latest values and never
  // fire a stale closure. formIdRef upgrades a fresh form to its persisted id
  // once the first real save returns one (null in demo — stays fresh).
  const answersRef = useRef(answers);
  const stepRef = useRef(stepIndex);
  const formIdRef = useRef(form ? form.id : null);
  // The form this editor writes: the id a save confirmed, else the one it
  // opened on, never one its existence check found deleted (r3s1).
  const editorFormId = () => shownFormId(formIdRef.current) || shownFormId(form?.id);
  absentRef.current = (id) => {
    if (formIdRef.current === id) formIdRef.current = null;
    if (!unmountedRef.current && savedId === id) setSavedId(null);
  };
  const timerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const closingRef = useRef(false);
  const unmountedRef = useRef(false);
  // "pending" while a discard is in flight, "done" once it succeeded: no save
  // is prepared or sent in either state, so none recreates the draft.
  const discardRef = useRef(null);
  // The same draft discarded from the paired tree: "pending" or "done".
  const sharedDiscardRef = useRef(null);
  const heldDuringSharedRef = useRef(false);
  // While this editor's own discard is pending: the save it held back and the
  // answers it started from, so an unmount meanwhile can hand them on.
  const discardHeldRef = useRef(null);
  const discardStartRef = useRef(null);
  const latestUnsavedRef = useRef(() => null);
  const [saveFailed, setSaveFailed] = useState(false);
  // The unmount flush below runs from the first render's closure; read the
  // live handler through a ref so it never sends with a stale one.
  const saveDraftRef = useRef(onSaveDraft);
  saveDraftRef.current = onSaveDraft;
  // Set when the pre-submit flush fails, so the refusal is on the page and not
  // only in a toast the hub would immediately replace.
  const [submitBlocked, setSubmitBlocked] = useState(false);

  // Transfer the last edit to the shared writer now, before a reopened editor
  // can enqueue a newer version. Clear this mount's queue and fence its async
  // continuation: a delayed A reply must never enqueue B after the next C.
  useEffect(() => {
    // StrictMode replays this cleanup once on mount; the setup resets the
    // guard so the debounce keeps saving while the editor stays mounted.
    unmountedRef.current = false;
    return () => {
      cancelAutosave();
      unmountedRef.current = true;
      // Unmounted while a discard of this form is pending: the unsaved edits
      // go to the discard, which sends them if it is refused (#8966 final
      // r3s1/r4s1). No flush after a discard.
      const discardPending = discardRef.current === "pending" || sharedDiscardRef.current === "pending";
      const unsaved = discardPending ? latestUnsavedRef.current() : null;
      if (unsaved) afterDraftDiscard(saveOwner, formIdRef.current, (outcome) => { if (outcome === "refused") sendAfterClose(unsaved); });
      const pending = discardRef.current || sharedDiscardRef.current ? null : pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) sendAfterClose(pending);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The paired tree discarding this draft fences this editor too: while it is
  // pending nothing is prepared or sent, a success closes the editor without
  // saving, and a refusal sends the edits held meanwhile (#8309 final r6s1).
  const sharedDiscard = discards.find((entry) => entry.formId && entry.formId === formIdRef.current)?.state ?? null;
  sharedDiscardRef.current = sharedDiscard;
  useEffect(() => {
    if (sharedDiscard === "pending") {
      cancelAutosave();
    } else if (sharedDiscard === "done") {
      cancelAutosave();
      pendingSaveRef.current = null;
      heldDuringSharedRef.current = false;
      if (!unmountedRef.current && !discardRef.current) onClose();
    } else if (!discardRef.current && (heldDuringSharedRef.current || pendingSaveRef.current)) {
      heldDuringSharedRef.current = false;
      queueSave(stepRef.current);
      scheduleAutosave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the shared discard state only
  }, [sharedDiscard]);

  function cancelAutosave() {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  // A save sent after the editor closed still records the autofill it
  // carries; one that fails keeps it in the shared lane.
  function sendAfterClose(draft) {
    saveDraftInOrder(saveOwner, draftGeneration, saveDraftRef.current, draft)
      .then((id) => (id ? flushProvenance(id, draft.provenance) : undefined))
      .catch(() => {}); // swallow-ok: the editor is gone; a failed save stays in the shared lane or the offline queue
  }

  function queueSave(step) {
    if (discardRef.current) return;
    if (sharedDiscardRef.current) { heldDuringSharedRef.current = true; return; }
    const pending = pendingSaveRef.current;
    if (!pending || pending.answers !== answersRef.current || pending.step !== step) pendingSaveRef.current = draftFor(step);
  }
  function draftFor(step) {
    return { templateKey, answers: answersRef.current, step, base: serverBase,
      baseVersion: serverBaseVersion, baseRevision: serverBaseRevision, formId: shownFormId(form?.id), version: ++nextDraftSaveVersion, verify: inheritedCheck, editorToken,
      // Unrecorded autofill travels with the save that carries its answers.
      provenance: provenanceRef.current?.dirty ? provenanceRef.current.filled : null };
  }
  // The latest edits not yet sent, read by the unmount cleanup through a ref
  // so it uses this render's base and not the first render's.
  latestUnsavedRef.current = () => {
    const edited = Boolean(pendingSaveRef.current || discardHeldRef.current || heldDuringSharedRef.current
      || (discardStartRef.current && answersRef.current !== discardStartRef.current.answers));
    return edited ? draftFor(stepRef.current) : null;
  };

  // One request at a time: a newer edit must prepare its sealed version only
  // after the preceding write commits. Keep the latest snapshot pending until
  // it succeeds, independently of the debounce timer (Next clears that timer).
  // Strict callers must see failures; autosaves show them without interrupting
  // editing. An offline outbox entry is not a committed save.
  async function persist(step, { strict = false } = {}) {
    if (unmountedRef.current) {
      if (strict) throw new Error("form-editor-unmounted");
      return;
    }
    if (discardRef.current || sharedDiscardRef.current) {
      if (strict) throw new Error("form-draft-discard-pending");
      return;
    }
    if (closedElsewhereRef.current) {
      if (strict) throw new Error("form-closed-elsewhere");
      return;
    }
    queueSave(step);
    try {
      if (!saveInFlightRef.current) {
        saveInFlightRef.current = (async () => {
          let id;
          while (!unmountedRef.current && !sharedDiscardRef.current && pendingSaveRef.current) {
            const draft = pendingSaveRef.current;
            id = await saveDraftInOrder(saveOwner, draftGeneration, saveDraftRef.current, draft);
            if (!id && !demo) throw new Error("form-draft-not-committed");
            if (id) {
              formIdRef.current = id;
              if (!unmountedRef.current) setSavedId(id);
              // Record the fields this save carried, so the record matches the
              // answers it committed. A save that carried none records the
              // current map only when no newer save will carry it instead.
              await flushProvenance(id, draft.provenance ?? (pendingSaveRef.current === draft ? undefined : null));
            }
            if (pendingSaveRef.current === draft) pendingSaveRef.current = null;
            // The loop committed this edit; its debounce timer has nothing left to save.
            if (!pendingSaveRef.current) cancelAutosave();
            if (!unmountedRef.current) setSaveFailed(false);
          }
          return id;
        })().finally(() => { saveInFlightRef.current = null; });
      }
      const id = await saveInFlightRef.current;
      if (unmountedRef.current && strict) throw new Error("form-editor-unmounted");
      if (!id && strict) throw new Error("form-draft-not-committed");
      // A submit or close never leaves an unrecorded profile autofill behind.
      if (strict && provenanceRef.current?.dirty && !(await flushProvenance(id))) throw new Error("form-autofill-not-recorded");
    } catch (error) {
      if (error?.details === "form_not_editable") retireClosedForm();
      else if (error?.details === "form_saved_elsewhere") adoptStoredForm();
      else if (!unmountedRef.current) setSaveFailed(true);
      if (strict) throw error;
    }
  }

  // Another session saved this draft after the answers this editor's save was
  // based on. Nothing was written; the parent has re-read the forms. Drop the
  // rejected edit (never resent over the newer answers), show the stored
  // answers for review and ask for a fresh signature.
  function adoptStoredForm() {
    cancelAutosave();
    pendingSaveRef.current = null;
    const id = editorFormId();
    if (!unmountedRef.current) {
      setSaveFailed(false);
      setSavedElsewhere(true);
      // A refused first save has no form id: the draft another session made
      // is the template's open form in the forms the parent re-read (gate
      // final on #8770).
      setReviewReload(id || OPEN_DRAFT_OF_TEMPLATE);
    }
  }

  // The form this editor saves was submitted or closed elsewhere. The refusal
  // is final, so the rejected save leaves the editor and the shared lane
  // (never retried, never replayed into a new draft); the parent has re-read
  // the forms, and Close returns to the list without saving.
  function retireClosedForm() {
    closedElsewhereRef.current = true;
    cancelAutosave();
    pendingSaveRef.current = null;
    retireDraftLane(saveOwner, draftGeneration, saveDraftRef.current, templateKey, editorFormId());
    if (!unmountedRef.current) {
      setClosedElsewhere(true);
      setSaveFailed(false);
      setSignatureReady(false);
    }
  }

  function updateAnswer(key, value) {
    if (profileFilled && Object.hasOwn(profileFilled, key)) {
      const { [key]: _edited, ...rest } = profileFilled;
      setProvenance(rest);
    }
    updateAnswers({ [key]: value });
  }

  function setProvenance(next, { dirty = true, store = true } = {}) {
    setProfileFilled(next);
    provenanceRef.current = { filled: next, dirty };
    if (!dirty || !store) return;
    if (formIdRef.current) rememberPendingAutofill(formIdRef.current, next);
    else if (laneProvenanceKey) rememberPendingAutofill(laneProvenanceKey, next);
  }

  // Records kinds on the saved draft: the map a committed save carried, or
  // (undefined) the current one while it is dirty; null records nothing. False
  // (and pending on this device) when the record could not be written.
  // Writes go one at a time in call order, so an older map never lands last.
  async function flushProvenance(id, carried) {
    const current = provenanceRef.current;
    const filled = carried === undefined ? (current?.dirty ? current.filled : null) : carried;
    if (!autofillApi?.record || !filled || !id) return true;
    // The draft has its id now: the newest unrecorded map is kept under it
    // before the member-and-template copy goes, and stays until it is recorded.
    if (current?.dirty) rememberPendingAutofill(id, current.filled);
    if (laneProvenanceKey) rememberPendingAutofill(laneProvenanceKey, null);
    // The save before it, and an earlier record, can yield to a sign-in as
    // someone else: no record leaves under a session that ended (#8966 final,
    // the await audit). It stays remembered for this member's next session.
    const write = recordChainRef.current.then(() => {
      if (saveOwner && draftGeneration !== formDraftSessionGeneration()) throw new Error("form-draft-session-ended");
      return autofillApi.record(id, filled);
    });
    recordChainRef.current = write.catch(() => {});
    try {
      await write;
      const latest = provenanceRef.current;
      if (latest?.dirty && latest.filled === filled) provenanceRef.current = { ...latest, dirty: false };
      if (!provenanceRef.current?.dirty) rememberPendingAutofill(id, null);
      if (!unmountedRef.current) setAutofillRecordFailed(false);
      return true;
    } catch {
      rememberPendingAutofill(id, provenanceRef.current?.dirty ? provenanceRef.current.filled : filled);
      if (!unmountedRef.current) setAutofillRecordFailed(true);
      return false;
    }
  }

  function updateAnswers(patch) {
    // Computed OUTSIDE the updater, like goToStep does. Writing answersRef from
    // inside a setState updater makes the updater impure, and both of the ways
    // this app renders will punish that: StrictMode double-invokes updaters, and
    // the plane transition in App discards renders. answersRef is what the
    // autosave and the pre-submit flush actually SEND, so a discarded render
    // could persist answers the member never saw on screen.
    const next = { ...answersRef.current, ...patch };
    answersRef.current = next;
    setAnswers(next);
    if (!closedElsewhereRef.current) queueSave(stepRef.current);
    if (signatureReady) {
      setSignatureReady(false);
      setSignatureStale(true);
    }
    setSubmitBlocked(false);
    setSubmitChanged(false);
    setSavedElsewhere(false);
    scheduleAutosave();
  }

  function scheduleAutosave() {
    cancelAutosave();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (unmountedRef.current || !pendingSaveRef.current) return;
      persist(stepRef.current);
    }, AUTOSAVE_MS);
  }

  // The member's yes: fill every proposed field at once, mark each, and save
  // the draft, which records the accepted kinds. No: nothing is filled.
  function acceptAutofill() {
    const fills = autofill.proposal.filter((item) => !answersRef.current[item.fieldKey]);
    autofill.answer(true);
    if (!fills.length) { setProvenance({}, { dirty: false }); return; }
    setProvenance(Object.fromEntries(fills.map((item) => [item.fieldKey, item.kind])));
    updateAnswers(Object.fromEntries(fills.map((item) => [item.fieldKey, item.value])));
    cancelAutosave();
    void persist(stepRef.current);
  }

  function declineAutofill() {
    autofill.answer(false);
    setProvenance({}, { dirty: false });
  }

  useEffect(() => {
    // The member's Settings answer is "always fill": fill as a yes would.
    if (autofill.status === "always") acceptAutofill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill.status]);

  function goToStep(next, fieldKey = null) {
    cancelAutosave();
    const target = clamp(next, 0, reviewIndex);
    focusStepRef.current = target !== stepIndex;
    focusFieldRef.current = fieldKey;
    setStepIndex(target);
    stepRef.current = target;
    // Autosave on every step change, except a form nobody has touched yet:
    // stepping through a blank form saves no empty draft.
    if (formIdRef.current || pendingSaveRef.current || Object.keys(answersRef.current).length) persist(target);
  }

  const { pct, nextFieldKey } = formProgress(template || { steps: [] }, answers);
  // #9460 W4-17: the first required answer still empty, named and reachable from Review.
  const nextLabel = nextFieldKey ? t(fieldLabelKey(template, nextFieldKey)) : null;
  const nextStepIndex = nextFieldKey ? (template?.steps ?? []).findIndex((item) => item.fields.some((field) => field.key === nextFieldKey)) : -1;
  // The attachments and co-signers on file, from the parent's latest read of
  // this form, so a refresh (a refused signature, an upload, a review-step
  // remount) shows what the next signature will cover; the opening snapshot
  // is the fallback.
  const storedRow = storedForms.find((row) => row.id === (savedId || shownFormId(form?.id))) || null;
  const filesShown = storedRow?.files ?? form?.files ?? NO_FORM_FILES;
  // With the attachments unreadable, what the member
  // reviewed is unknown, so signing and submitting wait for a good read.
  const filesUnavailable = Boolean((storedRow ?? form)?.filesUnavailable);
  const filesHoldId = useId();
  // Only a signed-statement template asks for the filer's signature
  // (REQ-UG-FORMS-SIGNATURE-ONLY-ON-SIGNED-STATEMENTS-20261115), and
  // only once the server says so: the site can reach members before the
  // migration does, and until then submit_form still wants every signature
  // (#8965 r1s2/r2s2). The saved form's filing status decides; a missing
  // field, a failed read or no saved form yet keeps the signature required.
  // The demo has no server and follows the template rule.
  const templateOptional = !templateRequiresSignature(templateKey);
  const filingFormId = savedId || shownFormId(form?.id);
  const [serverSignatureOptional, setServerSignatureOptional] = useState(false);
  const atReview = stepIndex === reviewIndex;
  useEffect(() => {
    if (!templateOptional || !filingStatusApi || !filingFormId) return undefined;
    let live = true;
    Promise.resolve(filingStatusApi(filingFormId)).then(
      (status) => { if (live) setServerSignatureOptional(status?.signatureRequired === false); },
      () => { if (live) setServerSignatureOptional(false); },
    );
    return () => { live = false; };
  }, [templateOptional, filingStatusApi, filingFormId, atReview]);
  const signatureRequired = !(templateOptional && (demo ? true : serverSignatureOptional));
  const canSubmit = pct === 100 && (!signatureRequired || signatureReady) && !closedElsewhere && !filesUnavailable;
  const cosignersShown = storedRow?.cosigners ?? form?.cosigners ?? NO_COSIGNERS;

  async function ensureFormId() {
    await persist(stepRef.current, { strict: true });
    const id = editorFormId();
    if (!id) throw new Error("form-id-required");
    return id;
  }

  // The signature names what the member reviewed: these answers, the version
  // their checked save returned and the attachments on screen. When another
  // session saved in between, the database signs nothing and refuses; the
  // parent then re-reads the forms and the editor shows the stored answers.
  async function saveSignature(signature, consent, attachmentIds) {
    const id = await ensureFormId();
    const lane = draftLane(saveOwner, draftGeneration, saveDraftRef.current, templateKey);
    const review = { templateKey, answers: answersRef.current, dataVersion: lane?.baseVersion ?? serverBaseVersion, attachmentIds };
    try {
      return await onSignForm(id, signature, consent, review);
    } catch (error) {
      if (error?.details === "form_changed_since_review") setReviewReload(id);
      throw error;
    }
  }

  useEffect(() => {
    if (!reviewReload) return;
    setReviewReload(null);
    const stored = reviewReload === OPEN_DRAFT_OF_TEMPLATE
      ? storedForms.find((row) => row.templateKey === templateKey && (row.status === "draft" || row.status === "returned"))
      : storedForms.find((row) => row.id === reviewReload);
    if (!stored || stored.answersUnavailable) return;
    // The editor and its lane now write that form, so Close and the next save
    // are checked against its stored answers instead of refused again.
    if (!editorFormId()) {
      formIdRef.current = stored.id;
      setSavedId(stored.id);
    }
    // The stored answers and their version become this editor's baseline, so
    // its next save is checked against them and sends no unseen answers back.
    cancelAutosave();
    pendingSaveRef.current = null;
    pendingDraftFor(saveOwner, draftGeneration, saveDraftRef.current, templateKey,
      { serverAnswers: stored.answers ?? {}, serverVersion: stored.dataVersion ?? null, serverRevision: stored.revision, serverFormId: stored.id, closedForms });
    answersRef.current = { ...(stored.answers ?? {}) };
    setAnswers(answersRef.current);
    setSignatureReady(false);
    setSignatureStale(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per refusal, on the forms the parent re-read before it.
  }, [reviewReload]);

  async function addFile(file, options) {
    const id = await ensureFormId();
    return onAddFormFile(id, file, options);
  }

  function submit() {
    return runBusyWrite(editorWriteRef, "editor", submitNow);
  }

  async function submitNow() {
    if (filesUnavailable) return;
    setBusy(true);
    setSubmitBlocked(false);
    cancelAutosave();
    try {
      await persist(stepRef.current, { strict: true }); // flush latest answers, capture an id
    } catch {
      // Nothing is filed on a failed flush: submit_form validates the STORED
      // row, so submitting here would send the last answers that did save.
      setSubmitBlocked(true);
      setBusy(false);
      return;
    }
    const id = editorFormId();
    try {
      // What the member reviewed: these answers, the version their checked
      // save returned and the attachments on screen (#8705).
      const lane = draftLane(saveOwner, draftGeneration, saveDraftRef.current, templateKey);
      const review = { templateKey, answers: answersRef.current, dataVersion: lane?.baseVersion ?? serverBaseVersion,
        attachmentIds: filesShown.map((row) => row.id) };
      await onSubmit(id, review); // truthy result or null (demo) — parent owns the toast
      retireDraftLane(saveOwner, draftGeneration, onSaveDraft, templateKey, id);
      // The next fresh form of this template asks again.
      setProfileFilled(null);
      if (!unmountedRef.current) onClose(); // return to hub either way
    } catch (error) {
      // Changed elsewhere since review: nothing was filed. The parent has
      // re-read the forms; show the stored content, ask for a fresh review and
      // signature, and never resubmit on the member's behalf.
      if (error?.details === "form_changed_since_review" && id) {
        setReviewReload(id);
        setSubmitChanged(true);
      }
      setBusy(false); // stay in the editor so the member can retry
    }
  }

  function close() {
    return runBusyWrite(editorWriteRef, "editor", closeNow);
  }

  async function closeNow() {
    if (closingRef.current) return;
    closingRef.current = true;
    setBusy(true);
    try {
      cancelAutosave();
      if (closedElsewhereRef.current) {
        if (!unmountedRef.current) onClose();
        return;
      }
      // A remounted editor shows answers transferred from the shared queue but
      // holds none of their save state; flush them while that write is pending
      // or rejected, so Close never drops them.
      if (pendingSaveRef.current || saveInFlightRef.current || pendingDraftFor(saveOwner, draftGeneration, onSaveDraft, templateKey)) {
        await persist(stepRef.current, { strict: !demo });
      } else if (!demo && provenanceRef.current?.dirty && formIdRef.current && !(await flushProvenance(formIdRef.current))) {
        // The answers are saved but which fields came from the profile is not
        // recorded yet (a failed record, or one restored after a reload).
        throw new Error("form-autofill-not-recorded");
      }
      if (!unmountedRef.current) onClose();
    } catch {
      // Keep the editor and its pending answers available for another Close.
      setBusy(false);
    } finally {
      closingRef.current = false;
    }
  }

  if (!template) {
    return (
      <section className="message-section">
        <EmptyState>
          <p>{t("forms.startTitle")}</p>
        </EmptyState>
      </section>
    );
  }

  const onReview = stepIndex === reviewIndex;
  const step = onReview ? null : steps[stepIndex];
  // A saved, never-submitted draft can be discarded from the editor too. Its
  // unsent edits are held back, edits made while the delete is pending
  // prepare no save, and its lane waits on any dispatched save, so none
  // recreates it after the delete, including the save on close. A refused
  // delete keeps the draft as it was: the lane's baseline is untouched, the
  // held edits and any made meanwhile come back and autosave resumes (#8309
  // gate round 1 and final).
  const discardable = Boolean(onDiscard && formIdRef.current && (!form || form.status === "draft"));
  async function discardDraft() {
    cancelAutosave();
    const held = pendingSaveRef.current;
    pendingSaveRef.current = null;
    const answersAtDiscard = answersRef.current;
    discardHeldRef.current = held;
    discardStartRef.current = { answers: answersAtDiscard };
    const formId = formIdRef.current;
    discardRef.current = "pending";
    // Close waits while the delete is pending, so a refused one always finds
    // this editor mounted to give the held edits back (#8966 r1s3/r2s1).
    setBusy(true);
    // An editor unmounted meanwhile handed its edits to the discard, which
    // sends them on a refusal; a mounted one takes them back here.
    const giveBack = () => {
      discardRef.current = null;
      discardHeldRef.current = null;
      discardStartRef.current = null;
      if (!unmountedRef.current) {
        setBusy(false);
        if (held && !pendingSaveRef.current) pendingSaveRef.current = held;
        if (answersRef.current !== answersAtDiscard) queueSave(stepRef.current);
        if (pendingSaveRef.current) scheduleAutosave();
      }
    };
    let result;
    try {
      result = await trackDiscard(templateKey, formId,
        () => discardWithLane(saveOwner, draftGeneration, onSaveDraft, templateKey, formId, () => onDiscard(formId, templateKey)));
    } catch (error) {
      giveBack();
      throw error;
    }
    // A superseded operation (another account signed in meanwhile) answers
    // nothing and deleted nothing: the draft stays, and so do the edits (r2s3).
    if (result == null) {
      giveBack();
      return;
    }
    discardRef.current = "done";
    discardHeldRef.current = null;
    discardStartRef.current = null;
    if (!unmountedRef.current) onClose();
  }

  return (
    <section className="message-section" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <BusyButton
          type="button"
          className="outline-pill"
          onClick={close}
          pending={busy}
          style={{ minHeight: 40, padding: "6px 14px" }}
        >
          ← {t("forms.close")}
        </BusyButton>
        {discardable && <DiscardDraftControl t={t} onDiscard={discardDraft} />}
        <span style={{ flex: 1 }} />
        <span id={stepPositionId} style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", color: "var(--muted-foreground)" }}>
          {t("forms.stepOf", { current: stepIndex + 1, total: totalSteps })}
        </span>
      </div>

      <div>
        <header className="section-title">
          <h2 ref={stepHeadingRef} tabIndex={-1} aria-describedby={stepPositionId} className="mforms-step-heading">
            {onReview ? t("forms.reviewStep") : t(step.titleKey)}
          </h2>
        </header>
        <p role="status" className="visually-hidden">{stepAnnouncement}</p>
        <span style={{ height: 6, marginTop: 8, display: "block", borderRadius: 999, background: "var(--track)", overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: `${pct}%`, borderRadius: 999, background: "var(--green)" }} />
        </span>
      </div>

      <FormAutofillOffer offer={autofill} onAccept={acceptAutofill} onDecline={declineAutofill} filledCount={Object.keys(profileFilled || {}).length} />
      {autofillRecordFailed && <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--destructive)" }}>{t("formAutofill.recordFailed")}</p>}

      {onReview ? (
        <>
          <ReviewStep template={template} answers={answers} t={t} />
          <FormFilingControls
            t={filingT}
            headingLevel={desktop ? 2 : 3}
            editable
            demo={demo}
            files={filesShown}
            filesUnavailable={filesUnavailable}
            holdNoteId={filesHoldId}
            signatureCurrent={signatureReady}
            signatureStale={signatureStale}
            onAddFile={onAddFormFile ? addFile : null}
            onOpenFile={onOpenFormFile}
            onRecheckFile={onRecheckFormFile}
            onRemoveFile={onRemoveFormFile}
            onSaveSignature={onSignForm && signatureRequired ? saveSignature : null}
            onSignatureStateChange={(current) => {
              setSignatureReady(current);
              setSignatureStale(!current);
              if (current) setSubmitChanged(false);
            }}
          />
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {stepIndex === 0 && healthNoticeKeys(template).length > 0 && (
            // FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022:
            // the GINA safe-harbor notice and the no-diagnosis hint come before
            // the first field of an FMLA form.
            <div role="note" data-health-notice="gina" style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--card)" }}>
              {healthNoticeKeys(template).map((key, index) => (
                <p key={key} style={{ margin: index ? "8px 0 0" : 0, fontSize: 13, lineHeight: 1.45, color: "var(--ink)", fontWeight: index ? 700 : 400 }}>{t(key)}</p>
              ))}
            </div>
          )}
          {step.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={answers[field.key]}
              onChange={(value) => updateAnswer(field.key, value)}
              profileFilled={Boolean(profileFilled && Object.hasOwn(profileFilled, field.key) && answers[field.key])}
              t={t}
            />
          ))}
        </div>
      )}

      {savedElsewhere && (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--destructive)" }}>
          {t("forms.savedElsewhere")}
        </p>
      )}

      {submitChanged && (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--destructive)" }}>
          {t("forms.submitChangedSinceReview")}
        </p>
      )}

      {closedElsewhere && (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--destructive)" }}>
          {t("forms.closedElsewhere")}
        </p>
      )}

      {(submitBlocked || saveFailed) && (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--destructive)" }}>
          {t(submitBlocked ? "forms.submitSaveFailed" : "forms.draftSaveFailed")}
        </p>
      )}

      {onReview && pct !== 100 && nextLabel && (
        <p role="status" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--muted-foreground)" }}>
          {t("forms.stillNeeded", { label: nextLabel })}
        </p>
      )}
      {onReview && pct !== 100 && nextStepIndex >= 0 && (
        <BusyButton type="button" className="outline-pill" pending={busy} style={{ alignSelf: "flex-start" }} onClick={() => goToStep(nextStepIndex, nextFieldKey)}>
          {t("forms.goToField", { label: nextLabel })}
        </BusyButton>
      )}
      {onReview && pct === 100 && signatureRequired && !signatureReady && (
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--muted-foreground)" }}>
          {filingT("signatureRequired")}
        </p>
      )}

      {onReview && templateKey === "alliance_grievance" && (
        <CosignerPanel
          formId={savedId}
          cosigners={cosignersShown}
          t={t}
          onInvite={onInviteCosigner}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
        {stepIndex > 0 && (
          <BusyButton
            type="button"
            className="outline-pill"
            onClick={() => goToStep(stepIndex - 1)}
            pending={busy}
          >
            {t("forms.back")}
          </BusyButton>
        )}
        <span style={{ flex: 1 }} />
        {onReview ? (
          <BusyButton
            type="button"
            className="dialog-primary"
            onClick={submit}
            pending={busy}
            disabled={!canSubmit}
            aria-describedby={filesUnavailable ? filesHoldId : undefined}
            style={{ minWidth: 160 }}
          >
            {busy ? t("forms.submitting") : t("forms.submitCta")}
          </BusyButton>
        ) : (
          <BusyButton
            type="button"
            className="dialog-primary"
            onClick={() => goToStep(stepIndex + 1)}
            pending={busy}
            style={{ minWidth: 120 }}
          >
            {t("forms.next")}
          </BusyButton>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------- co-signer panel */

const COSIGN_STATUS_KEY = {
  invited: "forms.cosign.statusInvited",
  accepted: "forms.cosign.statusAccepted",
  declined: "forms.cosign.statusDeclined",
  reaffirm_needed: "forms.cosign.statusReaffirm",
  withdrawn: "forms.cosign.statusWithdrawn",
};

const COSIGN_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Server rows first and authoritative; local optimistic rows survive only until
// the server reports the same email back.
function mergeCosigners(serverRows, localRows) {
  const known = new Set(serverRows.map((row) => (row.email || "").toLowerCase()));
  const pending = localRows.filter((row) => !known.has((row.email || "").toLowerCase()));
  return pending.length === 0 ? serverRows : [...serverRows, ...pending];
}

// The filer's invite surface inside the alliance-grievance editor. Invites go
// through the definer RPC, which returns a uniform result whether or not the
// email maps to a member — so the panel shows every invite simply as "Invited"
// and never reveals membership. Inviting before the draft has a persisted id is
// impossible (no form_id yet), so we ask the member to save first.
function CosignerPanel({ formId, cosigners, t, onInvite }) {
  const [list, setList] = useState(cosigners);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inviteWriteRef = useRef(new Set());
  const emailRef = useRef(null);

  // MERGE, never replace. A successful invite calls the parent, which refreshes
  // App's data and re-renders FormEditor — so this effect fires immediately
  // after the optimistic row is added. Replacing the list there erased the
  // "Invited" row the member had just created, and for a FRESH alliance draft
  // it never came back, because editor.form stays null and so never gains the
  // server's co-signers. The server row wins wherever both sides know an email.
  useEffect(() => {
    setList((prev) => mergeCosigners(cosigners, prev));
  }, [cosigners]);

  // Invite stays focusable while it sends, under a synchronous
  // lock. A sent invite empties the field, which makes Invite unavailable, so
  // focus moves to the field rather than falling to the page.
  function invite(event) {
    return runBusyWrite(inviteWriteRef, "invite", () => inviteNow(event?.currentTarget ?? null), event);
  }

  async function inviteNow(button) {
    const norm = email.trim().toLowerCase();
    if (!COSIGN_EMAIL_RE.test(norm) || norm.length > 320) {
      setErr(t("forms.cosign.invalidEmail"));
      return;
    }
    setErr("");
    setBusy(true);
    try {
      await onInvite(formId, norm);
      setList((prev) => {
        const rest = prev.filter((c) => (c.email || "").toLowerCase() !== norm);
        return [...rest, { id: `local-${norm}`, email: norm, status: "invited" }];
      });
      setEmail("");
      if (button && document.activeElement === button) emailRef.current?.focus();
    } catch {
      // The app surfaces the error toast; leave the field so the filer can fix it.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD_CLASS} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <strong className="card-title" style={{ fontSize: 13.5 }}>
          {t("forms.cosign.panelTitle")}
        </strong>
        <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--muted-foreground)" }}>
          {t("forms.cosign.panelLead")}
        </span>
      </div>

      {list.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {list.map((c) => (
            <div key={c.id || c.email} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--ink)", overflowWrap: "anywhere" }}>{c.email}</span>
              <span
                className="reward-chip"
                style={{ flexShrink: 0, padding: "4px 9px", fontSize: 11, fontWeight: 800, background: "var(--card)", borderColor: "var(--border)", color: "var(--muted-foreground)" }}
              >
                {t(COSIGN_STATUS_KEY[c.status] || "forms.cosign.statusInvited")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>{t("forms.cosign.noneYet")}</span>
      )}

      {formId ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("forms.cosign.emailPlaceholder")}
              aria-label={t("forms.cosign.emailLabel")}
              style={{ ...INPUT, flex: 1, minWidth: 180 }}
            />
            <BusyButton type="button" className="dialog-primary" pending={busy} disabled={email.trim() === ""} onClick={invite} style={{ minWidth: 120 }}>
              {busy ? t("forms.cosign.inviting") : t("forms.cosign.inviteCta")}
            </BusyButton>
          </div>
          {err && (
            <span role="alert" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--gold)" }}>{err}</span>
          )}
        </div>
      ) : (
        <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>{t("forms.cosign.saveFirst")}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- review step */

/* -------------------------------------------------------- field renderers */

function Field({ field, value, onChange, profileFilled = false, t }) {
  const label = t(field.labelKey);
  const requirementId = useId();
  return (
    <FieldShell fieldKey={field.key} label={label} required={field.required} requirementId={requirementId} t={t}>
      <FieldControl field={field} value={value} onChange={onChange} label={label} requirementId={requirementId} t={t} />
      {profileFilled && <ProfileFilledMark />}
    </FieldShell>
  );
}

function FieldShell({ fieldKey, label, required, requirementId, t, children }) {
  return (
    <div data-field-key={fieldKey} style={{ display: "grid", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)", lineHeight: 1.3 }}>{label}</span>
        <span
          id={requirementId}
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            // 11px bold on the cream canvas. --gold is the CTA fill and measures
            // 1.83:1 here; --gold-ink is the readable gold text token.
            color: required ? "var(--gold-ink)" : "var(--muted-foreground)",
          }}
        >
          {required ? t("forms.required") : t("forms.optional")}
        </span>
      </div>
      {children}
    </div>
  );
}

// UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111: a
// field with a length limit says so and counts as you type, so nothing is
// cut silently. The count is part of the field's description.
const NON_TEXT_FIELD_TYPES = new Set(["select", "radio", "multiselect", "checkbox", "number", "date"]);

function LimitCount({ id, value, max, t }) {
  const count = String(value ?? "").length;
  const atLimit = count >= max;
  return (
    <span
      id={id}
      aria-live={atLimit ? "polite" : "off"}
      style={{ justifySelf: "end", fontSize: 12, fontWeight: atLimit ? 800 : 600, color: atLimit ? "var(--gold-ink)" : "var(--muted-foreground)" }}
    >
      {atLimit ? t("forms.charLimitReached", { max }) : t("forms.charCount", { count, max })}
    </span>
  );
}

function FieldControl({ field, value, onChange, label, requirementId, t }) {
  const countId = useId();
  const named = { "aria-label": label, "aria-required": Boolean(field.required), "aria-describedby": requirementId };
  // Free-text controls (textarea and the default text input) are the ones
  // that take maxLength; choices, numbers and dates do not.
  const limited = !NON_TEXT_FIELD_TYPES.has(field.type) && Number.isInteger(field.maxLength) && field.maxLength > 0;
  const requirement = { "aria-required": Boolean(field.required), "aria-describedby": limited ? `${requirementId} ${countId}` : requirementId };
  const count = limited ? <LimitCount id={countId} value={value} max={field.maxLength} t={t} /> : null;
  switch (field.type) {
    case "textarea":
      return (
        <>
          <textarea
            {...requirement}
            value={value ?? ""}
            maxLength={field.maxLength}
            onChange={(event) => onChange(event.target.value)}
            aria-label={label}
            style={{ ...INPUT, minHeight: 92, resize: "vertical" }}
          />
          {count}
        </>
      );

    case "select":
      return (
        <select
          {...requirement}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          style={INPUT}
          {...named}
        >
          <option value="" disabled>{t("forms.selectPlaceholder")}</option>
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
      );

    case "radio":
      return (
        <RadioGroup {...requirement} aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {(field.options || []).map((option) => {
            const active = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-describedby={requirementId}
                aria-checked={active}
                onClick={() => onChange(option.value)}
                style={chipStyle(active)}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </RadioGroup>
      );

    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div role="group" aria-label={label} aria-describedby={requirementId} style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {(field.options || []).map((option) => {
            const active = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                aria-describedby={requirementId}
                onClick={() =>
                  onChange(active ? selected.filter((v) => v !== option.value) : [...selected, option.value])
                }
                style={chipStyle(active)}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      );
    }

    case "checkbox":
      return <Switch label={label} checked={Boolean(value)} onChange={onChange} aria-describedby={requirementId} />;

    case "number":
      return (
        <input
          type="number"
          {...requirement}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          {...named}
          style={INPUT}
        />
      );

    case "date":
      return (
        <input
          type="date"
          {...requirement}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          {...named}
          style={INPUT}
        />
      );

    default:
      return (
        <>
          <input
            type="text"
            {...requirement}
            value={value ?? ""}
            maxLength={field.maxLength}
            onChange={(event) => onChange(event.target.value)}
            aria-label={label}
            style={INPUT}
          />
          {count}
        </>
      );
  }
}

/* --------------------------------------------------------------- helpers */

function fieldLabelKey(template, key) {
  if (!template) return null;
  for (const step of template.steps) {
    const field = step.fields.find((item) => item.key === key);
    if (field) return field.labelKey;
  }
  return null;
}

// Turn a stored answer into review-step text, or null when it's empty (renders
// as "Not answered yet"). Option-backed fields resolve to their translated
// label; multiselect joins them; scalars pass through trimmed.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
