import { BusyButton } from "./BusyControls.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runBusyWrite } from "../lib/busyWrite.js";
import {
  SELECTION_LIMIT, clearSelection, clearVisible, isSelected, pruneSelection,
  selectVisible, selectedRows, selectionState, sharedStatus, toggleSelection,
} from "../lib/caseSelection.js";
import { CASE_EXPORT_COLUMNS, CASE_EXPORT_LIMIT, downloadCaseCsv } from "../lib/caseExport.js";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";
import { captureSanitizedDiagnostic } from "../lib/observability.js";
import { ASSIGN_LEAVE_UNCHANGED } from "../lib/memberApi.js";
import "../lib/i18n/features/caseNotesStrings.js";

// The bulk Assign panel's three-state contract
// (BUG-UG-CASE-BULK-ASSIGN-CLEARS-UNTOUCHED-ROLE-20260920). The default
// option ("" — the coordinator never named this role) must leave every
// selected case's current holder in place; ASSIGN_CLEAR is the one explicit
// way to unassign. Mapping the blank straight to null used to clear the
// untouched role on every selected case.
const ASSIGN_LEAVE = "";
const ASSIGN_CLEAR = "__clear__";

// The multi-select bar the coordinator queue and the steward caseload share.
// It owns no list: the host passes the rows it is already rendering and the
// ids currently visible, so the bar works over a card list today and over
// lane 5.2's virtualized rows unchanged.
//
// Every action goes through an existing audited routine. Status is one
// casework_bulk_update_cases call. Assignments and notes loop their per-case
// routines and report each case separately rather than pretending the loop
// was atomic. There is no step advance: Union Ground issues have no
// grievance procedure (owner decision, 2026-10-13).

// One roster read per selected case would open the Assign panel with up to
// SELECTION_LIMIT parallel RPCs, so the reads run a few at a time instead.
const ROSTER_READ_CONCURRENCY = 6;

// list_member_case_assignment_candidates caps each case's roster at this many
// rows (supabase/migrations/20260810210000_case_assignment_screen.sql). A
// roster that comes back AT the cap may be a truncated page: a person past
// the cut in one case's page is then indistinguishable from a person that
// case would refuse, and the cross-case intersection must never treat that
// omission as ineligibility.
const CANDIDATE_PAGE_LIMIT = 200;

async function mapBounded(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const lane = async () => {
    for (let index = cursor++; index < items.length; index = cursor++) out[index] = await worker(items[index]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

// Every caught write failure leaves through here, so there is one answer to
// "what does the coordinator read" and one answer to "what does the operator
// learn", and they are not the same answer.
//
// The coordinator reads a catalogue sentence. Every routine behind this bar
// raises a MemberApiError, whose message is composed as "<English label>:
// <driver text>" (src/lib/memberApi.js), so printing `cause.message` painted
// an internal routine name and a Postgres sentence into the ledger no matter
// what language the desk was in. rpcRefusalKey cannot return that message.
//
// The operator learns the class and the code through the same privacy-filtered
// sink the coordination adapter uses. Not console.error: the driver sentence
// can quote the row that failed the CHECK, and a coordinator's console is not
// a place to put case content.
function refusalText(t, cause, resource, fallbackKey) {
  captureSanitizedDiagnostic({
    kind: "case_bulk_action_failure",
    resource,
    code: cause?.code,
    name: cause?.name,
  });
  return t(rpcRefusalKey(cause, fallbackKey));
}

// Merges the per-case rosters into one entry per person: how many rosters
// carry them, at most once per roster so a duplicated row cannot inflate the
// count, and which roles EVERY roster that carries them agrees on. Sharing a
// user id is not enough — a chapter-scoped role from case A's roster must not
// be offered for case B whose roster only carries another role, or
// assign_member_case refuses that write per case with 23514 after the batch
// has partly landed.
function mergeRosterPeople(perCase) {
  const people = new Map();
  for (const roster of perCase) {
    const seen = new Set();
    for (const person of roster || []) {
      const userId = person?.userId;
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      const entry = people.get(userId)
        ?? { userId, fullName: person?.fullName ?? "", count: 0, roles: null };
      entry.count += 1;
      const roles = Array.isArray(person?.roles) ? person.roles : [];
      entry.roles = entry.roles === null
        ? [...roles]
        : entry.roles.filter((role) => roles.includes(role));
      people.set(userId, entry);
    }
  }
  return people;
}

export function CaseSelectBox({ id, label, selection, onSelectionChange, disabled = false }) {
  const checked = isSelected(selection, id);
  const atLimit = selection.length >= SELECTION_LIMIT;
  return (
    <label className="case-select" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        // The cap refuses the tick rather than silently dropping somebody
        // else's, so the coordinator sees which box would not go on.
        disabled={disabled || (!checked && atLimit)}
        aria-label={label}
        onChange={() => onSelectionChange(toggleSelection(selection, id))}
        onClick={(event) => event.stopPropagation()}
      />
    </label>
  );
}

function ResultLedger({ results, t }) {
  if (!results) return null;
  const failed = results.filter((entry) => entry.error);
  const done = results.length - failed.length;
  return (
    <div className="case-bulk__results" role="status" aria-live="polite">
      <p>{t("caseBulk.resultSummary", { done, total: results.length })}</p>
      {failed.length > 0 && (
        <ul className="case-bulk__failures">
          {failed.map((entry) => <li key={entry.id}><b>{entry.label}</b> — {entry.error}</li>)}
        </ul>
      )}
    </div>
  );
}

export function CaseBulkActions({
  rows = [],
  visibleIds = null,
  selection = [],
  onSelectionChange,
  api = null,
  t,
  onDone = async () => {},
  exportPrefix = "cases",
  // The facet NAMES the host list is currently filtering by — never the facet
  // values. A visible-slice export is the slice those facets left on screen, so
  // the receipt names them; the values stay in the browser.
  exportFilterKeys = null,
  canWrite = true,
}) {
  const [panel, setPanel] = useState("");
  const busyWriteRef = useRef(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);
  const [macros, setMacros] = useState(null);
  const [assignSteward, setAssignSteward] = useState(ASSIGN_LEAVE);
  const [assignCoordinator, setAssignCoordinator] = useState(ASSIGN_LEAVE);
  const [candidates, setCandidates] = useState([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // A failed or possibly-truncated roster load keeps the Assign form
  // unsubmittable: with no trustworthy roster the selects would only offer
  // "Unassigned", and confirming that sends { stewardId: null, coordinatorId:
  // null } for every selected case, clearing assignments that were never in
  // view. The panel stays open with the error so closing and reopening (or a
  // narrower selection) retries the load.
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [exported, setExported] = useState("");
  const [applied, setApplied] = useState("");
  // casework_apply_macro keys its replay guard on the batch id the client
  // sends. Minting a fresh uuid on every click would make the guard
  // unreachable, so the same macro over the same selection keeps one key until
  // it succeeds: a retry after a dropped response replays nothing.
  const macroBatch = useRef({ signature: "", key: "" });
  // Roster loads are async over the selection that was current
  // when the panel opened. A slower response for an abandoned selection must
  // not land on the new one, so every load bumps a generation and only the
  // newest generation may write.
  const loadGeneration = useRef(0);
  // A fully successful run writes its result ledger and then clears the
  // selection in the same commit. The selection-change effect below must not
  // wipe that ledger: it is the product of the operation that caused the
  // change, not stale picker state. Set at write time, consumed (and reset)
  // by the next effect run.
  const preserveLedger = useRef(false);

  const visible = useMemo(
    () => (visibleIds || rows.map((row) => row?.id)).filter(Boolean),
    [visibleIds, rows],
  );
  const state = selectionState(selection, visible);
  const chosen = useMemo(() => selectedRows(rows, selection), [rows, selection]);
  const batchStatus = sharedStatus(chosen);
  // The roster is computed for exactly one selection. When this identity
  // changes, nothing loaded earlier may stay offered or submittable. Opening a
  // panel reloads it even when the identity is unchanged: eligibility lives
  // off the desk row.
  const selectionKey = useMemo(
    () => chosen.map((row) => row?.id).filter(Boolean).sort().join("\u0000"),
    [chosen],
  );

  // Rows retire under the selection when a filter changes or a case resolves.
  // Pruning against the rows in hand stops the bar from submitting an id the
  // viewer can no longer see.
  const availableIds = useMemo(() => rows.map((row) => row?.id).filter(Boolean), [rows]);
  useEffect(() => {
    const pruned = pruneSelection(selection, availableIds);
    if (pruned.length !== selection.length) onSelectionChange(pruned);
  }, [availableIds, selection, onSelectionChange]);

  // The selection moved: drop everything that was computed for the old one —
  // roster, results — and close the open panel, so the coordinator can
  // re-open it against the selection that is actually ticked.
  // assign_member_case re-checks chapter scope per case; leaving the previous
  // selection's roster submittable is how the 23514 "steward is
  // outside case scope or lacks role" ledger row used to happen.
  useEffect(() => {
    loadGeneration.current += 1;
    setCandidates([]);
    setCandidatesLoading(false);
    setCandidatesFailed(false);
    // A successful run's ledger survives the selection clear it caused; any
    // other selection change still wipes the picker state AND the ledger.
    if (!preserveLedger.current) setResults(null);
    preserveLedger.current = false;
    setPanel("");
  }, [selectionKey]);

  const openPanel = useCallback(async (next) => {
    const opening = panel !== next;
    setError(""); setResults(null); setExported(""); setApplied("");
    setPanel((current) => (current === next ? "" : next));
    // Gated on opening like the assign loader: the click that closes
    // the panel must not issue a read, even while the first one is pending.
    if (opening && next === "macros" && macros === null && api?.listMacros) {
      try { setMacros(await api.listMacros()); }
      catch { setMacros([]); setError(t("caseBulk.macroLoadFailed")); }
    }
    // The picker must only ever offer people every selected case accepts.
    // Eligibility is not on the desk row, so an ID-only cache stays stale
    // after a role revocation or a host refresh. Load each chosen case's
    // roster (bounded to a few reads at a time) and
    // intersect by user id on every Assign opening.
    if (opening && next === "assign" && api?.loadAssignmentCandidates && chosen.length > 0) {
      setCandidates([]);
      setCandidatesLoading(true);
      setCandidatesFailed(false);
      const generation = ++loadGeneration.current;
      try {
        const perCase = await mapBounded(chosen, ROSTER_READ_CONCURRENCY, (item) => api.loadAssignmentCandidates(item.id));
        if (generation !== loadGeneration.current) return;
        // A capped page is not a complete set. With more than one selected
        // case, intersecting a possibly-truncated roster could silently drop
        // someone every case would accept, so the load is refused outright —
        // loudly, with the cap named — instead of guessing. A single-case
        // selection keeps the dedicated case panel's behaviour: the same
        // capped RPC, with the server still validating the write.
        if (perCase.length > 1 && perCase.some((roster) => (roster || []).length >= CANDIDATE_PAGE_LIMIT)) {
          setCandidatesLoading(false);
          setCandidatesFailed(true);
          setError(t("caseBulk.candidateRosterCapped", { limit: CANDIDATE_PAGE_LIMIT }));
          return;
        }
        const people = [];
        for (const entry of mergeRosterPeople(perCase).values()) {
          if (entry.count !== perCase.length) continue;
          people.push({ userId: entry.userId, fullName: entry.fullName, roles: entry.roles ?? [] });
        }
        setCandidates(people);
        setCandidatesLoading(false);
      } catch {
        if (generation !== loadGeneration.current) return;
        setCandidatesLoading(false);
        setCandidatesFailed(true);
        setError(t("caseBulk.candidateLoadFailed"));
      }
    }
  }, [api, macros, chosen, panel, t]);

  // One request for the whole batch: casework_bulk_update_cases is the audited
  // routine for exactly this, and a mixed-status selection is refused before
  // the request rather than by a 40001 the coordinator cannot act on.
  const runBatch = async (fields) => {
    if (busy || !batchStatus) return;
    return runBusyWrite(busyWriteRef, "case-bulk", async (release) => {
      setBusy(true); setError(""); setResults(null);
      try {
        await api.bulkUpdateCases(selection, batchStatus, fields);
        setResults(selection.map((id) => ({ id, label: labelFor(rows, id) })));
        preserveLedger.current = true;
        onSelectionChange(clearSelection());
        setPanel("");
        await onDone();
      } catch (cause) {
        setError(refusalText(t, cause, "batch_status", "caseBulk.failed"));
      } finally { release(); setBusy(false); }
    });
  };

  // Assign and add-note have no batch routine. The loop is honest about that:
  // it keeps going past a failure and names every case that did not take, so a
  // partial result is legible instead of looking like a total one.
  const runPerCase = async (operation, resource) => {
    if (busy) return;
    return runBusyWrite(busyWriteRef, "case-bulk", async (release) => {
      setBusy(true); setError(""); setResults(null);
      try {
        const ledger = [];
        for (const id of selection) {
          try { await operation(id); ledger.push({ id, label: labelFor(rows, id) }); }
          catch (cause) {
            ledger.push({ id, label: labelFor(rows, id), error: refusalText(t, cause, resource, "caseBulk.failed") });
          }
        }
        setResults(ledger);
        if (ledger.length > 0 && ledger.every((entry) => !entry.error)) {
          preserveLedger.current = true;
          onSelectionChange(clearSelection());
          setPanel("");
        }
        await onDone();
      } finally {
        release();
        setBusy(false);
      }
    });
  };

  // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917. Two things the
  // export did not have: a receipt and a bound.
  //
  // The receipt is written by casework_record_case_export BEFORE the file is
  // built, and a refusal there is a refusal to download — including the case
  // where no recorder is wired at all. An export that nobody could review
  // afterwards is exactly the thing this record is about, so "unaudited" is
  // never a fallback path.
  //
  // The bound is the same number the RPC enforces, refused here first so the
  // coordinator reads a sentence that names the cap instead of a raw 22023.
  // The server keeps its own copy of both caps: the bound does not live only in
  // the browser.
  const exportRows = chosen.length > 0 ? chosen : rows;
  const exportScope = chosen.length > 0 ? "selection" : "visible";
  const exportLimit = exportScope === "selection" ? SELECTION_LIMIT : CASE_EXPORT_LIMIT;
  const runExport = async () => {
    if (busy) return;
    return runBusyWrite(busyWriteRef, "case-bulk", async (release) => {
      setResults(null); setPanel(""); setApplied(""); setExported(""); setError("");
      if (exportRows.length > exportLimit) {
        // The "tick up to N" clause names the SELECTION cap, not the cap that
        // was just exceeded: a coordinator over the 500-row visible cap is being
        // told to select, and a selection stops at 100.
        setError(t("caseBulk.exportCapped", {
          count: exportRows.length, limit: exportLimit, selectionLimit: SELECTION_LIMIT,
        }));
        return;
      }
      if (!api?.recordCaseExport) {
        setError(t("caseBulk.exportAuditUnavailable"));
        return;
      }
      // Dropping an id-less row would let the receipt's row count understate the
      // file, which is the one thing the recorded count must never do. A row the
      // desk cannot name is a refusal, not a silent omission.
      const exportIds = exportRows.map((row) => row?.id);
      if (exportIds.some((id) => !id)) {
        setError(t("caseBulk.exportAuditFailed"));
        return;
      }
      setBusy(true);
      try {
        await api.recordCaseExport(
          exportIds,
          exportScope,
          exportScope === "visible" ? (exportFilterKeys || []) : [],
        );
      } catch (cause) {
        setError(refusalText(t, cause, "export_receipt", "caseBulk.exportAuditFailed"));
        return;
      } finally { release(); setBusy(false); }
      const { filename } = downloadCaseCsv(exportRows, CASE_EXPORT_COLUMNS, t, { prefix: exportPrefix });
      setExported(filename);
    });
  };

  // The Assign panel opens on a fresh three-state contract: every role starts
  // at "leave unchanged" so nothing a previous panel run chose can leak into
  // a new selection. Clearing the batch hides the form without changing
  // `panel`, so the same reset also fires when the selection empties —
  // otherwise the next batch would remount with the previous intent still
  // live and Assign already open. Adding or shrinking cases while the panel
  // is filling does not reset (`selectionEmpty` stays false).
  const selectionEmpty = state.count === 0;
  useEffect(() => {
    if (panel === "assign" || selectionEmpty) {
      setAssignSteward(ASSIGN_LEAVE);
      setAssignCoordinator(ASSIGN_LEAVE);
    }
  }, [panel, selectionEmpty]);

  // What the submission actually writes, in user-readable form: the role
  // label alone when it clears, "Name (role)" when it names a person. This
  // feeds the pre-submit summary and the confirmation, so both can say which
  // roles are replaced on how many cases.
  const assignWrites = useMemo(() => {
    const writes = [];
    if (assignSteward === ASSIGN_CLEAR) writes.push(t("coordinator.assignmentSteward"));
    else if (assignSteward !== ASSIGN_LEAVE) {
      const person = candidates.find((candidate) => candidate.userId === assignSteward);
      writes.push(`${person?.fullName || assignSteward} (${t("coordinator.assignmentSteward")})`);
    }
    if (assignCoordinator === ASSIGN_CLEAR) writes.push(t("coordinator.assignmentCoordinator"));
    else if (assignCoordinator !== ASSIGN_LEAVE) {
      const person = candidates.find((candidate) => candidate.userId === assignCoordinator);
      writes.push(`${person?.fullName || assignCoordinator} (${t("coordinator.assignmentCoordinator")})`);
    }
    return writes;
  }, [assignSteward, assignCoordinator, candidates, t]);

  const writable = canWrite && state.count > 0;
  // The roster gate only applies where the host actually loads one; a host
  // without loadAssignmentCandidates keeps the previous behaviour.
  const assignRosterLoading = Boolean(api?.loadAssignmentCandidates) && candidatesLoading;
  const assignRosterUnavailable = Boolean(api?.loadAssignmentCandidates) && candidatesFailed;
  const assignRosterGated = assignRosterLoading || assignRosterUnavailable;
  // An older saved macro may still carry an advance_step action;
  // Union Ground issues have no grievance steps, so such a macro is not
  // offered here until a coordinator re-saves it without that action.
  const activeMacros = useMemo(() => (macros || []).filter((macro) => macro.active
    && !(macro.actions || []).some((action) => action?.kind === "advance_step")), [macros]);
  return (
    <div className="case-bulk" data-reactive-depth="panel">
      {(state.visibleCount > 0 || state.count > 0) && (
        <div className="case-bulk__head">
          <label className="case-bulk__all">
            <input
              type="checkbox"
              checked={state.allVisible}
              ref={(node) => { if (node) node.indeterminate = state.someVisible; }}
              disabled={state.visibleCount === 0}
              onChange={() => onSelectionChange(state.allVisible
                ? clearVisible(selection, visible)
                : selectVisible(selection, visible))}
            />
            {t("caseBulk.selectAllVisible", { count: state.visibleCount })}
          </label>
          {state.count > 0 && <span className="case-bulk__count">{t("caseBulk.selected", { count: state.count })}</span>}
          {state.atLimit && <span className="case-bulk__limit">{t("caseBulk.limit", { limit: SELECTION_LIMIT })}</span>}
          {state.count > 0 && <button type="button" className="case-bulk__clear" onClick={() => onSelectionChange(clearSelection())}>{t("caseBulk.clear")}</button>}
          <BusyButton type="button" className="case-bulk__export" onClick={() => { void runExport(); }} pending={busy} disabled={exportRows.length === 0}>
            {t(chosen.length > 0 ? "caseBulk.exportSelected" : "caseBulk.exportVisible", { count: exportRows.length })}
          </BusyButton>
        </div>
      )}

      {exported && <p className="case-bulk__exported" role="status">{t("caseBulk.exported", { filename: exported })}</p>}

      {writable && (
        <div className="case-bulk__actions" role="group" aria-label={t("caseBulk.actionsLabel")}>
          {api?.bulkUpdateCases && <BusyButton type="button" aria-pressed={panel === "status"} pending={busy} onClick={() => openPanel("status")}>{t("caseBulk.setStatus")}</BusyButton>}
          {api?.assignCase && <BusyButton type="button" aria-pressed={panel === "assign"} pending={busy} onClick={() => openPanel("assign")}>{t("caseBulk.assign")}</BusyButton>}
          {api?.addCaseNote && <BusyButton type="button" aria-pressed={panel === "note"} pending={busy} onClick={() => openPanel("note")}>{t("caseBulk.addNote")}</BusyButton>}
          {api?.applyMacro && <BusyButton type="button" aria-pressed={panel === "macros"} pending={busy} onClick={() => openPanel("macros")}>{t("caseBulk.macros")}</BusyButton>}
        </div>
      )}

      {/* Status is the only batch update. It takes one expected status and
          refuses the whole batch on drift. */}
      {writable && panel === "status" && !batchStatus && (
        <p className="case-bulk__hint" role="alert">{t("caseBulk.mixedStatus")}</p>
      )}

      {writable && panel === "status" && batchStatus && (
        <form className="case-bulk__form" onSubmit={(event) => {
          event.preventDefault();
          void runBatch({ status: String(new FormData(event.currentTarget).get("status")) });
        }}>
          <label>{t("caseBulk.nextStatus")}
            <select name="status" defaultValue={batchStatus === "active" ? "resolved" : "active"}>
              <option value="active">{t("coordinator.statusActive")}</option>
              <option value="resolved">{t("coordinator.statusResolved")}</option>
            </select>
          </label>
          <BusyButton type="submit" pending={busy}>{busy ? t("caseBulk.working") : t("caseBulk.applyToCount", { count: state.count })}</BusyButton>
        </form>
      )}

      {/* The Assign form is withheld until every selected case's roster has
          loaded: before that the selects only offer "Unassigned", and a
          confirm there would clear both assignments on every case in the
          batch. The same gate covers a failed or possibly-truncated load —
          the error names the reason and closing/reopening retries. */}
      {writable && panel === "assign" && (
        <form className="case-bulk__form" onSubmit={(event) => {
          event.preventDefault();
          if (assignRosterGated || assignWrites.length === 0) return;
          // A role the coordinator never named travels as the server's
          // leave-unchanged sentinel; only the explicit clear option sends a
          // null.
          void runPerCase((id) => api.assignCase(id, {
            stewardId: assignSteward === ASSIGN_CLEAR ? null
              : assignSteward === ASSIGN_LEAVE ? ASSIGN_LEAVE_UNCHANGED : assignSteward,
            coordinatorId: assignCoordinator === ASSIGN_CLEAR ? null
              : assignCoordinator === ASSIGN_LEAVE ? ASSIGN_LEAVE_UNCHANGED : assignCoordinator,
          }), "assign");
        }}>
          <label>{t("coordinator.assignmentSteward")}
            <select name="steward" value={assignSteward} disabled={assignRosterGated} onChange={(event) => setAssignSteward(event.target.value)}>
              <option value={ASSIGN_LEAVE}>{t("caseBulk.assignLeaveUnchanged")}</option>
              {candidates.filter((person) => person.roles?.includes("steward")).map((person) => (
                <option key={person.userId} value={person.userId}>{person.fullName}</option>))}
              <option value={ASSIGN_CLEAR}>{t("caseBulk.assignClearRole")}</option>
            </select>
          </label>
          <label>{t("coordinator.assignmentCoordinator")}
            <select name="coordinator" value={assignCoordinator} disabled={assignRosterGated} onChange={(event) => setAssignCoordinator(event.target.value)}>
              <option value={ASSIGN_LEAVE}>{t("caseBulk.assignLeaveUnchanged")}</option>
              {candidates.filter((person) => person.roles?.includes("coordinator")).map((person) => (
                <option key={person.userId} value={person.userId}>{person.fullName}</option>))}
              <option value={ASSIGN_CLEAR}>{t("caseBulk.assignClearRole")}</option>
            </select>
          </label>
          {candidatesLoading && <p className="case-bulk__hint" role="status">{t("caseBulk.candidatesLoading")}</p>}
          {!assignRosterGated && (assignWrites.length === 0
            ? <p className="case-bulk__hint" role="status">{t("caseBulk.assignNothing")}</p>
            : <p className="case-bulk__hint">{t("caseBulk.assignSummary", { roles: assignWrites.join(", "), count: state.count })}</p>)}
          <label className="case-bulk__confirm"><input type="checkbox" required disabled={assignRosterGated || assignWrites.length === 0} />
            {t("caseBulk.assignConfirm", { roles: assignWrites.join(", "), count: state.count })}</label>
          <BusyButton type="submit" pending={busy || assignRosterLoading} disabled={assignRosterUnavailable || assignWrites.length === 0}>{busy ? t("caseBulk.working") : t("caseBulk.applyToCount", { count: state.count })}</BusyButton>
        </form>
      )}

      {writable && panel === "note" && (
        <form className="case-bulk__form" onSubmit={(event) => {
          event.preventDefault();
          const body = String(new FormData(event.currentTarget).get("note")).trim();
          void runPerCase((id) => api.addCaseNote(id, body), "note");
        }}>
          <label>{t("caseNotes.staffNoteLabel")}<textarea name="note" maxLength={4000} required /></label>
          <p className="case-bulk__hint">{t("caseBulk.noteSameBody")}</p>
          <BusyButton type="submit" pending={busy}>{busy ? t("caseBulk.working") : t("caseBulk.applyToCount", { count: state.count })}</BusyButton>
        </form>
      )}

      {writable && panel === "macros" && (
        <div className="case-bulk__form case-bulk__macros">
          {macros === null && <p className="case-bulk__hint" role="status">{t("caseBulk.macroLoading")}</p>}
          {macros?.length === 0 && <p className="case-bulk__hint" role="status">{t("caseBulk.macroEmpty")}</p>}
          {/* A macro list whose every entry is retired is not an empty list, so
              the "no macros yet" hint does not cover it. Without its own line
              the panel drew nothing at all and read as still loading. */}
          {macros?.length > 0 && activeMacros.length === 0
            && <p className="case-bulk__hint" role="status">{t("caseBulk.macroAllRetired")}</p>}
          {activeMacros.map((macro) => (
            <BusyButton key={macro.id} type="button" pending={busy} onClick={async () => {
              if (busy) return;
              return runBusyWrite(busyWriteRef, "case-bulk", async (release) => {
                setBusy(true); setError(""); setResults(null);
                try {
                  const signature = `${macro.id}:${selection.join(",")}`;
                  if (macroBatch.current.signature !== signature) {
                    macroBatch.current = { signature, key: crypto.randomUUID() };
                  }
                  const outcome = await api.applyMacro(macro.id, selection, macroBatch.current.key);
                  macroBatch.current = { signature: "", key: "" };
                  setResults(selection.map((id) => ({ id, label: labelFor(rows, id) })));
                  preserveLedger.current = true;
                  setApplied(t("caseBulk.macroApplied", {
                    name: macro.name, count: outcome?.actionsApplied ?? 0, skipped: outcome?.actionsSkipped ?? 0,
                  }));
                  onSelectionChange(clearSelection());
                  setPanel("");
                  await onDone();
                } catch (cause) {
                  setError(refusalText(t, cause, "macro", "caseBulk.failed"));
                } finally { release(); setBusy(false); }
              });
            }}>
              {macro.name}
              <small>{t("caseBulk.macroActionCount", { count: (macro.actions || []).length })}</small>
            </BusyButton>
          ))}
        </div>
      )}

      {error && <p className="case-bulk__error" role="alert">{error}</p>}
      {applied && <p className="case-bulk__exported" role="status">{applied}</p>}
      <ResultLedger results={results} t={t} />
    </div>
  );
}

function labelFor(rows, id) {
  const row = (rows || []).find((entry) => entry?.id === id);
  return row?.reference || row?.title || id;
}
