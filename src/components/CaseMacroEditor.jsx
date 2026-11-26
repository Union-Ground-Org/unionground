import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { isCaseworkMacroAudienceRefusal } from "../lib/caseworkApi.js";
import { rpcErrorTextStrict } from "../lib/rpcErrorText.js";
import "../lib/i18n/features/caseNotesStrings.js";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";

// The coordinator-side editor for organization macros. A macro is an ordered
// list of the actions a coordinator already performs one case at a time; the
// server re-runs each one through its own audited routine, so this screen only
// has to describe them accurately.
//
// The action kinds and their bounds mirror
// private.casework_macro_actions_valid exactly. Where they would drift, the
// server refuses the save with 22023 and the message lands in the error line
// rather than a silently truncated macro. The server's advance_step kind is not
// offered: Union Ground issues have no grievance procedure (owner decision,
// 2026-10-13).
const ACTION_KINDS = ["set_status", "assign", "add_note", "add_alert"];
const ALERT_KINDS = ["deadline", "safety", "retaliation", "legal", "stalled", "custom"];
const SEVERITIES = ["info", "warning", "critical"];
const MAX_ACTIONS = 10;
// public.get_staff_roster() ends in `limit 200` across ALL staff roles
// (supabase/migrations/20260822010000_mi1_organization_scope_foundation.sql:4433),
// ordered by full_name. This screen filters that page per role, so a full page
// means the menus are a slice of the organization and the "nobody holds that
// role" sentence would be a claim the read cannot support. The real repair is
// the organization-scoped, filterable candidate RPC the c7 record reserved;
// until it exists the truncation is stated rather than hidden.
const STAFF_PAGE_LIMIT = 200;

// A macro is organization property, so its assignees come from the
// organization-scoped staff read (public.get_staff_roster) rather than from
// public.list_member_case_assignment_candidates, which needs a case id this
// screen does not have. Both reads name the person and list the roles they
// hold, so one shape serves either source.
function staffWithRole(rows, role) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      userId: String(row?.userId ?? row?.user_id ?? "").trim(),
      fullName: String(row?.fullName ?? row?.full_name ?? "").trim(),
      roles: Array.isArray(row?.roles) ? row.roles.map((entry) => String(entry)) : [],
    }))
    .filter((person) => {
      if (!person.userId || !person.fullName || !person.roles.includes(role)) return false;
      if (seen.has(person.userId)) return false;
      seen.add(person.userId);
      return true;
    })
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function blankAction(kind) {
  if (kind === "set_status") return { kind, status: "resolved" };
  if (kind === "assign") return { kind, stewardId: "", coordinatorId: "" };
  if (kind === "add_note") return { kind, body: "" };
  return { kind, alertKind: "deadline", severity: "warning", message: "" };
}

// Empty strings are dropped rather than sent: assign validates that at least
// one of the two ids is present, and "" is not absent.
function cleanAction(action) {
  const entry = { kind: action.kind };
  for (const [key, value] of Object.entries(action)) {
    if (key === "kind") continue;
    const text = typeof value === "string" ? value.trim() : value;
    if (text) entry[key] = text;
  }
  return entry;
}

// A restore only ever reclaims focus the transition itself dropped. When a
// transition unmounts the focused control the browser drops focus on <body>,
// so a live element elsewhere means the coordinator moved on themselves and
// the editor has no business pulling them back.
function focusWasDropped() {
  const active = document.activeElement;
  return !active || active === document.body || !document.contains(active);
}

export function CaseMacroEditor({ api, chapterId = null, onNotice = () => {} }) {
  const { t } = useLang();
  // List-read state is its own discriminator so a refused read cannot satisfy
  // the empty-organization sentence, and a save refusal cannot grow a retry
  // that re-runs the list. `failure` stays the save path only.
  const [macros, setMacros] = useState({ state: "idle", rows: [] });
  // The save failure line is stored as a descriptor -- a catalogue key plus,
  // for a server refusal, the error itself -- and translated during render.
  // Storing the resolved sentence would freeze it in the language that was
  // current when the request was made, so a language switch while a save is in
  // flight left one stale sentence beside a re-rendered screen.
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const draftOwner = useRef(0);
  // An organization-scoped read backs the assignee pickers. It carries its
  // own state so a screen that cannot read it says so, instead of offering an
  // empty menu that looks like an empty organization.
  const [staff, setStaff] = useState({ state: "idle", rows: [] });
  // One stable prefix per mounted editor; each hint id is derived from it so a
  // select can name the sentence that explains it.
  const hintPrefix = useId();
  // Every transition on this screen unmounts the control that was activated:
  // the list and the New button are gated on !draft, the form on draft, and a
  // Remove-action button sits inside the row it deletes. Focus is handed on
  // deliberately instead of being left to fall to <body>.
  const sectionRef = useRef(null);
  const nameInputRef = useRef(null);
  // What opened the draft, as an identity rather than an element: the control
  // itself is gone by the time the draft closes, and the list re-renders a new
  // node for the same macro.
  const returnFocusRef = useRef(null);
  // The row index a removal leaves behind, resolved after the re-render that
  // the removal itself causes.
  const removeFocusRef = useRef(null);

  const load = useCallback(async () => {
    if (!api?.listMacros) return;
    setMacros({ state: "loading", rows: [] });
    try { setMacros({ state: "ready", rows: await api.listMacros() }); }
    catch { setMacros({ state: "failed", rows: [] }); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // The pickers are only needed once a draft is open, and a desk that reads
  // them successfully reads them once; a failed read is retried on the next
  // draft so a transient refusal is not permanent for the session.
  const loadPickers = useCallback(async () => {
    if (staff.state === "ready") return;
    setStaff({ state: "loading", rows: [] });
    if (!api?.loadStaffCandidates) { setStaff({ state: "failed", rows: [] }); return; }
    try { setStaff({ state: "ready", rows: await api.loadStaffCandidates() }); }
    catch { setStaff({ state: "failed", rows: [] }); }
  }, [api, staff.state]);

  const stewards = useMemo(() => staffWithRole(staff.rows, "steward"), [staff.rows]);
  const coordinators = useMemo(() => staffWithRole(staff.rows, "coordinator"), [staff.rows]);

  // A full page is the server cap, not the organization: say so, and never
  // print "nobody holds that role" over a page that was cut short.
  const staffTruncated = staff.state === "ready" && (staff.rows?.length ?? 0) >= STAFF_PAGE_LIMIT;

  // Why a picker is empty, in the picker's own words. An empty menu with no
  // sentence beside it is the failure this record was opened for.
  const staffNotice = (people) => {
    if (staff.state === "loading" || staff.state === "idle") return t("caseMacros.pickersLoading");
    if (staff.state === "failed") return t("caseMacros.staffUnavailable");
    if (staffTruncated) return t("caseMacros.staffTruncated", { count: STAFF_PAGE_LIMIT });
    return people.length ? "" : t("caseMacros.staffEmpty");
  };

  const edit = (macro) => {
    draftOwner.current += 1;
    setFailure(null);
    returnFocusRef.current = { macroId: macro ? macro.id : null };
    // An older saved macro may still carry an advance_step action.
    // Union Ground issues have no grievance steps, so the editor drops it
    // from the draft and says so, rather than quietly saving it back.
    const kept = macro ? macro.actions.filter((action) => ACTION_KINDS.includes(action.kind)) : [];
    setDraft(macro
      ? { id: macro.id, name: macro.name, chapterId: macro.chapterId || "", active: macro.active, actions: kept.map((action) => ({ ...action })), droppedSteps: macro.actions.length - kept.length }
      : { id: null, name: "", chapterId: chapterId || "", active: true, actions: [blankAction("set_status")], droppedSteps: 0 });
    void loadPickers();
  };

  const patch = (index, changes) => setDraft((current) => ({
    ...current,
    actions: current.actions.map((action, position) => (position === index ? { ...action, ...changes } : action)),
  }));
  // A new kind starts from that kind's blank action: merging would carry the
  // old kind's fields (a set_status "resolved") into an assign, note or alert.
  const replace = (index, action) => setDraft((current) => ({
    ...current,
    actions: current.actions.map((existing, position) => (position === index ? action : existing)),
  }));

  // An assign action's two menus are both optional to the browser and not
  // both optional to private.casework_macro_actions_valid, so the editor
  // checks that at least one is chosen.
  const incompleteAction = (actions) => (actions || []).find((action) => {
    const value = (field) => String(action[field] ?? "").trim();
    if (action.kind === "assign") return !value("stewardId") && !value("coordinatorId");
    return false;
  });

  const save = async (event) => {
    event.preventDefault();
    if (busy || !draft) return;
    const incomplete = incompleteAction(draft.actions);
    if (incomplete) {
      // Neither assign menu is required — the server's rule is "at least one
      // of the two" — so this is the only refusal a coordinator can meet on a
      // healthy plane.
      setFailure({
        key: staff.state === "failed"
          ? "caseMacros.staffUnavailable"
          : (stewards.length || coordinators.length ? "caseMacros.assigneeRequired" : "caseMacros.staffEmpty"),
      });
      return;
    }
    setBusy(true); setFailure(null);
    const owner = draftOwner.current;
    try {
      await api.saveMacro({
        id: draft.id,
        chapterId: draft.chapterId || null,
        name: draft.name.trim(),
        actions: draft.actions.map(cleanAction),
        active: draft.active,
      });
      // Fields stay editable during the request. Close only the exact draft
      // that was submitted; a later edit or replacement has not been saved.
      setDraft((current) => current === draft ? null : current);
      await load();
      if (owner === draftOwner.current) onNotice(t("caseMacros.saved"));
    } catch (cause) {
      if (owner !== draftOwner.current) return;
      // The audience refusal is the one save failure the author cannot read as
      // a typo: the server is saying the macro would have been invisible to
      // them. It gets translated copy that names the missing role. Every other
      // refusal shows the generic catalogue sentence: the raw server text is
      // untranslated English policy or constraint wording.
      setFailure(isCaseworkMacroAudienceRefusal(cause)
        ? { key: "caseMacros.audienceRefused" }
        : { key: "caseMacros.saveFailed", error: cause });
    } finally { setBusy(false); }
  };

  // Opening a draft moves the caret into the name field; closing one hands it
  // back to the control that opened the draft, which the list has re-rendered
  // as a new node by the time this runs.
  const draftOpen = draft !== null;
  useLayoutEffect(() => {
    const root = sectionRef.current;
    if (draftOpen) {
      if (focusWasDropped()) nameInputRef.current?.focus();
      return;
    }
    const opener = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!opener || !root || !focusWasDropped()) return;
    const back = opener.macroId === null
      ? null
      : [...root.querySelectorAll("[data-macro-edit]")].find((button) => button.dataset.macroEdit === opener.macroId);
    (back || root.querySelector(".case-macros__new"))?.focus();
  }, [draftOpen]);

  // Removing an action unmounts its row. The surviving target is resolved
  // here rather than in the click handler because the control that receives
  // focus may be one the removal itself brings back: at the ten-action
  // ceiling the Add-action button does not exist until the row is gone.
  const actionCount = draft?.actions.length ?? 0;
  useLayoutEffect(() => {
    const pending = removeFocusRef.current;
    removeFocusRef.current = null;
    const root = sectionRef.current;
    if (!pending || !root || !focusWasDropped()) return;
    const drops = [...root.querySelectorAll(".case-macros__drop")];
    const target = (pending.index === null ? null : drops[pending.index])
      || root.querySelector(".case-macros__add")
      || nameInputRef.current;
    target?.focus();
  }, [actionCount]);

  if (!api?.listMacros) return null;
  const failureText = failure
    ? rpcErrorTextStrict(t, failure.error, t(failure.key))
    : "";
  return (
    <section ref={sectionRef} className="cwk-panel case-macros" aria-label={t("coordinator.macrosTitle")} data-reactive-depth="panel">
      <header className="cwk-panel__head">
        <WorkspaceCardTitle>{t("coordinator.macrosTitle")}</WorkspaceCardTitle>
        <p>{t("caseMacros.help")}</p>
      </header>
      {macros.state === "failed" && (
        <>
          <p className="cwk-panel__error" role="alert">{t("caseMacros.loadFailed")}</p>
          <button className="cwk-btn cwk-btn--soft" type="button" onClick={load}>{t("app.tryAgain")}</button>
        </>
      )}
      {failureText && <p className="cwk-panel__error" role="alert">{failureText}</p>}

      {macros.state === "loading" && <p role="status">{t("caseMacros.loading")}</p>}
      {macros.state === "ready" && macros.rows.length === 0 && !draft && <p className="cwk-panel__empty">{t("caseMacros.empty")}</p>}

      {macros.state === "ready" && !draft && (
        <ul className="case-macros__list">
          {macros.rows.map((macro) => (
            <li key={macro.id}>
              <div>
                <b>{macro.name}</b>
                <small>{macro.chapterId ? t("caseMacros.chapterScoped") : t("caseMacros.organizationScoped")}</small>
                <small>{t("caseBulk.macroActionCount", { count: macro.actions.length })}</small>
                {!macro.active && <small className="case-macros__off">{t("caseMacros.inactive")}</small>}
              </div>
              <button type="button" data-macro-edit={macro.id} onClick={() => edit(macro)}>{t("caseMacros.edit")}</button>
            </li>
          ))}
        </ul>
      )}

      {!draft && <button type="button" className="case-macros__new" onClick={() => edit(null)}>{t("caseMacros.new")}</button>}

      {draft && (
        <form className="case-macros__form" onSubmit={save}>
          <label>{t("caseMacros.name")}
            <input ref={nameInputRef} value={draft.name} maxLength={120} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="case-macros__active">
            <input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
            {t("caseMacros.activeLabel")}
          </label>

          {draft.droppedSteps > 0 && <p className="case-macros__hint" role="status">{t("caseMacros.legacyStepRemoved", { count: draft.droppedSteps })}</p>}
          <ol className="case-macros__actions">
            {draft.actions.map((action, index) => (
              <li key={index}>
                <label>{t("caseMacros.actionKind")}
                  <select value={action.kind} onChange={(event) => replace(index, blankAction(event.target.value))}>
                    {ACTION_KINDS.map((kind) => <option key={kind} value={kind}>{t(`caseMacros.kind.${kind}`)}</option>)}
                  </select>
                </label>
                {action.kind === "set_status" && (
                  <label>{t("caseBulk.nextStatus")}
                    <select value={action.status} onChange={(event) => patch(index, { status: event.target.value })}>
                      <option value="active">{t("coordinator.statusActive")}</option>
                      <option value="resolved">{t("coordinator.statusResolved")}</option>
                    </select>
                  </label>
                )}
                {action.kind === "assign" && (<>
                  {/* Both fields are pickers over the organization's staff: a
                      pasted uuid was refused with 23514 on every case in the
                      batch, at apply time, long after the macro was saved. */}
                  <label>{t("caseMacros.stewardId")}
                    <select value={action.stewardId} disabled={!stewards.length && !action.stewardId}
                      aria-describedby={[staffNotice(stewards) ? `${hintPrefix}-steward-${index}` : null, `${hintPrefix}-assign-${index}`].filter(Boolean).join(" ")}
                      onChange={(event) => patch(index, { stewardId: event.target.value })}>
                      <option value="">{t("caseMacros.assigneeClear")}</option>
                      {action.stewardId && !stewards.some((person) => person.userId === action.stewardId) && (
                        <option value={action.stewardId}>
                          {staff.state === "ready" ? t("caseMacros.staleAssignee") : t("caseMacros.pickersLoading")}
                        </option>
                      )}
                      {stewards.map((person) => <option key={person.userId} value={person.userId}>{person.fullName}</option>)}
                    </select>
                  </label>
                  {staffNotice(stewards) && <p id={`${hintPrefix}-steward-${index}`} className="case-macros__hint">{staffNotice(stewards)}</p>}
                  <label>{t("caseMacros.coordinatorId")}
                    <select value={action.coordinatorId} disabled={!coordinators.length && !action.coordinatorId}
                      aria-describedby={[staffNotice(coordinators) ? `${hintPrefix}-coordinator-${index}` : null, `${hintPrefix}-assign-${index}`].filter(Boolean).join(" ")}
                      onChange={(event) => patch(index, { coordinatorId: event.target.value })}>
                      <option value="">{t("caseMacros.assigneeClear")}</option>
                      {action.coordinatorId && !coordinators.some((person) => person.userId === action.coordinatorId) && (
                        <option value={action.coordinatorId}>
                          {staff.state === "ready" ? t("caseMacros.staleAssignee") : t("caseMacros.pickersLoading")}
                        </option>
                      )}
                      {coordinators.map((person) => <option key={person.userId} value={person.userId}>{person.fullName}</option>)}
                    </select>
                  </label>
                  {staffNotice(coordinators) && <p id={`${hintPrefix}-coordinator-${index}`} className="case-macros__hint">{staffNotice(coordinators)}</p>}
                  <p id={`${hintPrefix}-assign-${index}`} className="case-macros__hint">{t("caseMacros.assignHint")}</p>
                </>)}
                {action.kind === "add_note" && (
                  <label>{t("caseNotes.staffNoteLabel")}<textarea value={action.body} maxLength={4000} required onChange={(event) => patch(index, { body: event.target.value })} /></label>
                )}
                {action.kind === "add_alert" && (<>
                  <label>{t("caseMacros.alertKind")}
                    <select value={action.alertKind} onChange={(event) => patch(index, { alertKind: event.target.value })}>
                      {ALERT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`caseMacros.alert.${kind}`)}</option>)}
                    </select>
                  </label>
                  <label>{t("caseMacros.severity")}
                    <select value={action.severity} onChange={(event) => patch(index, { severity: event.target.value })}>
                      {SEVERITIES.map((level) => <option key={level} value={level}>{t(`caseMacros.severity.${level}`)}</option>)}
                    </select>
                  </label>
                  <label>{t("caseMacros.alertMessage")}<textarea value={action.message} minLength={3} maxLength={1000} required onChange={(event) => patch(index, { message: event.target.value })} /></label>
                </>)}
                {draft.actions.length > 1 && (
                  <button type="button" className="case-macros__drop" onClick={() => {
                    // The row that takes this one's place still carries a
                    // Remove button while two actions remain; below that the
                    // Add-action control is the nearest survivor.
                    const remaining = draft.actions.length - 1;
                    removeFocusRef.current = { index: remaining > 1 ? Math.min(index, remaining - 1) : null };
                    setDraft({ ...draft, actions: draft.actions.filter((_, position) => position !== index) });
                  }}>
                    {t("caseMacros.removeAction")}
                  </button>
                )}
              </li>
            ))}
          </ol>

          {draft.actions.length < MAX_ACTIONS && (
            <button type="button" className="case-macros__add" onClick={() => setDraft({ ...draft, actions: [...draft.actions, blankAction("add_note")] })}>
              {t("caseMacros.addAction")}
            </button>
          )}
          <div className="case-macros__submit">
            <button type="submit" disabled={busy}>{busy ? t("coordinator.saving") : t("caseMacros.save")}</button>
            <button type="button" onClick={() => { draftOwner.current += 1; setDraft(null); setFailure(null); }}>{t("caseMacros.cancel")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
