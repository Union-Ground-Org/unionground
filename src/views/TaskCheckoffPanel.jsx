import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  CHECKOFF_FILTERS,
  CHECKOFF_MODES,
  checkoffProgress,
  createTaskCheckoff,
  evaluateCheckoff,
  filterCheckoffEntries,
  loadTaskCheckoff,
  loadTaskCheckoffCandidates,
  setTaskCheckoffEntry,
  setTaskCheckoffListStatus,
} from "../lib/taskCheckoff.js";
import "./taskCheckoff.css";

// REQ-UG-COOP-CHECKOFF-LISTS-20261001. A member check-off list attached to
// one ordinary task (the old app/dashboard/tasks/coop screens). The panel
// renders nothing while the organization switch is off; every write is
// re-checked by the database.
const STATUS_ACTIONS = Object.freeze(["done", "unreachable", "follow_up"]);

function BuildForm({ candidates, busy, onCancel, onCreate, t }) {
  const formId = useId();
  const [mode, setMode] = useState("split_even");
  const [members, setMembers] = useState(() => new Set());
  const [stewards, setStewards] = useState(() => new Set());
  const [manual, setManual] = useState({});
  const roster = candidates.members;
  const stewardOptions = roster.filter((person) => person.steward);
  const toggle = (setter, id) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const chosenMembers = roster.filter((person) => members.has(person.id)).map((person) => person.id);
  const chosenStewards = stewardOptions.filter((person) => stewards.has(person.id)).map((person) => person.id);
  const splitMode = mode === "split_even" || mode === "split_random";
  const ready = chosenMembers.length > 0
    && (!splitMode || chosenStewards.length > 0)
    && (mode !== "manual" || chosenMembers.every((id) => manual[id]));
  // #9468 W6-9: name the first unmet rule beside Create list.
  const unassigned = mode === "manual" ? roster.filter((person) => members.has(person.id) && !manual[person.id]) : [];
  const blockedReason = ready ? null
    : roster.length === 0 ? t("taskCheckoff.noMembers")
    : chosenMembers.length === 0 ? t("taskCheckoff.blocked.members")
    : mode !== "shared" && stewardOptions.length === 0 ? t("taskCheckoff.blocked.noStewards")
    : splitMode ? t("taskCheckoff.blocked.stewards")
    : t("taskCheckoff.blocked.manual", { names: unassigned.map((person) => person.name || t("tasks.chapterMember")).join(", ") });
  return (
    <form className="task-checkoff__build" onSubmit={(event) => {
      event.preventDefault();
      if (!ready) return;
      onCreate({ mode, memberIds: chosenMembers, stewardIds: chosenStewards, manual });
    }}>
      <fieldset>
        <legend>{t("taskCheckoff.mode")}</legend>
        {CHECKOFF_MODES.map((value) => (
          <label key={value} className="task-checkoff__choice">
            <input type="radio" name={`${formId}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} />
            <span>{t(`taskCheckoff.mode.${value}`)}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{t("taskCheckoff.members", { count: chosenMembers.length })}</legend>
        {roster.length === 0 ? <p>{t("taskCheckoff.noMembers")}</p> : (
          <>
            <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy}
              onClick={() => setMembers(chosenMembers.length === roster.length ? new Set() : new Set(roster.map((person) => person.id)))}>
              {t(chosenMembers.length === roster.length ? "taskCheckoff.clearAll" : "taskCheckoff.selectAll")}
            </BusyButton>
            <ul className="task-checkoff__roster">
              {roster.map((person) => (
                <li key={person.id}>
                  <label className="task-checkoff__choice">
                    <input type="checkbox" checked={members.has(person.id)} onChange={() => toggle(setMembers, person.id)} />
                    <span>{person.name || t("tasks.chapterMember")}</span>
                  </label>
                  {mode === "manual" && members.has(person.id) ? (
                    <select aria-label={t("taskCheckoff.stewardFor", { name: person.name || t("tasks.chapterMember") })}
                      value={manual[person.id] || ""} onChange={(event) => setManual((current) => ({ ...current, [person.id]: event.target.value }))}>
                      <option value="">{t("taskCheckoff.pickSteward")}</option>
                      {stewardOptions.map((steward) => <option key={steward.id} value={steward.id}>{steward.name || t("tasks.chapterMember")}</option>)}
                    </select>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </fieldset>
      {splitMode ? (
        <fieldset>
          <legend>{t("taskCheckoff.stewards", { count: chosenStewards.length })}</legend>
          {stewardOptions.length === 0 ? <p>{t("taskCheckoff.noStewards")}</p> : (
            <ul className="task-checkoff__roster">
              {stewardOptions.map((person) => (
                <li key={person.id}>
                  <label className="task-checkoff__choice">
                    <input type="checkbox" checked={stewards.has(person.id)} onChange={() => toggle(setStewards, person.id)} />
                    <span>{person.name || t("tasks.chapterMember")}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      ) : null}
      <div className="task-checkoff__actions">
        <BusyButton type="submit" className="hub2-btn hub2-btn--primary" pending={busy} disabled={!ready} disabledReason={blockedReason}>{t("taskCheckoff.create")}</BusyButton>
        <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy} onClick={onCancel}>{t("taskCheckoff.cancel")}</BusyButton>
      </div>
    </form>
  );
}

function EntryRow({ entry, list, memberId, busy, onSet, t }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(entry.note || "");
  const noteId = useId();
  const allowed = (nextStatus) => evaluateCheckoff({
    actorId: memberId, isManager: list.canManage === true, listStatus: list.status, entry, nextStatus,
  }).allowed;
  const actions = STATUS_ACTIONS.filter((status) => status !== entry.status && allowed(status));
  const canReset = list.canManage === true && entry.status !== "pending";
  const canNote = allowed(entry.status === "pending" ? "follow_up" : entry.status) && entry.status !== "pending";
  const name = entry.memberName || t("tasks.chapterMember");
  return (
    <li className="task-checkoff__row" data-status={entry.status}>
      <div>
        <strong>{name}</strong>
        <small>
          {t(`taskCheckoff.status.${entry.status}`)}
          {" · "}
          {entry.assignedStewardId ? t("taskCheckoff.assignedTo", { name: entry.assignedStewardName || t("tasks.chapterMember") }) : t("taskCheckoff.shared")}
          {entry.status !== "pending" && entry.actionedByName ? ` · ${t("taskCheckoff.actionedBy", { name: entry.actionedByName })}` : ""}
        </small>
        {entry.note ? <p className="task-checkoff__note">{entry.note}</p> : null}
      </div>
      {actions.length || canReset || canNote ? (
        <div className="task-checkoff__actions">
          {actions.map((status) => (
            <BusyButton key={status} type="button" className="hub2-btn hub2-btn--ghost" pending={busy}
              aria-label={`${t(`taskCheckoff.action.${status}`)}: ${name}`}
              onClick={() => onSet(entry, status, note)}>
              {t(`taskCheckoff.action.${status}`)}
            </BusyButton>
          ))}
          {canNote || actions.length ? (
            <button type="button" className="hub2-btn hub2-btn--ghost" aria-expanded={noteOpen} aria-controls={noteId}
              onClick={() => setNoteOpen((value) => !value)}>
              {t(noteOpen ? "taskCheckoff.hideNote" : entry.note ? "taskCheckoff.editNote" : "taskCheckoff.addNote")}
            </button>
          ) : null}
          {canReset ? (
            <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy}
              aria-label={`${t("taskCheckoff.reset")}: ${name}`}
              onClick={() => onSet(entry, "pending", entry.note || "")}>
              {t("taskCheckoff.reset")}
            </BusyButton>
          ) : null}
        </div>
      ) : null}
      {noteOpen ? (
        <div id={noteId} className="task-checkoff__note-field">
          <label>
            {t("taskCheckoff.note")}
            <textarea maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          {entry.status !== "pending" && canNote ? (
            <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy} onClick={() => onSet(entry, entry.status, note)}>
              {t("taskCheckoff.saveNote")}
            </BusyButton>
          ) : <small>{t("taskCheckoff.noteWithAction")}</small>}
        </div>
      ) : null}
    </li>
  );
}

export function TaskCheckoffPanel({ client, taskId, memberId }) {
  const { t } = useLang();
  const [state, setState] = useState({ status: "loading", data: null });
  const [candidates, setCandidates] = useState(null);
  const [building, setBuilding] = useState(false);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", data: await loadTaskCheckoff(client, taskId) });
    } catch {
      // The switch starts off and the read can predate a hosted migration, so
      // a failed read must not put an error into every task. Show nothing.
      setState({ status: "unavailable", data: null });
    }
  }, [client, taskId]);

  useEffect(() => { void load(); }, [load]);

  function run(action) {
    return runBusyWrite(busyWriteRef, "checkoff", () => runNow(action));
  }

  async function runNow(action) {
    setBusy(true);
    setError("");
    try {
      const data = await action();
      if (data) setState({ status: "ready", data });
      return true;
    } catch (failure) {
      setError(t(`taskCheckoff.error.${failure?.reason || "failed"}`));
      if (failure?.reason === "stale") await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openBuilder() {
    return runBusyWrite(busyWriteRef, "checkoff", () => openBuilderNow());
  }

  async function openBuilderNow() {
    setError("");
    setBusy(true);
    try {
      setCandidates(await loadTaskCheckoffCandidates(client, taskId));
      setBuilding(true);
    } catch {
      setError(t("taskCheckoff.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (state.status !== "ready" || state.data?.enabled !== true) return null;
  const list = state.data.list;
  const progress = list ? checkoffProgress(list.entries) : null;
  const rows = list ? filterCheckoffEntries(list.entries, filter) : [];

  return (
    <section className="kan-modal__card task-checkoff" aria-label={t("taskCheckoff.title")}>
      <h3>{t("taskCheckoff.title")}</h3>
      {error ? <p role="alert">{error}</p> : null}
      {!list ? (
        building && candidates ? (
          <BuildForm candidates={{ members: Array.isArray(candidates.members) ? candidates.members : [] }} busy={busy} t={t}
            onCancel={() => setBuilding(false)}
            onCreate={async (input) => { if (await run(() => createTaskCheckoff(client, { taskId, ...input }))) setBuilding(false); }} />
        ) : (
          <>
            <p>{t("taskCheckoff.empty")}</p>
            <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={busy} onClick={() => void openBuilder()}>{t("taskCheckoff.add")}</BusyButton>
          </>
        )
      ) : (
        <>
          <p role="status">
            {t("taskCheckoff.progress", { completed: progress.completed, total: progress.total })}
            {" · "}{t(`taskCheckoff.mode.${list.mode}`)}
            {list.status === "closed" ? ` · ${t("taskCheckoff.closed")}` : ""}
          </p>
          <ul className="task-checkoff__summary">
            {progress.perSteward.map((bucket) => (
              <li key={bucket.stewardId || "shared"}>
                {bucket.stewardId ? bucket.name || t("tasks.chapterMember") : t("taskCheckoff.shared")}
                {": "}{t("taskCheckoff.bucket", { completed: bucket.completed, total: bucket.total, followUp: bucket.followUp })}
              </li>
            ))}
          </ul>
          <div className="task-checkoff__actions">
            <label>
              {t("taskCheckoff.filter")}
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                {CHECKOFF_FILTERS.map((value) => <option key={value} value={value}>{t(value === "all" ? "taskCheckoff.filterAll" : `taskCheckoff.status.${value}`)}</option>)}
              </select>
            </label>
            {list.canManage ? (
              <BusyButton type="button" className="hub2-btn hub2-btn--ghost" pending={busy}
                onClick={() => void run(() => setTaskCheckoffListStatus(client, taskId, list.status === "open" ? "closed" : "open"))}>
                {t(list.status === "open" ? "taskCheckoff.close" : "taskCheckoff.reopen")}
              </BusyButton>
            ) : null}
          </div>
          {rows.length === 0 ? <p>{t("taskCheckoff.noneInFilter")}</p> : (
            <ul className="task-checkoff__rows">
              {rows.map((entry) => (
                <EntryRow key={`${entry.id}:${entry.status}:${entry.note}`} entry={entry} list={list} memberId={memberId} busy={busy} t={t}
                  onSet={(row, status, note) => void run(() => setTaskCheckoffEntry(client, {
                    entryId: row.id, status, note, expectedStatus: row.status,
                  }))} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
