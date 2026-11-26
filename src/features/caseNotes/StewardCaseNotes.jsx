import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton, BusyInput, BusyTextarea } from "../../components/BusyControls.jsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { caseRowLine } from "../../lib/caseRowLine.js";
import { dateTimeFormat } from "../../lib/i18n.js";
import { rpcErrorTextStrict } from "../../lib/rpcErrorText.js";
import { routineMissing, todayIso } from "./api.js";
import "../../lib/i18n/features/caseNotesStrings.js";

// REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030 (findings 44
// and 48): a steward adds a dated note to a case they hold, and sees every
// open deadline on their cases in one list.

function dayLabel(value, lang) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? new Date(`${value}T12:00:00`) : null;
  return parsed ? dateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }).format(parsed) : "";
}

// `onAdd(caseId, body, occurredOn)` is api.addStewardCaseNote; `onSaved`
// reloads the desk so the case's notes and history show the new note.
export function StewardCaseNoteForm({ caseId, onAdd, onSaved = () => {}, onNotice = () => {} }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  const headingId = useId();
  const formRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("idle");
  if (!onAdd) return null;
  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy) return;
      const form = new FormData(event.currentTarget);
      const body = String(form.get("note") || "").trim();
      if (!body) return;
      return async (releaseBusyWrite) => {
        setBusy(true);
        setState("idle");
        try {
          await onAdd(caseId, body, String(form.get("occurredOn") || "") || null);
          formRef.current?.reset();
          setState("saved");
          onNotice(t("caseNotes.stewardSaved"));
          onSaved?.();
        } catch (error) {
          setState(routineMissing(error) ? "unavailable" : "failed");
          if (!routineMissing(error)) onNotice(rpcErrorTextStrict(t, error, t("caseNotes.stewardFailed")));
        } finally {
          setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  return <section className="cwk-case-note" aria-labelledby={headingId}>
    <h4 id={headingId}>{t("caseNotes.stewardTitle")}</h4>
    <form ref={formRef} className="stack-form" onSubmit={submit}>
      <label>{t("caseNotes.stewardBody")}<BusyTextarea name="note" maxLength={4000} required pending={busy} /></label>
      <small>{t("caseNotes.noteAudience")}</small>
      <label>{t("caseNotes.dateLabel")}<BusyInput type="date" name="occurredOn" defaultValue={todayIso()} max={todayIso()} pending={busy} /></label>
      <small>{t("caseNotes.dateHelp")}</small>
      <BusyButton className="cwk-btn cwk-btn--soft" type="submit" pending={busy}>{busy ? t("caseNotes.stewardSaving") : t("caseNotes.stewardSave")}</BusyButton>
    </form>
    {state === "saved" && <p role="status">{t("caseNotes.stewardSaved")}</p>}
    {state === "failed" && <p role="alert">{t("caseNotes.stewardFailed")}</p>}
    {state === "unavailable" && <p role="status">{t("caseNotes.stewardUnavailable")}</p>}
  </section>;
}

// `load()` is api.listCaseDeadlines: { state: "ready" | "unavailable", rows,
// truncated }. `refreshKey` is the desk snapshot: a case saved anywhere on the
// desk reloads it, and this list reads again with it.
export function StewardDeadlineList({ load, onOpenCase = null, refreshKey = null }) {
  const { t, lang } = useLang();
  const headingId = useId();
  const [view, setView] = useState({ state: "loading", rows: [], truncated: false });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!load) return;
    const ticket = ++generation.current;
    setView((current) => ({ ...current, state: current.rows.length ? current.state : "loading" }));
    try {
      const next = await load();
      if (ticket === generation.current) setView({ state: next.state, rows: next.rows, truncated: next.truncated === true });
    } catch {
      if (ticket === generation.current) setView({ state: "error", rows: [], truncated: false });
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh, refreshKey]);
  if (!load) return null;
  const kind = (row) => t(["case", "procedure"].includes(row.kind) ? `caseNotes.kind.${row.kind}` : "caseNotes.kind.other");
  return <section className="cwk-panel" aria-labelledby={headingId}>
    <div className="cwk-panel__head">
      <div className="cwk-panel__heading">
        <span className="cwk-panel__title" id={headingId}>{t("caseNotes.deadlinesTitle")}</span>
        {view.state === "ready" && <span className="cwk-count">{view.truncated ? `${view.rows.length}+` : view.rows.length}</span>}
      </div>
      <p className="cwk-panel__note">{t("caseNotes.deadlinesNote")}</p>
    </div>
    {view.state === "loading" && <p className="cwk-empty" role="status">{t("app.loading")}</p>}
    {view.state === "unavailable" && <p className="cwk-empty">{t("caseNotes.deadlinesUnavailable")}</p>}
    {view.state === "error" && <p className="cwk-empty" role="status">
      {t("caseNotes.deadlinesFailed")}{" "}
      <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => void refresh()}>{t("caseNotes.retry")}</button>
    </p>}
    {view.state === "ready" && view.truncated && <p className="cwk-panel__note" role="note">{t("caseNotes.deadlinesTruncated", { count: view.rows.length })}</p>}
    {view.state === "ready" && view.rows.length === 0 && <p className="cwk-empty">{t("caseNotes.deadlinesEmpty")}</p>}
    {view.state === "ready" && view.rows.length > 0 && <ul className="detail-record__list">
      {view.rows.map((row) => <li key={`${row.caseId}:${row.kind}:${row.label}:${row.dueOn}`}>
        <p>
          {onOpenCase
            ? <button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => onOpenCase(row.caseId)}>{row.reference} · {caseRowLine(row, t)}</button>
            : <strong>{row.reference} · {caseRowLine(row, t)}</strong>}
          <br /><small>{kind(row)}{row.kind === "case" ? "" : ` · ${row.label}`} · {t(row.overdue ? "caseNotes.overdue" : "caseNotes.due", { date: dayLabel(row.dueOn, lang) })}</small>
        </p>
        {row.afterStepDue && <p role="note"><small>{t("caseNotes.afterStep")}</small></p>}
      </li>)}
    </ul>}
  </section>;
}
