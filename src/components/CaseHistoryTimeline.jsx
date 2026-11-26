import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatHistoryValue } from "../lib/caseHistoryValue.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { catalogue, dateTimeFormat } from "../lib/i18n.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import "./CaseHistoryTimeline.css";
import "../lib/i18n/features/caseNotesStrings.js";

// The RPC enforces visibility. This projection also keeps the selected Member
// plane narrow when an account is authorized to wear a staff hat.
function memberHistoryEvent(event) {
  if (event.kind === "note" || event.kind === "transition") return event;
  if (event.kind !== "fields") return null;
  const keys = {
    member_cases: ["deadline"],
    casework_deadlines: ["label", "kind", "due_at", "status"],
    casework_deadline_extensions: ["previous_due_at", "requested_due_at", "status", "decided_at"],
  }[event.details?.table];
  if (!keys) return null;
  const changes = Object.fromEntries(Object.entries(event.details.changes || {}).filter(([key]) => keys.includes(key)));
  return Object.keys(changes).length ? { ...event, details: { ...event.details, changes } } : null;
}

// Who did this, under the caller's own visibility. The RPC resolves a display
// name only for accounts the caller may already see and otherwise sends the
// actor's role on this case; the raw uuid is never a display value, so an
// event with neither simply carries no attribution line.
function HistoryActor({ event }) {
  const { t } = useLang();
  const name = typeof event.actor_name === "string" ? event.actor_name.trim() : "";
  const role = event.actor_role && Object.hasOwn(catalogue.en, `caseHistory.role.${event.actor_role}`) ? t(`caseHistory.role.${event.actor_role}`) : "";
  const who = name || role;
  return who ? <p className="case-history__actor">{t("caseHistory.actor", { name: who })}</p> : null;
}

function noteDateLabel(value, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return "";
  return dateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function HistoryDetails({ event }) {
  const { t, lang } = useLang();
  const details = event.details || {};
  const fieldLabel = (key) => Object.hasOwn(catalogue.en, `caseHistory.field.${key}`) ? t(`caseHistory.field.${key}`) : t("caseHistory.field.other", { field: key.replaceAll("_", " ") });
  const value = (key, item) => formatHistoryValue(item, { key, t, lang });
  // A dated note names the day it is about (REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030).
  if (event.kind === "note") return <><p>{details.body}</p>{noteDateLabel(details.occurredOn, lang) && <p className="case-history__dated">{t("caseNotes.dated", { date: noteDateLabel(details.occurredOn, lang) })}</p>}</>;
  if (event.kind === "transition") return <><p>{value("from_step", details.from_step)} → {value("to_step", details.to_step)}</p><p>{details.outcome == null || details.outcome === "" ? "" : value("outcome", details.outcome)}</p></>;
  if (event.kind === "fields") return <>{details.op && <p>{t("caseHistory.fieldsEvent", { record: t(`caseHistory.table.${details.table}`), operation: t(`caseHistory.operation.${details.op}`) })}</p>}<dl className="case-history__changes">{Object.entries(details.changes || {}).map(([key, change]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd><span>{value(key, change.old)}</span><span className="visually-hidden">{t("caseHistory.to")}</span><span aria-hidden="true"> → </span><strong>{value(key, change.new)}</strong></dd></div>)}</dl></>;
  if (event.kind === "assignment") return <p>{t("caseHistory.assignmentChanged")}</p>;
  if (event.kind === "coordinator" && details.action === "case_updated" && Object.hasOwn(details.before || {}, "articles") && Object.hasOwn(details.after || {}, "articles") && details.before.articles !== details.after.articles) return <><p>{t("caseHistory.action.case_updated")}</p>{details.reason && <p>{details.reason}</p>}<dl className="case-history__changes"><div><dt>{fieldLabel("articles")}</dt><dd><span>{value("articles", details.before.articles)}</span><span className="visually-hidden">{t("caseHistory.to")}</span><span aria-hidden="true"> → </span><strong>{value("articles", details.after.articles)}</strong></dd></div></dl></>;
  return <>{details.action && <p>{Object.hasOwn(catalogue.en, `caseHistory.action.${details.action}`) ? t(`caseHistory.action.${details.action}`) : t("caseHistory.recordUpdated")}</p>}{details.reason && <p>{details.reason}</p>}</>;
}

// Retain already-authorized rows only through transport/temporary read failures.
// Unknown server refusals, including authorization failures, must clear them.
function transientHistoryFailure(error) {
  if ([401, 403, 404].includes(error?.status)) return false;
  return !error?.code || ["57014", "55P03", "PGRST000", "PGRST001", "PGRST002", "PGRST003"].includes(error.code);
}

export function CaseHistoryTimeline({ caseId, api, memberOnly = false, scopeKey = null, refreshKey = null, onFirstPageLoaded = null }) {
  const { t, lang } = useLang();
  const heading = useId();
  const generation = useRef(0);
  const activeRequest = useRef(false);
  const scope = useMemo(() => ({ caseId, api, memberOnly, scopeKey }), [caseId, api, memberOnly, scopeKey]);
  const [state, setState] = useState({ scope: null, rows: [], loading: true, error: false, before: null, more: false });
  const load = useCallback(async (before = null) => {
    if (activeRequest.current) return;
    activeRequest.current = true;
    const request = ++generation.current;
    setState((current) => ({ scope, rows: current.scope === scope ? current.rows : [], before, more: current.scope === scope && before ? current.more : false, loading: true, error: false }));
    try {
      const page = await api.loadCaseHistory(caseId, { before });
      if (generation.current !== request) return;
      setState((current) => ({ scope, rows: before ? [...current.rows, ...page.rows] : page.rows, before: page.nextBefore, more: Boolean(page.nextBefore), loading: false, error: false }));
      if (!before) onFirstPageLoaded?.(refreshKey);
    } catch (error) {
      if (generation.current === request) setState((current) => ({ ...current, ...(transientHistoryFailure(error) ? {} : { rows: [], before: null, more: false }), loading: false, error: true }));
    } finally {
      if (generation.current === request) activeRequest.current = false;
    }
  }, [api, caseId, scope, refreshKey, onFirstPageLoaded]);
  useEffect(() => {
    activeRequest.current = false;
    void load();
    return () => { generation.current += 1; activeRequest.current = false; };
  }, [load]);
  const sameScope = state.scope === scope;
  const loading = !sameScope || state.loading;
  const rows = !sameScope ? [] : memberOnly ? state.rows.map(memberHistoryEvent).filter(Boolean) : state.rows;
  return <section className="case-history" aria-labelledby={heading} aria-busy={loading}>
    <div className="case-history__head"><h3 id={heading}>{t("caseHistory.title")}</h3><button className="dialog-secondary" type="button" disabled={loading} onClick={() => void load()}>{t("caseHistory.refresh")}</button></div>
    {loading && <p role="status">{t("caseHistory.loading")}</p>}
    {sameScope && state.error && <div role="alert"><p>{t("caseHistory.error")}</p><button className="dialog-secondary" type="button" onClick={() => void load(state.before)}>{t("caseHistory.retry")}</button></div>}
    {!loading && !state.error && rows.length === 0 && <p>{t("caseHistory.empty")}</p>}
    <ol className="case-history__list">{rows.map((event) => {
      const timestamp = formatEasternTimestamp(event.at, lang);
      return <li key={event.event_id}>
      <span className={`case-history__dot case-history__dot--${event.kind}`} aria-hidden="true" />
      <article><div className="case-history__event-head"><h4>{t(`caseHistory.kind.${event.kind}`)}</h4><time dateTime={timestamp?.dateTime}>{timestamp?.text || t("operations.audit.timeUnavailable")}</time></div><HistoryActor event={event} /><HistoryDetails event={event} /></article>
    </li>;
    })}</ol>
    {sameScope && state.more && !state.error && <button className="dialog-secondary" type="button" disabled={loading} onClick={() => void load(state.before)}>{t("caseHistory.more")}</button>}
  </section>;
}
