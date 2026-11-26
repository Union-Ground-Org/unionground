import { AgendaItemsBuilder } from "./AgendaItemsBuilder.jsx";
import { Button } from "./Button.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { CalendarDays } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { rpcErrorText } from "../lib/rpcErrorText.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { eventEndedSince, eventIsPast, eventModelLabels, compareEventSchedule, eventScheduleInPast, eventTimeZoneLabel } from "../lib/eventModel.js";
import { EventTextCount } from "./EventTextCount.jsx";
import { EVENT_FORM_LIMITS, eventIdFromTitle } from "../lib/eventFormLimits.js";
import { keepOneParagraph, oneParagraph } from "../lib/eventSummary.js";
import { QuorumEditor, QuorumLine, useEventQuorum } from "./EventQuorum.jsx";
import { Pager } from "./Pager.jsx";
import { usePagedList } from "../lib/usePagedQueue.js";
import { WorkspaceCardTitle, useWorkspaceTitle } from "./WorkspacePages.jsx";

// UB-EVT-06: event authoring used to live inside the admin plane and gate on
// the admin role alone. gave all five staff hats the
// authoring path, so the card moved out here and is now mounted twice: by
// AdminView, exactly where it has always been, and by the shared Events desk
// staff tool that the other four hats reach. One component, one set of guards
// — the alternative was a second copy that would drift the first time either
// grew a field.
//
// Removal is two verbs, not one. Cancel is the normal case: the row, its RSVPs
// and its check-ins survive, members still see the event marked cancelled, and
// everyone who said they were going is told. Delete is for mistakes only and
// the server refuses it the moment the event has a single check-in.

export const EMPTY_EVENT = {
  id: "", title: "", startsAt: "", endsAt: "", eventKind: "meeting", eventDate: "", occurrences: 1, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: "", summary: "", checkInCode: "",
  isPublic: false, isPublicAcrossAgencies: false, rsvpOpen: true,
};

// A door code members can read aloud and type: no 0/O or 1/I. The form fills
// one in for every new meeting, so a code no longer has to be invented
// (finding 40 of the October 29-30 role-play run;
// REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateCheckInCode(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(6));
  return `SG-${Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("")}`;
}

// The keys a staff-only draft keeps, all of them the event form's own. Times
// are stored as instants and turned back into local input values on reopen.
// No time zone: the inputs are always in this browser's zone, so a draft
// reopened elsewhere is labelled and saved in the zone it is shown in.
const DRAFT_KEYS = ["id", "title", "eventKind", "startsAt", "endsAt", "eventDate", "occurrences",
  "location", "summary", "checkInCode", "isPublic", "isPublicAcrossAgencies", "rsvpOpen"];
export function draftFieldsFromForm(form) {
  const fields = {};
  for (const key of DRAFT_KEYS) {
    const value = form[key];
    if (value === undefined || value === null || value === "") continue;
    fields[key] = (key === "startsAt" || key === "endsAt") ? new Date(value).toISOString() : value;
  }
  return fields;
}
export function formFromDraft(draft) {
  const fields = draft?.fields && typeof draft.fields === "object" ? draft.fields : {};
  const form = { ...EMPTY_EVENT, draftId: draft.id };
  for (const key of DRAFT_KEYS) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (["isPublic", "isPublicAcrossAgencies", "rsvpOpen"].includes(key)) form[key] = value === true;
    else if (key === "startsAt" || key === "endsAt") form[key] = toLocalInput(value);
    else form[key] = String(value);
  }
  if (form.isPublicAcrossAgencies) form.isPublic = true;
  //: a restored draft brings its own web name, so the title no longer
  // replaces it.
  if (form.id) form.idEdited = true;
  return form;
}

function eventScopeLabel(event, t) {
  if (event.isPublicAcrossAgencies) return t("mevents.scopeAllAgencies");
  if (event.isPublic) return t("mevents.scopeAgency");
  return t("mevents.scopeChapter", { chapter: event.chapterName || "" });
}

function closeActionMenu(event) {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

function eventIdTaken(error) {
  return error?.code === "22023" && /(^|: )event id already exists$/.test(String(error?.message ?? ""));
}

export function EventForm({ mode, form, setForm, onSubmit, onCancel, busy, chapterName, t, rsvpSwitch = false, onSaveDraft = null, submitLabelKey = "admin.save" }) {
  const formRef = useRef(null);
  useLayoutEffect(() => {
    const node = formRef.current;
    const shell = node.closest(".sg-app");
    if (!shell) return;
    // At 320px the wrapped shell header can cover an entire focused field
    // when upward scrolling reveals it again. Keep that chrome in the flow
    // for the lifetime of either editor, including validation/keyboard scrolls.
    shell.classList.add("sg-app--event-authoring");
    return () => {
      if (![...shell.querySelectorAll(".event-authoring-form")].some(other => other !== node)) {
        shell.classList.remove("sg-app--event-authoring");
      }
    };
  }, []);
  const errorId = useId();
  const [submitErrors, setSubmitErrors] = useState({});
  const alertRef = useRef(null);
  // The alert is the only copy that names the missing fields, and on a phone
  // it can sit far above the field that blocked the save. After a rejected
  // submit commits, bring the alert into view, then focus the first invalid
  // control. Keyboard opening can scroll again despite preventScroll, so
  // restore the alert on visual viewport resize while that control has focus.
  const [rejected, setRejected] = useState(null);
  useEffect(() => {
    if (!rejected) return;
    const viewport = window.visualViewport;
    const restoreAlert = () => {
      if (document.activeElement === rejected.control) {
        alertRef.current?.scrollIntoView?.({ block: "nearest" });
      }
    };
    viewport?.addEventListener("resize", restoreAlert);
    alertRef.current?.scrollIntoView?.({ block: "nearest" });
    rejected.control.focus({ preventScroll: true });
    return () => viewport?.removeEventListener("resize", restoreAlert);
  }, [rejected]);
  const fieldLabels = {
    id: "admin.fieldId", title: "admin.fieldTitle", startsAt: "admin.fieldStarts",
    endsAt: "events.ends", eventDate: "events.date", occurrences: "events.repeat",
    location: "admin.fieldLocation", summary: "admin.fieldSummary", checkInCode: "admin.fieldCode",
  };
  // An error raised by a rejected save stays while the draft still holds that
  // value, or while a newer value still fails the field's checks ("ab" edited
  // to "a"); it clears once the value passes. The draft is device-parity
  // state, so the paired device can fill a field without this form's onChange
  // running; checking the value clears that field's error either way (gate
  // round 1 on; BUG-UG-EVENT-FIELD-ERROR-CLEARS-ON-ANY-EDIT-20261008).
  const timed = (form.eventKind ?? "meeting") === "meeting";
  const errors = {};
  for (const [name, error] of Object.entries(submitErrors)) {
    if (name === "endsAt" && (!timed || !form.endsAt || new Date(form.endsAt) > new Date(form.startsAt))) continue;
    if ((name === "startsAt" && !timed) || (name === "eventDate" && timed) || (name === "checkInCode" && !timed)) continue;
    if (form[name] === error.value) errors[name] = error;
    else {
      const message = name === "endsAt"
        ? (form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt) ? "events.endInvalid" : null)
        : draftFieldError(name, form[name], mode);
      if (message) errors[name] = { message, value: form[name] };
    }
  }
  const set = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };
  //: a new event's web name follows its title until the person touches
  // the Web name field. Any change there (clearing it, or typing a name that
  // happens to equal the title's) sets idEdited, which only a new form
  // (EMPTY_EVENT) clears. idAuto is the last name the title produced, so a
  // form that arrives with some other id (a paired device, a restored draft)
  // also keeps its own.
  const setTitle = (event) => {
    const title = event.target.value;
    setForm((prev) => {
      const follows = mode === "create" && !prev.idEdited && (!prev.id || prev.id === prev.idAuto);
      if (!follows) return { ...prev, title };
      const id = eventIdFromTitle(title);
      return { ...prev, title, id, idAuto: id };
    });
  };
  const setWebName = (event) => {
    const id = event.target.value;
    setForm((prev) => ({ ...prev, id, idEdited: true }));
  };
  const ruleId = (name) => `${errorId}-${name}-rule`;
  const fieldProps = (name) => ({
    name,
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": [errors[name] && errorId, EVENT_FORM_LIMITS[name] && ruleId(name)].filter(Boolean).join(" ") || undefined,
  });
  function submit(event) {
    event.preventDefault();
    if (busy) return;
    const invalid = {};
    let firstInvalid;
    for (const control of event.currentTarget.elements) {
      if (!Object.hasOwn(fieldLabels, control.name)) continue;
      const value = control.value.trim();
      // The API trims the id and code (and uppercases the code) before its
      // own check, so the pattern is tested on that value, not on the raw
      // input the browser's patternMismatch reads
      // (BUG-UG-EVENT-ID-CODE-UNTRIMMED-PATTERN-20261008).
      const { patternMismatch, valid } = control.validity;
      const pattern = EVENT_FIELD_PATTERNS[control.name];
      const badPattern = pattern ? Boolean(value) && !pattern.test(patternValue(control.name, value)) : patternMismatch;
      if (control.required && !value) invalid[control.name] = { message: "admin.eventFormRequired", value: form[control.name] };
      else if (badPattern || (!valid && !patternMismatch) || (value && control.minLength > 0 && value.length < control.minLength)) {
        invalid[control.name] = { message: "admin.eventFormInvalid", value: form[control.name] };
      }
      if (invalid[control.name]) firstInvalid ??= control;
    }
    if (timed && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) {
      invalid.endsAt = { message: 'events.endInvalid', value: form.endsAt };
      firstInvalid ??= event.currentTarget.elements.namedItem('endsAt');
    }
    setSubmitErrors(invalid);
    if (firstInvalid) { setRejected({ control: firstInvalid }); return; }
    onSubmit(event);
  }
  // Sharing across every agency widens the audience to the whole
  // organization, so turning it on takes an explicit confirmation; until the
  // operator confirms, the box stays off and a save keeps the narrower scope
  // (REQ-UG-EVENT-SHARE-ACROSS-ALL-AGENCIES-WORDING-20261006).
  const [confirmingShareAll, setConfirmingShareAll] = useState(false);
  const shareAllRef = useRef(null);
  const agencyBeforeShareAllRef = useRef(false);
  // Focus opens on Keep it off, so a repeated Space on the box can never
  // confirm by accident (gate round 2 on PR 4085).
  const keepShareAllOffRef = useRef(null);
  useEffect(() => {
    if (confirmingShareAll) keepShareAllOffRef.current?.focus();
  }, [confirmingShareAll]);
  // Both answers write the shared draft, so Keep it off also undoes a confirm
  // made meanwhile on the paired device (the draft is device-parity state),
  // restoring the agency choice from before this confirmation opened.
  function closeShareAll(confirmed) {
    setForm((prev) => (confirmed
      ? { ...prev, isPublicAcrossAgencies: true, isPublic: true }
      : { ...prev, isPublicAcrossAgencies: false, isPublic: agencyBeforeShareAllRef.current }));
    setConfirmingShareAll(false);
    shareAllRef.current?.focus();
  }
  const setVisibility = (key) => (event) => {
    const checked = event.target.checked;
    // Re-checking it on an event already saved as shared only restores that
    // audience, so it needs no confirmation (gate round 1 on PR 4085).
    if (key === "isPublicAcrossAgencies" && checked && !form.isPublicAcrossAgenciesOriginal) {
      agencyBeforeShareAllRef.current = Boolean(form.isPublic);
      setConfirmingShareAll(true);
      return;
    }
    if (key === "isPublicAcrossAgencies") setConfirmingShareAll(false);
    setForm((prev) => ({
      ...prev,
      [key]: checked,
      ...(key === "isPublicAcrossAgencies" && checked ? { isPublic: true } : {}),
    }));
  };
  // Required fields carry a visible * before any save is tried (finding 56);
  // the input's own required attribute still tells assistive technology.
  const fieldClass = (required) => (required ? "xus-field xus-field--required" : "xus-field");
  const name = (key) => <span className="xus-field__name">{t(key)}</span>;
  const scheduleEdited = mode === "create" || form.startsAt !== form.startsAtOriginal || form.eventDate !== form.eventDateOriginal
    || (form.eventKind ?? "meeting") !== (form.eventKindOriginal ?? "meeting");
  const pastWarning = scheduleEdited && eventScheduleInPast(form);
  // datetime-local inputs are read in this browser's zone, so that is the
  // zone named here, whatever a reopened draft carried.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneShort = eventTimeZoneLabel(form.startsAt || Date.now(), "en", zone);
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="xus-form event-authoring-form">
      <p className="xus-note">{t("admin.eventRequiredNote")}</p>
      {Object.keys(errors).length > 0 && (
        <div id={errorId} ref={alertRef} className="xus-note xus-note--error" role="alert">
          <p>{t("admin.eventFormReview")}</p>
          <ul>{Object.entries(errors).map(([name, error]) => (
            <li key={name}>{error.message === "admin.eventFormInvalid" && EVENT_FORM_LIMITS[name]
              ? `${t(fieldLabels[name])} — ${t(EVENT_FORM_LIMITS[name].rule, EVENT_FORM_LIMITS[name])}`
              : t(error.message, { field: t(fieldLabels[name]) })}</li>
          ))}</ul>
        </div>
      )}
      <label className={fieldClass(mode === "create")}>{name("admin.fieldTitle")}<input {...fieldProps("title")} className="xus-input" value={form.title} onChange={setTitle} required={mode === "create"} minLength={EVENT_FORM_LIMITS.title.min} maxLength={EVENT_FORM_LIMITS.title.max} /></label>
      <small id={ruleId("title")} className="xus-note">
        {t(EVENT_FORM_LIMITS.title.rule, EVENT_FORM_LIMITS.title)}
        <EventTextCount t={t} count={form.title?.length ?? 0} max={EVENT_FORM_LIMITS.title.max} />
      </small>
      {mode === "create" && <>
        <label className={fieldClass(true)}>{name("admin.fieldId")}<input {...fieldProps("id")} className="xus-input" value={form.id} onChange={setWebName} required pattern={EVENT_FORM_LIMITS.id.pattern} /></label>
        <small id={ruleId("id")} className="xus-note">{t("admin.eventIdFromTitle")} {t(EVENT_FORM_LIMITS.id.rule, EVENT_FORM_LIMITS.id)}</small>
      </>}
      <label className="xus-field">{t("events.kind")}<select className="xus-input" value={form.eventKind ?? "meeting"} onChange={(event) => setForm((prev) => ({ ...prev, eventKind: event.target.value, occurrences: 1 }))}>
        {["meeting", "deadline", "date_only"].map((kind) => <option key={kind} value={kind}>{t(`events.${kind}`)}</option>)}
      </select></label>
      {timed ? <>
        <label className={fieldClass(true)}>{name("admin.fieldStarts")}<input {...fieldProps("startsAt")} className="xus-input" type="datetime-local" value={form.startsAt} onChange={set("startsAt")} required /></label>
        <label className="xus-field">{t("events.ends")}<input {...fieldProps("endsAt")} className="xus-input" type="datetime-local" value={form.endsAt ?? ""} onChange={set("endsAt")} /></label>
        {mode === "create" && <>
          <label className={fieldClass(true)}>{name("events.repeat")}<input {...fieldProps("occurrences")} className="xus-input" type="number" min={EVENT_FORM_LIMITS.occurrences.min} max={EVENT_FORM_LIMITS.occurrences.max} step="1" required value={form.occurrences ?? 1} onChange={set("occurrences")} aria-describedby={[ruleId("occurrences"), errors.occurrences && errorId].filter(Boolean).join(" ")} /></label>
          <small id={ruleId("occurrences")} className="xus-note">
            {t(EVENT_FORM_LIMITS.occurrences.rule, EVENT_FORM_LIMITS.occurrences)} {t("events.repeatHelp")}
          </small>
        </>}
        <p className="xus-note">{t("admin.eventTimeZone", { zone: zoneShort ? `${zone} (${zoneShort})` : zone })}</p>
      </> : <label className={fieldClass(true)}>{name("events.date")}<input {...fieldProps("eventDate")} className="xus-input" type="date" value={form.eventDate ?? ""} onChange={set("eventDate")} required /></label>}
      {pastWarning && <p className="xus-note xus-note--warn" role="status">{t("admin.eventPastWarning")}</p>}
      {mode === "edit" && <p className="xus-note">{t("events.oneDate")}</p>}
      <label className={fieldClass(mode === "create")}>{name("admin.fieldLocation")}<input {...fieldProps("location")} className="xus-input" value={form.location} onChange={set("location")} required={mode === "create"} maxLength={120} /></label>
      <label className={fieldClass(mode === "create")}>{name("admin.fieldSummary")}<textarea {...fieldProps("summary")} className="xus-input xus-input--area" value={form.summary} onChange={(event) => setForm((prev) => ({ ...prev, summary: oneParagraph(event.target.value) }))} onKeyDown={keepOneParagraph} required={mode === "create"} maxLength={500} aria-describedby={errors.summary ? `${errorId} ${errorId}-summary-help` : `${errorId}-summary-help`} /></label>
      <small id={`${errorId}-summary-help`} className="xus-note">{t("admin.fieldSummaryHelp")}</small>
      {/* Optional: a deadline or reminder has no door code, and nobody can
          check in to an event without one. Clearing a saved code removes it
          (BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006). */}
      {timed && <>
      <label className="xus-field">{t("admin.fieldCode")}<input {...fieldProps("checkInCode")} className="xus-input xus-input--code" value={form.checkInCode} onChange={set("checkInCode")} pattern={EVENT_FORM_LIMITS.checkInCode.pattern} /></label>
      <small id={ruleId("checkInCode")} className="xus-note">
        {t(EVENT_FORM_LIMITS.checkInCode.rule, EVENT_FORM_LIMITS.checkInCode)}{" "}
        <span>{t(mode === "edit" && form.checkInCodeOriginal ? "admin.fieldCodeRemoveHelp" : mode === "create" && form.checkInCode ? "admin.fieldCodeGeneratedHelp" : "admin.fieldCodeOptionalHelp")}</span>
      </small>
      <div className="xus-btnrow">
        <button type="button" className="xus-btn" onClick={() => setForm((prev) => ({ ...prev, checkInCode: generateCheckInCode() }))}>{t("admin.generateCode")}</button>
      </div>
      {rsvpSwitch && (
        <label className="xus-event-check">
          <input type="checkbox" aria-label={t("admin.eventRsvpOpen")} checked={form.rsvpOpen !== false} onChange={(event) => { const checked = event.target.checked; setForm((prev) => ({ ...prev, rsvpOpen: checked })); }} />
          <span><strong>{t("admin.eventRsvpOpen")}</strong><small>{t("admin.eventRsvpOpenHelp")}</small></span>
        </label>
      )}
      </>}
      <fieldset className="xus-event-scope">
        <legend>{t("admin.eventScopeTitle")}</legend>
        <p className="xus-note">{t("admin.eventPublishesTo", { chapter: chapterName || t("admin.eventChapterUnavailable") })}</p>
        <label className="xus-event-check">
          <input type="checkbox" aria-label={t("admin.eventShareAgency")} checked={Boolean(form.isPublic)} disabled={Boolean(form.isPublicAcrossAgencies)} onChange={setVisibility("isPublic")} />
          <span><strong>{t("admin.eventShareAgency")}</strong><small>{t("admin.eventShareAgencyHelp")}</small></span>
        </label>
        <label className="xus-event-check">
          <input ref={shareAllRef} type="checkbox" aria-label={t("admin.eventShareAllAgencies")} aria-expanded={confirmingShareAll} checked={Boolean(form.isPublicAcrossAgencies)} onChange={setVisibility("isPublicAcrossAgencies")} />
          <span><strong>{t("admin.eventShareAllAgencies")}</strong><small>{t("admin.eventShareAllAgenciesHelp")}</small></span>
        </label>
        {confirmingShareAll && (
          <div className="xus-event-confirm" role="group" aria-labelledby={`${errorId}-share-all`}>
            <p id={`${errorId}-share-all`}><strong>{t("admin.eventShareAllConfirmTitle")}</strong></p>
            <p className="xus-note">{t("admin.eventShareAllConfirmBody")}</p>
            <div className="xus-btnrow">
              <button type="button" className="xus-btn xus-btn--go" onClick={() => closeShareAll(true)}>{t("admin.eventShareAllConfirm")}</button>
              <button ref={keepShareAllOffRef} type="button" className="xus-btn" onClick={() => closeShareAll(false)}>{t("admin.eventShareAllKeepOff")}</button>
            </div>
          </div>
        )}
      </fieldset>
      <div className="xus-btnrow">
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t(submitLabelKey)}</BusyButton>
        {onSaveDraft && <BusyButton type="button" className="xus-btn" pending={busy} onClick={onSaveDraft}>{t("admin.saveDraft")}</BusyButton>}
        <button type="button" className="xus-btn" onClick={onCancel}>{t("admin.cancel")}</button>
      </div>
    </form>
  );
}

// The same checks the form's own attributes make, read from a draft value
// rather than the input, so an error can be re-judged after the paired device
// changes the draft. Keep in step with the required, pattern and length
// attributes in EventForm. Patterns are tested on the value the API sends:
// trimmed, and the code uppercased.
const EVENT_FIELD_PATTERNS = {
  id: new RegExp(`^(?:${EVENT_FORM_LIMITS.id.pattern})$`),
  checkInCode: new RegExp(`^(?:${EVENT_FORM_LIMITS.checkInCode.pattern})$`),
};
function patternValue(name, text) {
  return name === "checkInCode" ? text.toUpperCase() : text;
}
export function draftFieldError(name, value, mode) {
  const text = String(value ?? "").trim();
  if (!text) return (["startsAt", "eventDate"].includes(name) || (mode === "create" && !["checkInCode", "endsAt"].includes(name))) ? "admin.eventFormRequired" : null;
  if (name === "occurrences" && (!Number.isInteger(Number(text)) || Number(text) < EVENT_FORM_LIMITS.occurrences.min || Number(text) > EVENT_FORM_LIMITS.occurrences.max)) return "admin.eventFormInvalid";
  if (EVENT_FIELD_PATTERNS[name] && !EVENT_FIELD_PATTERNS[name].test(patternValue(name, text))) return "admin.eventFormInvalid";
  if (name === "title" && text.length < EVENT_FORM_LIMITS.title.min) return "admin.eventFormInvalid";
  return null;
}

const EVENT_PAGE_SIZE = 10;
const RECENT_PAST_MS = 7 * 24 * 3600 * 1000;

export function EventAuthoringCard({
  events,
  api,
  onNotice,
  reload,
  titleKey = "admin.eventsTitle",
  subKey = "admin.eventsSub",
  emptyKey = null,
  chapterName = "",
  showHeading = true,
  loading = false,
  renderConnectedActions = null,
}) {
  const { t, lang } = useLang();
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);
  // REQ-UG-MEETING-QUORUM-COUNTS-20261030: each meeting's quorum and
  // checked-in count, and (where the desk can write it) the quorum control.
  const quorum = useEventQuorum(api?.loadEventQuorum, events);
  const saveQuorum = async (eventId, value) => {
    const result = await api.setEventQuorum(eventId, value);
    if (!active.current) return;
    // The quorum bumps the event's version, and the list re-reads it. An open
    // edit or agenda form for this event adopts the new version only when
    // this save accounts for the whole change: one step past the version the
    // form holds, or none when nothing changed. Anything else (an undo in
    // another tab, say) means the form's fields are stale, so it keeps its
    // version and its save is refused instead of putting back what changed.
    if (Number.isInteger(result?.version)) {
      const next = (held) => (Number.isInteger(held) && result.version === held + (result.changed === false ? 0 : 1) ? result.version : held);
      setForm((current) => (current?.id === eventId ? { ...current, version: next(current.version) } : current));
      if (agendaId === eventId) setAgendaVersion((held) => next(held));
    }
    onNotice(t(value === null ? "eventQuorum.cleared" : "eventQuorum.saved"));
    reload();
    await quorum.refresh();
  };
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  // Parity keys carried over verbatim from AdminView so an operator who starts
  // an edit on the desktop still finds it open on the companion phone.
  const [creating, setCreating] = useDeviceParityState("admin.creatingEvent", false);
  const [editingId, setEditingId] = useDeviceParityState("admin.editingEventId", null);
  const [form, setForm] = useDeviceParityState("admin.eventForm", EMPTY_EVENT);
  const [cancellingId, setCancellingId] = useDeviceParityState("admin.cancellingEventId", null);
  const [cancelReason, setCancelReason] = useDeviceParityState("admin.eventCancelReason", "");
  const [deletingId, setDeletingId] = useDeviceParityState("admin.deletingEventId", null);
  const [agendaId, setAgendaId] = useDeviceParityState("admin.agendaEventId", null);
  const [agendaDraft, setAgendaDraft] = useDeviceParityState("admin.eventAgendaDraft", "");
  // The version the agenda editor opened, sent back so a stale save is refused.
  // It travels with the agenda id and draft, so the paired phone saves the
  // form with the same version the desktop opened (gate finding r4g1 on).
  const [agendaVersion, setAgendaVersion] = useDeviceParityState("admin.eventAgendaVersion", null);
  const agendaFieldRef = useRef(null);
  // Staff-only drafts (finding 55) and the door display (finding 40). Both
  // stay on this device: a door display is for the screen at the door.
  const draftsOffered = Boolean(api.listEventDrafts && api.saveEventDraft && api.deleteEventDraft);
  const rsvpSwitch = Boolean(api.setEventRsvpOpen);
  const [drafts, setDrafts] = useState([]);
  const [doorEventId, setDoorEventId] = useState(null);
  const doorTriggerRef = useRef(null);
  const loadDrafts = useCallback(async () => {
    if (!draftsOffered) return;
    try {
      const rows = await api.listEventDrafts();
      if (active.current) setDrafts(Array.isArray(rows) ? rows : []);
    } catch {
      // A desk without the drafts function yet still lists its events.
    }
  }, [api, draftsOffered]);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  const closeDoorDisplay = useCallback(() => {
    setDoorEventId(null);
    doorTriggerRef.current?.focus?.();
  }, []);

  // Every write funnels through here so one in-flight guard covers all six
  // verbs, and so a refused write reaches the operator translated rather than
  // as the raw English the database raised (UB-EVT-05's mapping, reused).
  async function run(work, notice) {
    if (!active.current || inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await work();
      if (!active.current) return false;
      onNotice(t(typeof notice === "function" ? notice(result) : notice));
      reload();
      return result ?? true;
    } catch (err) {
      //: create_member_event and create_member_event_model refuse a
      // taken web name with 22023 "event id already exists" (MemberApiError
      // prefixes its label); say it in the reader's language instead.
      if (active.current) onNotice(eventIdTaken(err) ? t("admin.eventIdTaken") : rpcErrorText(t, err, "toast.saveFailed"));
      return false;
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  function closeAll() {
    if (!active.current) return;
    setCreating(false);
    setEditingId(null);
    setCancellingId(null);
    setDeletingId(null);
    setAgendaId(null);
    setAgendaDraft("");
    setAgendaVersion(null);
    setCancelReason("");
    setForm(EMPTY_EVENT);
  }

  async function submitCreate(event) {
    event.preventDefault();
    const timed = (form.eventKind ?? 'meeting') === 'meeting';
    // RSVP collection off travels with the create (one server transaction).
    // The draft clean-up follows it; a failed clean-up is reported without
    // losing the event.
    let followUpError = null;
    const ok = await run(
      async () => {
        const result = await api.createEvent({ ...form,
          summary: oneParagraph(form.summary),
          startsAt: timed ? new Date(form.startsAt).toISOString() : null,
          endsAt: timed && form.endsAt ? new Date(form.endsAt).toISOString() : null,
          eventDate: timed ? null : form.eventDate,
          checkInCode: timed ? form.checkInCode : '',
          rsvpOpen: !(timed && rsvpSwitch && form.rsvpOpen === false),
        });
        try {
          if (form.draftId && draftsOffered) await api.deleteEventDraft(form.draftId);
        } catch (error) {
          followUpError = error;
        }
        return result;
      },
      "admin.eventCreated",
    );
    if (followUpError && active.current) onNotice(rpcErrorText(t, followUpError, "toast.saveFailed"));
    if (ok) {
      closeAll();
      if (form.draftId) loadDrafts();
    }
  }

  async function submitDraft() {
    if (!form.title?.trim()) {
      onNotice(t("admin.eventDraftNeedsTitle"));
      return;
    }
    const ok = await run(() => api.saveEventDraft(form.draftId || null, draftFieldsFromForm(form)), "admin.eventDraftSaved");
    if (ok) {
      closeAll();
      loadDrafts();
    }
  }

  async function deleteDraft(draftId) {
    const ok = await run(() => api.deleteEventDraft(draftId), "admin.eventDraftDeleted");
    if (ok) {
      if (form.draftId === draftId) closeAll();
      loadDrafts();
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    // startsAt is prefilled so the operator can SEE the current time, but it is
    // only sent when they actually changed it. Sending it back unchanged would
    // not be harmless: <input type="datetime-local"> has minute precision, so a
    // stored time carrying seconds would round-trip to a different value, the
    // server would score that as a real reschedule, and every member who said
    // they were going would be notified of a change nobody made.
    const startsAtEdited = Boolean(form.startsAt) && form.startsAt !== form.startsAtOriginal;
    const timed = (form.eventKind ?? 'meeting') === 'meeting';
    const scheduleEdited = startsAtEdited || form.endsAt !== form.endsAtOriginal
      || form.eventKind !== form.eventKindOriginal || form.eventDate !== form.eventDateOriginal;
    const fields = {
      eventModelRequired: form.eventKindOriginal !== 'meeting' || Boolean(form.endsAtOriginal),
      schedule: scheduleEdited ? {
        kind: form.eventKind,
        startsAt: timed ? (startsAtEdited ? new Date(form.startsAt).toISOString() : form.startsAtStored) : null,
        eventDate: timed ? null : form.eventDate,
        endsAt: timed && form.endsAt ? (form.endsAt === form.endsAtOriginal ? form.endsAtStored : new Date(form.endsAt).toISOString()) : null,
      } : null,
      title: form.title.trim() || null,
      startsAt: startsAtEdited ? new Date(form.startsAt).toISOString() : null,
      location: form.location.trim() || null,
      summary: oneParagraph(form.summary).trim() || null,
      checkInCode: timed ? form.checkInCode.trim() || null : "",
      // The edit form opens with the saved code filled in, so an emptied field
      // is a deliberate removal, not an omission.
      removeCheckInCode: !timed || (!form.checkInCode.trim() && Boolean(form.checkInCodeOriginal)),
      isPublic: form.isPublic !== form.isPublicOriginal ? Boolean(form.isPublic) : null,
      isPublicAcrossAgencies: form.isPublicAcrossAgencies !== form.isPublicAcrossAgenciesOriginal
        ? Boolean(form.isPublicAcrossAgencies)
        : null,
      // A save from a stale form is refused rather than overwriting a newer
      // change (an undo included).
      expectedVersion: form.version,
    };
    // RSVP collection has its own switch; the update goes first, so a retry
    // after a failed switch finds the fields already saved.
    const rsvpChanged = timed && rsvpSwitch && (form.rsvpOpen !== false) !== (form.rsvpOpenOriginal !== false);
    const ok = await run(
      async () => {
        const result = await api.updateEvent(editingId, fields);
        // The saved fields have a new version; a retry after the RSVP switch
        // fails must send it, not the one the form opened with.
        if (Number.isInteger(result?.version) && active.current) setForm((current) => ({ ...current, version: result.version }));
        if (!rsvpChanged) return result;
        // The switch is its own request, so it sends the version this update
        // left: an undo landing between the two refuses the switch instead of
        // letting it put back what the undo took away (gate finding r4s1).
        await api.setEventRsvpOpen(editingId, form.rsvpOpen !== false, result?.version);
        return { ...result, updated: true };
      },
      (r) => (r?.updated === false ? "admin.eventNoChange" : "admin.eventUpdated"),
    );
    if (ok) closeAll();
  }

  async function submitCancel(eventId) {
    const ok = await run(
      () => api.cancelEvent(eventId, cancelReason),
      // The RPC is idempotent, so a second cancel reports honestly rather than
      // claiming it just told everyone again.
      (r) => (r?.changed === false ? "admin.eventNoop" : "admin.eventCancelled"),
    );
    if (ok) closeAll();
  }

  async function submitRestore(eventId) {
    const ok = await run(
      () => api.restoreEvent(eventId),
      (r) => (r?.changed === false ? "admin.eventNoop" : "admin.eventRestored"),
    );
    if (ok) closeAll();
  }

  async function submitDelete(eventId) {
    const ok = await run(() => api.deleteEvent(eventId), "admin.eventDeleted");
    if (ok) closeAll();
  }

  async function submitAgenda(event) {
    event.preventDefault();
    // Without the version the form opened, the database could not tell a
    // stale save from a fresh one, so the save is not sent at all.
    if (!Number.isInteger(agendaVersion)) {
      onNotice(t("admin.eventAgendaReopen"));
      return;
    }
    const ok = await run(
      () => api.setEventAgenda(agendaId, agendaDraft, agendaVersion),
      (r) => (r?.agenda ? "admin.eventAgendaSaved" : "admin.eventAgendaCleared"),
    );
    if (ok) closeAll();
  }

  const rows = (events || []).map((event) => event.startsAt || event.eventDate ? { ...event, ...eventModelLabels(event, lang) } : event);
  // REQ-UG-EVENTS-CARD-HIERARCHY-20261102: upcoming events first, then
  // the past ones under their own heading and badge; history stays listed.
  const nowMs = Date.now();
  const upcomingRows = rows.filter((item) => !eventIsPast(item, nowMs)).sort(compareEventSchedule);
  const pastRows = rows.filter((item) => eventIsPast(item, nowMs)).sort((a, b) => compareEventSchedule(a, b, -1));
  const pastIds = new Set(pastRows.map((item) => item.id));
  // UX-UG-LONG-PAGES-RENDER-EVERY-ROW-EXPANDED-WITH-NO-PAGING-20261122
  // (A-3, B-42): every event used to be drawn with its whole toolset, 124 of
  // them on one 41,453 px page. Upcoming events come ten to a page; past ones
  // page the same way, folded unless one ended in the last week, so last
  // night's attendance is still in view. A person's choice of fold wins over
  // that default. The pager clamps to an existing page after any change to the
  // list, and a row whose form is open stays drawn when its page or fold is
  // left. Each title is a heading one level under its group's, so a screen
  // reader can move between events.
  const upcomingPage = usePagedList(upcomingRows, EVENT_PAGE_SIZE);
  const pastPage = usePagedList(pastRows, EVENT_PAGE_SIZE);
  const [pastChoice, setPastChoice] = useState(null);
  const pastOpen = pastChoice ?? pastRows.some((item) => eventEndedSince(item, nowMs - RECENT_PAST_MS));
  const pastListId = useId();
  // Groups and events sit one and two levels under the heading above them: the
  // card's h3, or the hidden h2 WorkspaceCardTitle keeps when the page already
  // prints that title, or on the Events desk (no card title) the page's h1.
  const pageTitle = useWorkspaceTitle(null);
  const cardLevel = !showHeading ? 1 : pageTitle && pageTitle === t(titleKey) ? 2 : 3;
  const GroupTitle = `h${cardLevel + 1}`;
  const EventTitle = `h${cardLevel + (pastRows.length > 0 ? 2 : 1)}`;
  const formRowId = editingId ?? agendaId ?? cancellingId ?? deletingId;
  // A past row kept on screen for its open form counts as shown, so the toggle
  // never says the past events are hidden while one is in view.
  const pastShown = pastOpen || (formRowId != null && pastRows.some((item) => item.id === formRowId));
  const shownRows = (group, paged) => {
    const listed = group === "upcoming" || pastOpen ? paged.rows : [];
    const held = formRowId != null && !listed.some((item) => item.id === formRowId)
      && (group === "past" ? pastRows : upcomingRows).find((item) => item.id === formRowId);
    return held ? [...listed, held] : listed;
  };

  return (
    <article id="admin-events" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className={`xus-cardhead${showHeading ? "" : " xus-cardhead--actions"}`}>
        {showHeading && <span className="xus-glyph" aria-hidden="true"><CalendarDays size={18} /></span>}
        {showHeading && <div className="xus-cardhead__copy">
          <WorkspaceCardTitle outline as="h3" className="xus-cardttl">{t(titleKey)}</WorkspaceCardTitle>
          <p className="xus-cardsub">{t(subKey)}</p>
        </div>}
        {!creating && (
          <button type="button" className="xus-btn xus-btn--go" onClick={() => { closeAll(); setCreating(true); setForm({ ...EMPTY_EVENT, checkInCode: generateCheckInCode() }); }}>
            {t("admin.newEvent")}
          </button>
        )}
      </header>
      {creating && (
        <div className="xus-cardbody">
          <EventForm mode="create" form={form} setForm={setForm} onSubmit={submitCreate} onCancel={closeAll} busy={busy} chapterName={chapterName} t={t}
            rsvpSwitch={rsvpSwitch} onSaveDraft={draftsOffered ? submitDraft : null} submitLabelKey={form.draftId ? "admin.publishEvent" : "admin.save"} />
        </div>
      )}
      {draftsOffered && drafts.length > 0 && (
        <div className="xus-cardbody xus-event-drafts">
          <p className="xus-eline"><strong>{t("admin.eventDraftsTitle")}</strong></p>
          <p className="xus-note">{t("admin.eventDraftsHelp")}</p>
          <ul className="xus-event-drafts__list">
            {drafts.map((draft) => {
              const fields = draft.fields || {};
              const kind = fields.eventKind || "meeting";
              // A draft's dates are whatever was saved; only a readable one is
              // formatted, so a bad value never stops the list rendering.
              const readable = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
              const scheduled = kind === "meeting" ? readable(fields.startsAt)
                : typeof fields.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.eventDate) && readable(`${fields.eventDate}T12:00:00`);
              const when = scheduled
                ? eventModelLabels({ eventKind: kind, startsAt: kind === "meeting" ? fields.startsAt : null, eventDate: kind === "meeting" ? null : fields.eventDate, endsAt: kind === "meeting" && readable(fields.endsAt) ? fields.endsAt : null }, lang).startsLabel
                : t("admin.eventDraftUnscheduled");
              return (
                <li key={draft.id} className="xus-erow" data-automation-source-id={draft.id}>
                  <strong className="xus-etitle">{fields.title}</strong>
                  <span className="xus-badge">{t("admin.eventDraftBadge")}</span>
                  <p className="xus-eline">{when}</p>
                  <div className="xus-btnrow">
                    <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => { closeAll(); setCreating(true); setForm(formFromDraft(draft)); }}>
                      {t("admin.publishDraft")}
                    </BusyButton>
                    <BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy} onClick={() => deleteDraft(draft.id)}>
                      {t("admin.deleteDraft")}
                    </BusyButton>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {loading && (
        <div className="xus-cardbody"><p className="xus-eline" role="status">{t("eventsDesk.loading")}</p></div>
      )}
      {emptyKey && !loading && rows.length === 0 && !creating && (
        <div className="xus-cardbody"><p className="xus-eline">{t(emptyKey)}</p></div>
      )}
      {renderConnectedActions && rows.length > 0 && <p className="xus-eline xus-event-howto">{t("admin.eventFollowUpHint")}</p>}
      {[["upcoming", upcomingPage], ["past", pastPage]].map(([group, paged]) => paged.total > 0 && <div key={group} className="xus-event-group">
      {pastRows.length > 0 && <GroupTitle className="xus-event-group__title">{t(group === "past" ? "admin.eventsPastTitle" : "admin.eventsUpcomingTitle")}</GroupTitle>}
      {group === "past" && (
        <button type="button" className="xus-btn xus-event-group__toggle" aria-expanded={pastShown} aria-controls={pastListId} onClick={() => setPastChoice(!pastShown)}>
          {pastShown ? t("admin.eventsPastHide") : paged.total === 1 ? t("admin.eventsPastShowOne") : t("admin.eventsPastShow", { count: paged.total })}
        </button>
      )}
      <div id={group === "past" ? pastListId : undefined}>
      {shownRows(group, paged).map((item) => {
        const cancelled = Boolean(item.cancelledAt);
        const past = pastIds.has(item.id);
        return (
          <div key={item.id} data-automation-source-id={item.id} className={`xus-erow${cancelled ? " xus-erow--cancelled" : ""}`}>
            <div className="xus-etop xus-etop--event">
              <div className="xus-emain">
                <div className="xus-ehead">
                  <EventTitle className="xus-etitle">{item.title}</EventTitle>
                  {past && <span className="xus-badge">{t("admin.eventPastBadge")}</span>}
                  {cancelled && <span className="xus-badge xus-badge--off">{t("admin.eventCancelledBadge")}</span>}
                </div>
                <p className="xus-eline">
                  {item.startsLabel} · {item.location}
                </p>
                <p className="xus-event-scope-label">{eventScopeLabel(item, t)}</p>
                {cancelled && item.cancelledReason && (
                  <p className="xus-eline">{t("mevents.cancelledReason", { reason: item.cancelledReason })}</p>
                )}
                {item.agenda && (
                  <div className="xus-event-agenda">
                    <p className="xus-eline"><strong>{t("admin.eventAgenda")}</strong></p>
                    <p className="xus-eline xus-event-agenda__text">{item.agenda}</p>
                  </div>
                )}
                {item.minutes?.length > 0 && (
                  <p className="xus-eline">
                    {t("admin.eventMinutesAttached", { titles: item.minutes.map((record) => record.title).join(", ") })}
                  </p>
                )}
              </div>
              <details className="xus-action-menu">
                <Button as="summary" variant="secondary" size="small" className="xus-btn">{t("admin.manageEvent")}</Button>
                <div className="xus-btnrow">
                {!cancelled && (
                  <button
                    type="button"
                    className="xus-btn"
                    onClick={(event) => {
                      closeActionMenu(event);
                      const next = editingId === item.id ? null : item.id;
                      closeAll();
                      setEditingId(next);
                      if (next) {
                        // Prefilled from the row rather than blanked: the edit
                        // form used to open with an empty start time, showing
                        // the operator nothing where the event's actual time
                        // belongs. startsAtOriginal is kept alongside it so
                        // submitEdit can tell a real reschedule from an
                        // untouched field.
                        const startsAt = toLocalInput(item.startsAt);
                        setForm({
                          id: item.id,
                          title: item.title,
                          startsAt,
                          startsAtOriginal: startsAt,
                          startsAtStored: item.startsAt,
                          endsAt: toLocalInput(item.endsAt), endsAtOriginal: toLocalInput(item.endsAt), endsAtStored: item.endsAt,
                          eventKind: item.eventKind ?? "meeting", eventKindOriginal: item.eventKind ?? "meeting",
                          eventDate: item.eventDate ?? "", eventDateOriginal: item.eventDate ?? "",
                          location: item.location,
                          summary: item.summary,
                          checkInCode: item.checkInCode || "",
                          checkInCodeOriginal: item.checkInCode || "",
                          isPublic: Boolean(item.isPublic),
                          isPublicOriginal: Boolean(item.isPublic),
                          isPublicAcrossAgencies: Boolean(item.isPublicAcrossAgencies),
                          isPublicAcrossAgenciesOriginal: Boolean(item.isPublicAcrossAgencies),
                          rsvpOpen: item.rsvpOpen !== false,
                          rsvpOpenOriginal: item.rsvpOpen !== false,
                          version: Number.isInteger(item.version) ? item.version : null,
                        });
                      }
                    }}
                  >
                    {t("admin.editEvent")}
                  </button>
                )}
                {api.setEventAgenda && (
                  <button
                    type="button"
                    className="xus-btn"
                    onClick={(event) => {
                      closeActionMenu(event);
                      const next = agendaId === item.id ? null : item.id;
                      closeAll();
                      setAgendaId(next);
                      if (next) setAgendaDraft(item.agenda || "");
                      setAgendaVersion(next && Number.isInteger(item.version) ? item.version : null);
                    }}
                  >
                    {t(item.agenda ? "admin.editEventAgenda" : "admin.addEventAgenda")}
                  </button>
                )}
                {cancelled
                  ? (
                    <BusyButton type="button" className="xus-btn" pending={busy} onClick={(event) => { closeActionMenu(event); submitRestore(item.id); }}>
                      {t("admin.restoreEvent")}
                    </BusyButton>
                  )
                  : (
                    <button type="button" className="xus-btn" onClick={(event) => { closeActionMenu(event); const next = cancellingId === item.id ? null : item.id; closeAll(); setCancellingId(next); }}>
                      {t("admin.cancelEvent")}
                    </button>
                  )}
                <button type="button" className="xus-btn xus-btn--danger" onClick={(event) => { closeActionMenu(event); const next = deletingId === item.id ? null : item.id; closeAll(); setDeletingId(next); }}>
                  {t("admin.deleteEvent")}
                </button>
                </div>
              </details>
            </div>
            {/* Attendance, the door and follow-up each under their own name;
                "Manage event" above changes the event itself. */}
            <div className="xus-event-sections">
              <section className="xus-event-section" aria-label={t("admin.eventAttendanceTitle")}>
                <p className="xus-event-section__title" aria-hidden="true">{t("admin.eventAttendanceTitle")}</p>
                <p className="xus-eline">
                  {item.rsvpOpen === false ? t("admin.eventRsvpClosed") : t("admin.rsvps", { count: item.rsvpCount ?? 0 })} · {t("admin.checkins", { count: item.checkinCount ?? 0 })}
                </p>
                <QuorumLine className="xus-eline" status={quorum.byId.get(item.id)} />
                {typeof api?.setEventQuorum === "function" && !cancelled && (item.eventKind ?? "meeting") === "meeting" && (
                  <QuorumEditor event={item} quorum={quorum.byId.get(item.id)?.quorum ?? null} onSave={saveQuorum} pending={busy} />
                )}
                {item.checkinLockouts24h > 0 && (
                  <p className="xus-eline" role="status">{t("admin.checkinLockouts", { count: item.checkinLockouts24h })}</p>
                )}
              </section>
              <section className="xus-event-section" aria-label={t("admin.eventDoorTitle")}>
                <p className="xus-event-section__title" aria-hidden="true">{t("admin.eventDoorTitle")}</p>
                {item.checkInCode
                  ? (
                    <p className="xus-eline xus-event-door">
                      <span>{t("admin.eventDoorCode")}</span>{" "}
                      <code className="xus-code">{item.checkInCode}</code>
                      {!cancelled && (
                        <button type="button" className="xus-btn" onClick={(event) => { doorTriggerRef.current = event.currentTarget; setDoorEventId(item.id); }}>
                          {t("admin.showDoorDisplay")}
                        </button>
                      )}
                    </p>
                  )
                  : <p className="xus-eline">{t("admin.eventNoCheckIn")}</p>}
              </section>
              {renderConnectedActions && <section className="xus-event-section" aria-label={t("admin.eventFollowUpTitle")}>
                <p className="xus-event-section__title" aria-hidden="true">{t("admin.eventFollowUpTitle")}</p>
                {renderConnectedActions(item)}
              </section>}
            </div>
            {editingId === item.id && (
              <EventForm mode="edit" form={form} setForm={setForm} onSubmit={submitEdit} onCancel={closeAll} busy={busy} chapterName={item.chapterName || chapterName} t={t} rsvpSwitch={rsvpSwitch} />
            )}
            {agendaId === item.id && (
              <form className="xus-cardbody" onSubmit={submitAgenda}>
                <label className="xus-field">
                  {t("admin.eventAgenda")}
                  <textarea
                    className="xus-input"
                    rows={6}
                    maxLength={4000}
                    ref={agendaFieldRef}
                    value={agendaDraft}
                    onChange={(e) => setAgendaDraft(e.target.value)}
                  />
                </label>
                <AgendaItemsBuilder key={agendaId} t={t} pending={busy} agenda={agendaDraft} onAppend={setAgendaDraft} agendaFieldRef={agendaFieldRef} />
                <p className="xus-eline">{t("admin.eventAgendaHelp")}</p>
                <div className="xus-btnrow">
                  <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>
                    {t("admin.eventAgendaSubmit")}
                  </BusyButton>
                  <button type="button" className="xus-btn" onClick={closeAll}>{t("admin.eventAgendaDismiss")}</button>
                </div>
              </form>
            )}
            {cancellingId === item.id && (
              <div className="xus-cardbody">
                <label className="xus-field">
                  {t("admin.eventCancelReason")}
                  <input className="xus-input" value={cancelReason} maxLength={300} onChange={(e) => setCancelReason(e.target.value)} />
                </label>
                <div className="xus-btnrow">
                  <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy} onClick={() => submitCancel(item.id)}>
                    {t("admin.eventCancelSubmit")}
                  </BusyButton>
                  <button type="button" className="xus-btn" onClick={closeAll}>{t("admin.eventCancelDismiss")}</button>
                </div>
              </div>
            )}
            {deletingId === item.id && (
              <div className="xus-cardbody">
                <p className="xus-eline">{t("admin.eventDeleteConfirm")}</p>
                <div className="xus-btnrow">
                  <BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy} onClick={() => submitDelete(item.id)}>
                    {t("admin.eventDeleteSubmit")}
                  </BusyButton>
                  <button type="button" className="xus-btn" onClick={closeAll}>{t("admin.eventDeleteDismiss")}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {(group === "upcoming" || pastOpen) && paged.total > EVENT_PAGE_SIZE && (
        <Pager total={paged.total} page={paged.page} pageSize={EVENT_PAGE_SIZE} onPageChange={paged.setPage}
          labels={{ navigation: t(group === "past" ? "admin.eventsPastTitle" : "admin.eventsUpcomingTitle") }} />
      )}
      </div>
      </div>)}
      {(() => {
        const doorEvent = doorEventId ? rows.find((item) => item.id === doorEventId && item.checkInCode) : null;
        return doorEvent ? <DoorDisplay event={doorEvent} onClose={closeDoorDisplay} t={t} /> : null;
      })()}
    </article>
  );
}

// The screen at the door: the event's name, when, and its check-in code in
// large type, with nothing about any member (finding 40). One control, so
// focus stays on it; Escape closes it like the button.
function DoorDisplay({ event, onClose, t }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (keyEvent) => {
      if (keyEvent.key === "Escape") onClose();
      if (keyEvent.key === "Tab") { keyEvent.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="xus-door-display" role="dialog" aria-modal="true" aria-label={t("admin.doorDisplayLabel", { title: event.title })}>
      <p className="xus-door-display__title">{event.title}</p>
      {event.startsLabel && <p className="xus-door-display__when">{event.startsLabel}</p>}
      <p className="xus-door-display__code">{event.checkInCode}</p>
      <p className="xus-door-display__help">{t("admin.doorDisplayHelp")}</p>
      <button ref={closeRef} type="button" className="xus-btn" onClick={onClose}>{t("admin.doorDisplayClose")}</button>
    </div>
  );
}

// <input type="datetime-local"> wants a bare local "YYYY-MM-DDTHH:mm" with no
// zone suffix. Building it from the parts rather than slicing toISOString()
// matters: toISOString is UTC, so slicing it would show an operator east or
// west of UTC the wrong wall-clock time and quietly reschedule the event when
// they saved.
function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
