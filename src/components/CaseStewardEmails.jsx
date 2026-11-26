import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { useLang } from "../lib/LanguageContext.jsx";

// REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001: the steward email that
// automatic routing attached to this case, shown only on the staff case tools.
// public.list_case_steward_emails re-checks that the reader can open the case;
// a case with no attached email renders nothing.
export function CaseStewardEmails({ caseId, api }) {
  const { t, lang } = useLang();
  const heading = useId();
  const run = useRef(0);
  const [state, setState] = useState({ caseId: null, rows: [], loading: true, error: false });
  const load = useCallback(async () => {
    const request = ++run.current;
    setState((current) => ({ ...current, caseId, loading: true, error: false }));
    try {
      const rows = await api.loadCaseStewardEmails(caseId);
      if (run.current === request) setState({ caseId, rows: Array.isArray(rows) ? rows : [], loading: false, error: false });
    } catch {
      if (run.current === request) setState({ caseId, rows: [], loading: false, error: true });
    }
  }, [api, caseId]);
  useEffect(() => {
    void load();
    return () => { run.current += 1; };
  }, [load]);

  if (state.caseId !== caseId || state.loading) return null;
  if (state.error) {
    return <section className="thread-list" aria-labelledby={heading}>
      <h3 id={heading}>{t("caseEmails.title")}</h3>
      <p role="alert">{t("caseEmails.unavailable")} <button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => void load()}>{t("caseEmails.retry")}</button></p>
    </section>;
  }
  if (!state.rows.length) return null;
  return <section className="thread-list" aria-labelledby={heading}>
    <h3 id={heading}>{t("caseEmails.title")}</h3>
    <p className="cwk-panel__note">{t("caseEmails.help")}</p>
    {state.rows.map((email) => <article className="thread-message thread-message--steward" key={email.id}>
      <h4>{email.subject || t("caseEmails.noSubject")}</h4>
      <p className="cwk-email__from">{t("caseEmails.from", { from: email.from })}</p>
      <p className="cwk-email__body">{email.text}</p>
      <time dateTime={email.receivedAt}>{formatGroupMoment(email.receivedAt, lang)}</time>
    </article>)}
  </section>;
}
