import { prepareBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { rpcErrorKeyStrict, rpcErrorTextStrict } from "../lib/rpcErrorText.js";

// REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006,
// owner answer 11=A: a steward's own dated reminder, title and date only,
// written before a case exists (a pre-filing date) and attachable to a case
// once one is opened. The steward_*_private_reminder routines only ever return
// the caller's own rows, so nothing here is shown to anyone else.
const MIN_REMINDER_DATE = "0001-01-01";
const MAX_REMINDER_DATE = "9999-12-31";

function dateOnly(value, lang, fallback) {
  // Old rows may predate the SQL bounds. Keep the row (and Delete) usable.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || value < MIN_REMINDER_DATE || value > MAX_REMINDER_DATE) return fallback;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return fallback;
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(date);
}

export function StewardPrivateReminders({ api, caseOptions = [], onNotice = () => {} }) {
  const busyWriteRef = useRef(new Set());
  const { t, lang } = useLang();
  const headingId = useId();
  const [state, setState] = useState({ loading: true, error: false, rows: [] });
  const [busy, setBusy] = useState("");
  const [saveFeedback, setSaveFeedback] = useState(null);
  const readGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const rows = await api.listPrivateReminders();
      if (generation !== readGeneration.current) return;
      setState({ loading: false, error: false, rows: Array.isArray(rows) ? rows : [] });
    } catch {
      if (generation !== readGeneration.current) return;
      setState((current) => ({ ...current, loading: false, error: true }));
    }
  }, [api]);
  useEffect(() => {
    if (api?.listPrivateReminders) void load();
    return () => { readGeneration.current += 1; };
  }, [api, load]);

  if (!api?.listPrivateReminders) return null;

  // Every write returns the caller's full list, so a saved change replaces
  // the rows without a second read.
  async function run(key, work, form = null) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy) return;
      return async (releaseBusyWrite) => {
        const savingNewReminder = key === "save";
        setBusy(key);
        if (savingNewReminder) setSaveFeedback(null);
        else readGeneration.current += 1;
        try {
          const rows = await work();
          // Also invalidate retries begun while this write was in flight.
          readGeneration.current += 1;
          if (Array.isArray(rows)) setState({ loading: false, error: false, rows });
          form?.reset();
          if (savingNewReminder) setSaveFeedback({ key: "caseworkDeadlines.private.saved", failed: false });
          else onNotice(t("caseworkDeadlines.private.saved"));
        } catch (error) {
          if (savingNewReminder) {
            setSaveFeedback({ key: rpcErrorKeyStrict(error, "caseworkDeadlines.private.failed"), failed: true });
          } else {
            setState((current) => ({ ...current, loading: false, error: true }));
            onNotice(rpcErrorTextStrict(t, error, t("caseworkDeadlines.private.failed")));
          }
        } finally {
          setBusy("");
          releaseBusyWrite();
        }
      };
    });
  }

  return (
    <section className="cwk-panel" aria-labelledby={headingId}>
      <div className="cwk-panel__head">
        <div className="cwk-panel__heading">
          <span className="cwk-panel__title" id={headingId}>{t("caseworkDeadlines.private.title")}</span>
        </div>
        {/* The attach control exists only while a case is on this caseload,
            so the help says where it will appear rather than promising it
            (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030). */}
        <p className="cwk-panel__note">{t(caseOptions.length > 0 ? "caseworkDeadlines.private.note" : "caseworkDeadlines.private.noteNoCases")}</p>
      </div>
      <form className="stack-form" onChange={() => setSaveFeedback(null)} onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const title = String(new FormData(form).get("title") || "").trim();
        const remindOn = String(new FormData(form).get("remindOn") || "");
        void run("save", () => api.savePrivateReminder({ title, remindOn }), form);
      }}>
        <label>{t("caseworkDeadlines.private.titleLabel")}<BusyInput name="title" minLength={1} maxLength={200} required pending={busy === "save"} /></label>
        <label>{t("caseworkDeadlines.private.dateLabel")}<BusyInput name="remindOn" type="date" min={MIN_REMINDER_DATE} max={MAX_REMINDER_DATE} required pending={busy === "save"} /></label>
        <div>
          <BusyButton className="cwk-btn cwk-btn--soft" type="submit" pending={Boolean(busy)}>{t("caseworkDeadlines.private.add")}</BusyButton>
          <div role="status" aria-atomic="true">
            {saveFeedback && (
              <p className={saveFeedback.failed ? "case-files__error" : "cwk-empty cwk-empty--inset"}>
                {t(saveFeedback.key)}
              </p>
            )}
          </div>
        </div>
      </form>
      {state.error && (
        <p className="cwk-empty" role="status">
          {t("caseworkDeadlines.private.unavailable")}{" "}
          <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => void load()}>{t("caseworkDeadlines.private.retry")}</button>
        </p>
      )}
      {!state.error && !state.loading && state.rows.length === 0 && <p className="cwk-empty">{t("caseworkDeadlines.private.empty")}</p>}
      {state.rows.length > 0 && (
        <ul className="detail-record__list">
          {state.rows.map((row) => (
            <li key={row.id}>
              <p><strong>{row.title}</strong><br /><small>{dateOnly(row.remindOn, lang, t("caseworkDeadlines.private.dateUnavailable"))}</small></p>
              {row.caseReference
                ? <p><small>{t("caseworkDeadlines.private.attached", { reference: row.caseReference })}</small></p>
                : caseOptions.length > 0 && (
                  <form className="stack-form" onSubmit={(event) => {
                    event.preventDefault();
                    const caseId = String(new FormData(event.currentTarget).get("caseId") || "");
                    if (caseId) void run(`attach-${row.id}`, () => api.attachPrivateReminder(row.id, caseId));
                  }}>
                    <label>{t("caseworkDeadlines.private.caseLabel")}
                      <select name="caseId" required defaultValue="">
                        <option value="" disabled>—</option>
                        {caseOptions.map((item) => <option value={item.id} key={item.id}>{item.reference} · {item.title}</option>)}
                      </select>
                    </label>
                    <BusyButton className="cwk-btn cwk-btn--ghost" type="submit" pending={Boolean(busy)}>{t("caseworkDeadlines.private.attach")}</BusyButton>
                  </form>
                )}
              <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={Boolean(busy)} onClick={() => void run(`delete-${row.id}`, () => api.deletePrivateReminder(row.id))}>{t("caseworkDeadlines.private.delete")}</BusyButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
