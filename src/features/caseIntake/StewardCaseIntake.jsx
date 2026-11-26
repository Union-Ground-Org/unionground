import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { caseRowLine } from "../../lib/caseRowLine.js";
import { dateTimeFormat } from "../../lib/i18n.js";
import { rpcErrorTextStrict } from "../../lib/rpcErrorText.js";
import { CaseDetailsFields, caseFieldsFromForm } from "./CaseDetailsFields.jsx";
import "../../lib/i18n/features/caseIntakeStrings.js";

// Steward caseload additions (REQ-UG-STEWARD-CASEWORK-GAPS-20261030,
// findings 22 and 23): open a case under a member's name (the steward becomes
// its steward, so it lands on this caseload), and take an unassigned case of
// a member in scope, including one the member started. `api` carries
// openCaseForMember, searchCaseMembers, listUnassignedCases and claimCase;
// onChanged reloads the desk so the caseload shows the new case.
export function StewardCaseIntake({ api, onNotice = () => {}, onChanged = () => {} }) {
  const busyWriteRef = useRef(new Set());
  const { t, lang } = useLang();
  const intakeHeading = useId();
  const waitingHeading = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState({ state: "idle", rows: [] });
  const [member, setMember] = useState(null);
  const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState("");
  const [waiting, setWaiting] = useState({ state: "loading", rows: [] });
  const generation = useRef(0);

  const loadWaiting = useCallback(async () => {
    if (!api?.listUnassignedCases) return;
    const ticket = ++generation.current;
    setWaiting((current) => ({ ...current, state: current.rows.length ? current.state : "loading" }));
    try {
      const next = await api.listUnassignedCases();
      if (ticket === generation.current) setWaiting({ state: next.state, rows: next.rows });
    } catch {
      if (ticket === generation.current) setWaiting({ state: "error", rows: [] });
    }
  }, [api]);
  useEffect(() => {
    void loadWaiting();
    return () => { generation.current += 1; };
  }, [loadWaiting]);

  if (!api?.openCaseForMember || !api?.listUnassignedCases) return null;

  async function find(event) {
    event.preventDefault();
    const needle = query.trim();
    if (needle.length < 2) return;
    setSearch({ state: "loading", rows: [] });
    try {
      const rows = await api.searchCaseMembers(needle);
      setSearch({ state: "ready", rows });
    } catch {
      setSearch({ state: "error", rows: [] });
    }
  }

  async function open(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      const form = event.currentTarget;
      if (busy) return;
      if (!member) { setFormError(t("caseIntake.memberRequired")); return; }
      return async (releaseBusyWrite) => {
        setFormError("");
        setBusy("open");
        try {
          const result = await api.openCaseForMember({ ...caseFieldsFromForm(new FormData(form)), memberId: member.userId, assignSelf: true });
          form.reset();
          setMember(null);
          setQuery("");
          setSearch({ state: "idle", rows: [] });
          // Only a steward in the member's scope becomes the case steward; a case
          // opened through coordinator or admin scope stays unassigned.
          onNotice(t(result?.assigned ? "caseIntake.opened" : "caseIntake.openedUnassigned", { reference: result?.reference ?? "" }));
          onChanged();
        } catch (error) {
          setFormError(rpcErrorTextStrict(t, error, t("caseIntake.openFailed")));
        } finally {
          setBusy("");
          releaseBusyWrite();
        }
      };
    }, event);
  }

  async function take(row) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (busy) return;
      return async (releaseBusyWrite) => {
        setBusy(`take-${row.id}`);
        try {
          const result = await api.claimCase(row.id);
          onNotice(t("caseIntake.taken", { reference: result?.reference ?? row.reference }));
          onChanged();
          await loadWaiting();
        } catch (error) {
          onNotice(rpcErrorTextStrict(t, error, t("caseIntake.takeFailed")));
          await loadWaiting();
        } finally {
          setBusy("");
          releaseBusyWrite();
        }
      };
    });
  }

  const due = (value) => {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? new Date(`${value}T12:00:00`) : null;
    return parsed ? t("caseIntake.due", { date: dateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }).format(parsed) }) : t("caseIntake.noDeadline");
  };

  return <>
    <section className="cwk-panel" aria-labelledby={waitingHeading}>
      <div className="cwk-panel__head">
        <div className="cwk-panel__heading">
          <span className="cwk-panel__title" id={waitingHeading}>{t("caseIntake.unassignedTitle")}</span>
          {waiting.state === "ready" && <span className="cwk-count">{waiting.rows.length}</span>}
        </div>
        <p className="cwk-panel__note">{t("caseIntake.unassignedNote")}</p>
      </div>
      {waiting.state === "loading" && <p className="cwk-empty" role="status">{t("app.loading")}</p>}
      {waiting.state === "unavailable" && <p className="cwk-empty">{t("caseIntake.unassignedUnavailable")}</p>}
      {waiting.state === "error" && <p className="cwk-empty" role="status">
        {t("caseIntake.unassignedFailed")}{" "}
        <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => void loadWaiting()}>{t("caseIntake.retry")}</button>
      </p>}
      {waiting.state === "ready" && waiting.rows.length === 0 && <p className="cwk-empty">{t("caseIntake.unassignedEmpty")}</p>}
      {waiting.state === "ready" && waiting.rows.length > 0 && <ul className="detail-record__list">
        {waiting.rows.map((row) => <li key={row.id}>
          <p><strong>{row.reference} · {caseRowLine(row, t)}</strong><br />
            <small>{[t("caseIntake.for", { name: row.memberName || "" }), due(row.deadline)].join(" · ")}</small></p>
          <BusyButton className="cwk-btn cwk-btn--soft" type="button" pending={Boolean(busy)} onClick={() => void take(row)}>
            {busy === `take-${row.id}` ? t("caseIntake.taking") : t("caseIntake.take")}
          </BusyButton>
        </li>)}
      </ul>}
    </section>

    <section className="cwk-panel" aria-labelledby={intakeHeading}>
      <div className="cwk-panel__head">
        <div className="cwk-panel__heading">
          <span className="cwk-panel__title" id={intakeHeading}>{t("caseIntake.openForMemberTitle")}</span>
        </div>
        <p className="cwk-panel__note">{t("caseIntake.openForMemberNote")}</p>
      </div>
      {/* REQ-UG-CASE-FORM-LAYOUT-20261102: one gutter and a bounded
          width for the whole form, the member first, then the case in named
          groups; Find sits beside the field it searches. */}
      <div className="case-intake__body">
        {member ? <fieldset className="case-intake__group"><legend>{t("caseIntake.groupMember")}</legend>
          <p className="case-intake__chosen">
            <strong>{t("caseIntake.memberChosen", { name: member.fullName })}</strong>{member.chapterName ? ` · ${member.chapterName}` : ""}{" "}
            <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={Boolean(busy)} onClick={() => setMember(null)}>{t("caseIntake.memberChange")}</BusyButton>
          </p>
        </fieldset> : <form className="stack-form" onSubmit={find}>
          <fieldset className="case-intake__group"><legend>{t("caseIntake.groupMember")}</legend>
            <div className="case-intake__search">
              <label>{t("caseIntake.memberSearch")}<input type="search" value={query} minLength={2} maxLength={100} aria-describedby={`${intakeHeading}-search-help`} onChange={(event) => setQuery(event.target.value)} /></label>
              <button className="cwk-btn cwk-btn--ghost" type="submit" disabled={query.trim().length < 2 || search.state === "loading"}>
                {search.state === "loading" ? t("caseIntake.memberSearching") : t("caseIntake.memberSearchButton")}
              </button>
            </div>
            <small id={`${intakeHeading}-search-help`} className="case-intake__help">{t("caseIntake.memberSearchHelp")}</small>
            {search.state === "error" && <p className="cwk-empty" role="alert">{t("caseIntake.memberSearchFailed")}</p>}
            {search.state === "ready" && search.rows.length === 0 && <p className="cwk-empty" role="status">{t("caseIntake.memberNone")}</p>}
            {search.state === "ready" && search.rows.length > 0 && <ul className="detail-record__list">
              {search.rows.map((row) => <li key={row.userId}>
                <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => { setMember(row); setFormError(""); }}>
                  {row.fullName}{row.chapterName ? ` · ${row.chapterName}` : ""}
                </button>
              </li>)}
            </ul>}
          </fieldset>
        </form>}
        <form className="stack-form" onSubmit={open}>
          <CaseDetailsFields pending={busy === "open"} grouped />
          {formError && <p className="case-files__error" role="alert">{formError}</p>}
          <BusyButton className="cwk-btn cwk-btn--soft" type="submit" pending={Boolean(busy)}>{busy === "open" ? t("caseIntake.opening") : t("caseIntake.open")}</BusyButton>
        </form>
      </div>
    </section>
  </>;
}
