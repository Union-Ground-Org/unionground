import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { rpcErrorTextStrict } from "../lib/rpcErrorText.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { managementBehaviorCategories, managementBehaviorWindowDays, managementCategoryMessageKey } from "../lib/configurableThresholds.js";

import { CaseHistoryTimeline } from "./CaseHistoryTimeline.jsx";
import { CaseStewardEmails } from "./CaseStewardEmails.jsx";

const COPY = {
  en: {
    title: "Issue tools", refresh: "Refresh", loading: "Loading issue tools…", unavailable: "Issue tools are unavailable.", retry: "Try again",
    strength: "Strength check", strengthHelp: "Score preparation factors from 0 to 5. Results are saved as history, not legal advice.", score: "Save strength check",
    factors: ["Clear facts", "Documentation", "Timeliness", "Policy or law support", "Witnesses"], latest: "Latest", noScores: "No strength checks yet.",
    restriction: "Restricted access", restrict: "Restrict issue", unrestrict: "Remove restriction", reason: "Reason", restricted: "Restricted", standard: "Standard access", grants: "Explicit access", grantee: "Person in the organization", grant: "Grant access", grantReason: "Reason for access", revoke: "Revoke", noGrants: "No explicit access grants.", grantsCoordinatorOnly: "Granting explicit access is a campaign lead action. Ask a campaign lead to let someone into this issue.", candidatesFailed: "The worker list could not be loaded.",
    caseTitle: "Issue title", newTitle: "New title", renameReason: "Why rename", rename: "Rename issue",
    renameReasons: { clearer_title: "Clearer title", member_request: "Worker asked", correct_error: "Fix a mistake", other: "Other" },
    deadlines: "Deadline center", deadlineLabel: "Deadline label", deadlineKind: "Deadline type", dueAt: "Due date and time", reminderAt: "Reminder (optional)", addDeadline: "Add deadline", noDeadlines: "No deadlines recorded.",
    extensionDate: "Requested extension", extensionReason: "Extension reason", requestExtension: "Request extension", approve: "Approve", deny: "Deny",
    alerts: "Alerts", alertMessage: "Alert message", alertKind: "Alert type", severity: "Severity", escalation: "Escalate if unacknowledged (optional)", addAlert: "Add alert", acknowledge: "Acknowledge", noAlerts: "No active issue alerts.",
    reminders: "Follow-up reminders", reminderTitle: "Reminder", remindAt: "Remind me", recurrence: "Repeat", addReminder: "Add reminder", noReminders: "No follow-up reminders.",
    done: "Done", dismiss: "Dismiss", management: "Management behavior log", managementHelp: "Entries are immutable. Corrections are appended without replacing the original observation.", person: "Management person", personTitle: "Title (optional)", workplace: "Workplace (optional)", occurredAt: "Occurred", category: "Category", summary: "Observation", logBehavior: "Log behavior", addendum: "Add correction or context", add: "Add",
    retaliation: "Retaliation reports", noRetaliation: "No retaliation reports are attached to this issue.",
    graph: "Issue graph", graphHelp: "Link another authorized issue to show the relationship in this issue's graph.", relatedCase: "Related issue", relationship: "Relationship", note: "Note (optional)", link: "Link issues", noLinks: "No related records are linked.",
    none: "Does not repeat", daily: "Daily", weekly: "Weekly", monthly: "Monthly", saved: "Issue tools updated.", failed: "That casework action could not be saved.",
    strengthBand: { needs_evidence: "Needs evidence", developing: "Developing", strong: "Strong" },
    reportStatus: { submitted: "Submitted", in_review: "In review", withdrawn: "Withdrawn", closed: "Closed" },
    reminderStatus: { scheduled: "Scheduled", snoozed: "Snoozed", completed: "Completed", dismissed: "Dismissed" },
    deadlineStatus: { active: "Active", met: "Met", extended: "Extended", waived: "Waived", missed: "Missed" },
    escalationFlag: { overdue: "Escalated: overdue", critical_deadline: "Escalated: due within {hours} hours" },
    extensionStatus: { requested: "Requested", approved: "Approved", denied: "Denied" },
  },
  es: {
    title: "Herramientas del asunto", refresh: "Actualizar", loading: "Cargando herramientas…", unavailable: "Las herramientas del asunto no están disponibles.", retry: "Intentar de nuevo",
    strength: "Evaluación de fortaleza", strengthHelp: "Califica de 0 a 5. Los resultados se guardan como historial; no son asesoría legal.", score: "Guardar evaluación",
    factors: ["Hechos claros", "Documentación", "Plazos", "Respaldo en política o ley", "Testigos"], latest: "Más reciente", noScores: "Aún no hay evaluaciones.",
    restriction: "Acceso restringido", restrict: "Restringir asunto", unrestrict: "Quitar restricción", reason: "Motivo", restricted: "Restringido", standard: "Acceso estándar", grants: "Acceso explícito", grantee: "Persona de la organización", grant: "Conceder acceso", grantReason: "Motivo del acceso", revoke: "Revocar", noGrants: "No hay concesiones de acceso explícitas.", grantsCoordinatorOnly: "Conceder acceso explícito corresponde al liderazgo de campaña. Pide a alguien del liderazgo de campaña que conceda acceso a este asunto.", candidatesFailed: "No se pudo cargar la lista de trabajadores.",
    caseTitle: "Título del asunto", newTitle: "Nuevo título", renameReason: "Motivo del cambio", rename: "Cambiar título",
    renameReasons: { clearer_title: "Título más claro", member_request: "Lo pidió el trabajador/a", correct_error: "Corregir un error", other: "Otro" },
    deadlines: "Centro de plazos", deadlineLabel: "Nombre del plazo", deadlineKind: "Tipo de plazo", dueAt: "Fecha y hora límite", reminderAt: "Recordatorio (opcional)", addDeadline: "Agregar plazo", noDeadlines: "No hay plazos registrados.",
    extensionDate: "Prórroga solicitada", extensionReason: "Motivo de la prórroga", requestExtension: "Solicitar prórroga", approve: "Aprobar", deny: "Denegar",
    alerts: "Alertas", alertMessage: "Mensaje de alerta", alertKind: "Tipo de alerta", severity: "Prioridad", escalation: "Escalar si no se confirma (opcional)", addAlert: "Agregar alerta", acknowledge: "Confirmar", noAlerts: "No hay alertas activas.",
    reminders: "Recordatorios de seguimiento", reminderTitle: "Recordatorio", remindAt: "Recordarme", recurrence: "Repetir", addReminder: "Agregar recordatorio", noReminders: "No hay recordatorios.",
    done: "Terminar", dismiss: "Descartar", management: "Registro de conducta gerencial", managementHelp: "Las entradas son inmutables. Las correcciones se agregan sin reemplazar la observación original.", person: "Persona de la gerencia", personTitle: "Cargo (opcional)", workplace: "Lugar de trabajo (opcional)", occurredAt: "Ocurrió", category: "Categoría", summary: "Observación", logBehavior: "Registrar conducta", addendum: "Agregar corrección o contexto", add: "Agregar",
    retaliation: "Informes de represalias", noRetaliation: "No hay informes de represalias vinculados a este asunto.",
    graph: "Grafo del asunto", graphHelp: "Vincula otro asunto autorizado para mostrar la relación en el grafo.", relatedCase: "Asunto relacionado", relationship: "Relación", note: "Nota (opcional)", link: "Vincular asuntos", noLinks: "No hay registros relacionados.",
    none: "No repetir", daily: "Diariamente", weekly: "Semanalmente", monthly: "Mensualmente", saved: "Herramientas del asunto actualizadas.", failed: "No se pudo guardar esa acción.",
    strengthBand: { needs_evidence: "Necesita evidencia", developing: "En desarrollo", strong: "Fuerte" },
    reportStatus: { submitted: "Enviado", in_review: "En revisión", withdrawn: "Retirado", closed: "Cerrado" },
    reminderStatus: { scheduled: "Programado", snoozed: "Pospuesto", completed: "Completado", dismissed: "Descartado" },
    deadlineStatus: { active: "Activo", met: "Cumplido", extended: "Prorrogado", waived: "Dispensado", missed: "Incumplido" },
    escalationFlag: { overdue: "Escalado: vencido", critical_deadline: "Escalado: vence en menos de {hours} horas" },
    extensionStatus: { requested: "Solicitada", approved: "Aprobada", denied: "Denegada" },
  },
};

function dateTime(value, lang) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return formatGroupMoment(parsed, lang) || "—";
}

function formValue(form, key) {
  return String(new FormData(form).get(key) || "").trim();
}

function enumLabel(labels, value) {
  const key = String(value ?? "");
  if (Object.prototype.hasOwnProperty.call(labels || {}, key)) return labels[key];
  return key.replaceAll("_", " ");
}

function statusOptions(labels) {
  return Object.entries(labels).map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>);
}

// Select option text is catalogue copy; the option values stay the stored
// tokens. Deadline kinds, alert kinds and severities reuse the keys the case
// history timeline and the case macro editor already show for the same
// stored values, so one value reads the same on every casework surface.
// Union Ground offers only the response and follow-up kinds: filing,
// hearing and appeal clocks belong to a grievance procedure and a legal
// filing window, which a campaign without a contract does not have (owner
// decision, 2026-10-13). A stored value of another kind still reads through
// enumLabel.
const OPTION_KEYS = {
  deadlineKindLabels: ["caseHistory.value.kind", ["response", "follow_up"]],
  alertKindLabels: ["caseMacros.alert", ["deadline", "safety", "retaliation", "legal", "stalled", "custom"]],
  alertSeverity: ["caseMacros.severity", ["info", "warning", "critical"]],
};

// Management behavior categories are the organization's
// lists.casework.management_behavior_categories (REQ-UG-CONFIGURABLE-
// THRESHOLDS-20261001). A stored value with a catalogue entry (the original six
// tokens and the old default list) reads in the member's language; anything an
// admin typed reads as typed.
function managementCategoryLabel(t, category) {
  const key = managementCategoryMessageKey(category);
  const label = key ? t(key) : "";
  return label && label !== key ? label : String(category ?? "");
}

function optionLabels(t) {
  return Object.fromEntries(Object.entries(OPTION_KEYS).map(([name, [prefix, tokens]]) => [
    name,
    Object.fromEntries(tokens.map((token) => [token, t(`${prefix}.${token}`)])),
  ]));
}

function reminderRecurrenceLabels(copy) {
  return { none: copy.none, daily: copy.daily, weekly: copy.weekly, monthly: copy.monthly };
}

// casework_strength_analyses.band is needs_evidence, developing, or strong.
// Own-property lookup only: a token named "__proto__" or "constructor" must
// not resolve through Object.prototype, and any other stored value uses the
// generic catalogue label instead of the English storage words.
const STRENGTH_BANDS = Object.freeze({
  needs_evidence: "casework.strengthBand.needs_evidence",
  developing: "casework.strengthBand.developing",
  strong: "casework.strengthBand.strong",
});

function strengthBandLabel(translate, band) {
  const stored = typeof band === "string" ? band : "";
  if (!Object.hasOwn(STRENGTH_BANDS, stored)) return translate("casework.strengthBand.unknown");
  const label = translate(STRENGTH_BANDS[stored]);
  return typeof label === "string" ? label : translate("casework.strengthBand.unknown");
}

export function CaseworkOperationsPanel({ caseId, caseOptions = [], api, onNotice = () => {}, onChanged = null, organizationConfiguration = null, historyRefreshKey = 0 }) {
  const { lang, t } = useLang();
  const c = useMemo(() => ({ ...(COPY[lang] || COPY.en), ...optionLabels(t) }), [lang, t]);
  const managementCategories = useMemo(() => managementBehaviorCategories(organizationConfiguration), [organizationConfiguration]);
  const managementWindow = managementBehaviorWindowDays(organizationConfiguration);
  const [managementCounts, setManagementCounts] = useState(null);
  const scope = useMemo(() => ({ api, caseId }), [api, caseId]);
  const activeScope = useRef(null);
  const requestGeneration = useRef(0);
  const [result, setState] = useState({ loading: true, error: false, data: null });
  const state = result.scope === scope ? result : { loading: true, error: false, data: null };
  const [busy, setBusy] = useState("");
  const [accessCandidates, setAccessCandidates] = useState([]);
  // "loading" | "ready" | "forbidden" | "failed". The candidate read is
  // list_member_case_assignment_candidates, which refuses anyone without a
  // coordinator or admin role with 42501 even though casework_grant_access
  // itself accepts a steward. Collapsing that refusal into an empty list left
  // a steward a required picker holding only the placeholder, so a refusal
  // says the grant is a coordinator action and any other failure offers a
  // retry instead of the form.
  const [candidatesStatus, setCandidatesStatus] = useState("loading");
  const [candidatesRevision, setCandidatesRevision] = useState(0);


  useLayoutEffect(() => {
    activeScope.current = scope;
    setBusy("");
    setAccessCandidates([]);
    setCandidatesStatus("loading");
    return () => {
      activeScope.current = null;
      requestGeneration.current += 1;
    };
  }, [scope]);

  const load = useCallback(async () => {
    if (activeScope.current !== scope) return;
    const generation = ++requestGeneration.current;
    setState((current) => ({ ...(current.scope === scope ? current : {}), scope, loading: true, error: false }));
    try {
      const data = await api.loadCaseworkCase(caseId);
      if (activeScope.current !== scope || generation !== requestGeneration.current) return;
      setState((current) => ({ scope, loading: false, error: false, data, historyRevision: (current.historyRevision || 0) + 1 }));
    } catch {
      if (activeScope.current === scope && generation === requestGeneration.current) setState({ scope, loading: false, error: true, data: null });
    }
  }, [api, caseId, scope]);
  useEffect(() => { void load(); }, [load]);
  const managementPeople = useMemo(() => {
    const people = new Map();
    for (const entry of state.data?.management ?? []) {
      const person = entry.casework_management_people;
      if (person?.id && !people.has(person.id)) people.set(person.id, person.display_name || "");
    }
    return people;
  }, [state.data]);
  useEffect(() => {
    let live = true;
    setManagementCounts(null);
    if (typeof api.loadManagementWindow !== "function" || managementPeople.size === 0) return () => { live = false; };
    api.loadManagementWindow([...managementPeople.keys()], managementWindow)
      .then((counts) => { if (live && activeScope.current === scope) setManagementCounts(counts && typeof counts === "object" ? counts : null); })
      .catch(() => { if (live && activeScope.current === scope) setManagementCounts(null); });
    return () => { live = false; };
  }, [api, managementPeople, managementWindow, scope]);
  useEffect(() => {
    let live = true;
    if (!api.loadAccessCandidates) return () => { live = false; };
    setCandidatesStatus("loading");
    api.loadAccessCandidates(caseId).then((rows) => {
      if (!live || activeScope.current !== scope) return;
      setAccessCandidates(Array.isArray(rows) ? rows : []);
      setCandidatesStatus("ready");
    }).catch((error) => {
      if (!live || activeScope.current !== scope) return;
      setAccessCandidates([]);
      setCandidatesStatus(error?.code === "42501" ? "forbidden" : "failed");
    });
    return () => { live = false; };
  }, [api, caseId, candidatesRevision, scope]);

  async function run(key, work, form = null) {
    if (busy || activeScope.current !== scope || !state.data) return;
    setBusy(key);
    try {
      await work();
      // The write has committed for its own case, so its access-history entry
      // is still recorded after the coordinator opened another case. onChanged
      // is this render's, the write's own case; only what shows on screen
      // (form, notice, reload) stays with the case shown.
      if (activeScope.current !== scope) { await onChanged?.(); return; }
      form?.reset();
      // The write has already committed, so the access-history entry is
      // recorded before the panel refresh: a reload that stalls or is
      // abandoned must not leave a changed case with no entry. The saved
      // notice goes first because onChanged replaces it when the entry is
      // refused, and load() still runs on either outcome.
      onNotice(c.saved);
      try {
        await onChanged?.();
      } finally {
        await load();
      }
    } catch (error) {
      // A refused write arrives as raw database policy text; the notice must
      // stay catalogue copy in the member's own language.
      if (activeScope.current === scope) onNotice(rpcErrorTextStrict(t, error, c.failed));
    } finally {
      if (activeScope.current === scope) setBusy("");
    }
  }

  if (state.loading && !state.data) return <section className="cwk-panel"><p className="cwk-empty" role="status">{c.loading}</p></section>;
  if (state.error || !state.data) return <section className="cwk-panel"><p className="cwk-empty" role="status">{c.unavailable}</p><button className="cwk-btn cwk-btn--soft" type="button" onClick={load}>{c.retry}</button></section>;
  const data = state.data;
  const latestScore = data.strength[0];

  return (
    <section className="cwk-panel" aria-labelledby="casework-operations-title">
      <div className="cwk-panel__head">
        <h2 className="cwk-panel__title" id="casework-operations-title">{c.title}</h2>
        <button className="cwk-btn cwk-btn--ghost" type="button" disabled={state.loading || Boolean(busy)} onClick={load}>{c.refresh}</button>
      </div>

      {/* A note or articles saved beside the panel (StewardView) bumps
          historyRefreshKey, so the history reads the new row. */}
      {api.loadCaseHistory && <CaseHistoryTimeline caseId={caseId} api={api} refreshKey={`${state.historyRevision}:${historyRefreshKey}`} />}
      {api.loadCaseStewardEmails && <CaseStewardEmails caseId={caseId} api={api} />}

      <div className="thread-list">
        <article className="thread-message thread-message--steward">
          <h3>{c.strength}</h3>
          <p>{c.strengthHelp}</p>
          {latestScore ? <p><strong>{c.latest}: {latestScore.score}/100 · {strengthBandLabel(t, latestScore.band)}</strong></p> : <p>{c.noScores}</p>}
          {/* The suggested score is left out: it was computed from contract
              clause matches and a grievance filing window, neither of which a
              Union Ground issue has (owner decision, 2026-10-13). */}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            // The stored id stays contract_support; before a first contract an
            // issue is backed by a written policy or a law, so the label says
            // so.
            const inputs = Object.fromEntries(c.factors.map((_, index) => [
              ["facts", "documentation", "timeliness", "contract_support", "witnesses"][index],
              Number(formValue(form, `factor-${index}`)),
            ]));
            void run("score", () => api.scoreCase(caseId, inputs), form);
          }}>
            {c.factors.map((label, index) => <label key={label}>{label}<select name={`factor-${index}`} defaultValue="3">{[0, 1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>)}
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{c.score}</button>
          </form>
        </article>

        <article className="thread-message thread-message--steward">
          <h3>{c.restriction}</h3>
          <p><span className={`cwk-chip ${data.scope.is_restricted ? "cwk-chip--new" : "cwk-chip--rest"}`}>{data.scope.is_restricted ? c.restricted : c.standard}</span></p>
          {data.scope.restriction_reason && <p>{data.scope.restriction_reason}</p>}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("restriction", () => api.setCaseRestriction(caseId, !data.scope.is_restricted, formValue(form, "reason")), form);
          }}>
            {!data.scope.is_restricted && <label>{c.reason}<textarea name="reason" minLength={8} maxLength={500} required /></label>}
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{data.scope.is_restricted ? c.unrestrict : c.restrict}</button>
          </form>
          {data.scope.is_restricted && api.grantCaseAccess && <><h4>{c.grants}</h4>{(data.accessGrants || []).filter((grant) => !grant.revoked_at).length === 0 && <p>{c.noGrants}</p>}{(data.accessGrants || []).filter((grant) => !grant.revoked_at).map((grant) => <p key={grant.id}>{accessCandidates.find((person) => person.userId === grant.grantee_user_id)?.fullName || grant.grantee_user_id}<button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void run(`revoke-${grant.id}`, () => api.revokeCaseAccess(grant.id))}>{c.revoke}</button></p>)}{candidatesStatus === "forbidden" && <p>{c.grantsCoordinatorOnly}</p>}{candidatesStatus === "failed" && <p>{c.candidatesFailed} <button className="cwk-btn cwk-btn--ghost" type="button" onClick={() => setCandidatesRevision((value) => value + 1)}>{c.retry}</button></p>}{(candidatesStatus === "ready" || !api.loadAccessCandidates) && <form className="stack-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run("grant-access", () => api.grantCaseAccess(caseId, formValue(form, "grantee"), formValue(form, "grantReason")), form); }}><label>{c.grantee}<select name="grantee" required defaultValue=""><option value="" disabled>—</option>{accessCandidates.map((person) => <option key={person.userId} value={person.userId}>{person.fullName} · {(person.roles || []).join(", ")}</option>)}</select></label><label>{c.grantReason}<textarea name="grantReason" minLength={8} maxLength={500} required /></label><button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)}>{c.grant}</button></form>}</>}
        </article>

        {api.renameCase && <article className="thread-message thread-message--steward">
          <h3>{c.caseTitle}</h3>
          <p><strong>{data.scope.title}</strong></p>
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("rename", () => api.renameCase(caseId, formValue(form, "title").trim(), formValue(form, "reason")), form);
          }}>
            <label>{c.newTitle}<input name="title" minLength={1} maxLength={200} required /></label>
            <label>{c.renameReason}<select name="reason" defaultValue="clearer_title">{Object.entries(c.renameReasons).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{c.rename}</button>
          </form>
        </article>}

        {/* Union Ground issues have no grievance procedure (owner decision,
            2026-10-13): no step progression, no stage checklists, and no
            retaliation flag with an unfair labor practice filing deadline. */}
        <article className="thread-message thread-message--steward">
          <h3>{c.deadlines}</h3>
          {data.deadlines.length === 0 && <p>{c.noDeadlines}</p>}
          {data.deadlines.map((deadline) => <DeadlineItem key={deadline.id} deadline={deadline} api={api} run={run} busy={busy} copy={c} lang={lang} t={t} />)}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("deadline", () => api.createCaseDeadline(data.scope, {
              kind: formValue(form, "kind"), label: formValue(form, "label"),
              dueAt: new Date(formValue(form, "dueAt")).toISOString(),
              reminderAt: formValue(form, "reminderAt") ? new Date(formValue(form, "reminderAt")).toISOString() : null,
            }), form);
          }}>
            <label>{c.deadlineLabel}<input name="label" minLength={3} maxLength={200} required /></label>
            <label>{c.deadlineKind}<select name="kind">{statusOptions(c.deadlineKindLabels)}</select></label>
            <label>{c.dueAt}<input name="dueAt" type="datetime-local" required /></label>
            <label>{c.reminderAt}<input name="reminderAt" type="datetime-local" /></label>
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{c.addDeadline}</button>
          </form>
        </article>

        <article className="thread-message thread-message--steward">
          <h3>{c.alerts}</h3>
          {data.alerts.length === 0 && <p>{c.noAlerts}</p>}
          {data.alerts.map((alert) => <div key={alert.id}><p><span className={`cwk-chip ${alert.severity === "critical" ? "cwk-chip--new" : "cwk-chip--rest"}`}>{enumLabel(c.alertSeverity, alert.severity)}</span> {alert.message}</p>{alert.status === "open" && <button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)} type="button" onClick={() => void run(`alert-${alert.id}`, () => api.acknowledgeCaseAlert(alert.id))}>{c.acknowledge}</button>}</div>)}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("alert", () => api.createCaseAlert(data.scope, {
              kind: formValue(form, "kind"), severity: formValue(form, "severity"), message: formValue(form, "message"),
              escalationDueAt: formValue(form, "escalation") ? new Date(formValue(form, "escalation")).toISOString() : null,
            }), form);
          }}>
            <label>{c.alertMessage}<textarea name="message" minLength={3} maxLength={1000} required /></label>
            <label>{c.alertKind}<select name="kind">{statusOptions(c.alertKindLabels)}</select></label>
            <label>{c.severity}<select name="severity">{statusOptions(c.alertSeverity)}</select></label>
            <label>{c.escalation}<input name="escalation" type="datetime-local" /></label>
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{c.addAlert}</button>
          </form>
        </article>

        <article className="thread-message thread-message--steward">
          <h3>{c.management}</h3>
          <p>{c.managementHelp}</p>
          {managementCounts && managementPeople.size > 0 && <ul className="cwk-management-window">
            {[...managementPeople.entries()].map(([personId, name]) => <li key={personId}>{t("casework.tools.managementWindow", { name, count: managementCounts[personId] ?? 0, days: managementWindow })}</li>)}
          </ul>}
          {data.management.map((entry) => <section key={entry.id}><p><strong>{entry.casework_management_people?.display_name}</strong> · {managementCategoryLabel(t, entry.category)}<br /><small>{dateTime(entry.occurred_at, lang)}</small><br />{entry.summary}</p>{entry.casework_management_addenda?.map((item) => <p key={item.id}><small>{dateTime(item.created_at, lang)}</small><br />↳ {item.body}</p>)}<form className="stack-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run(`addendum-${entry.id}`, () => api.addManagementAddendum(entry.id, formValue(form, "addendum")), form); }}><label>{c.addendum}<input name="addendum" minLength={3} maxLength={4000} required /></label><button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)}>{c.add}</button></form></section>)}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("management", () => api.logManagementBehavior(caseId, { displayName: formValue(form, "person"), title: formValue(form, "personTitle"), workplace: formValue(form, "workplace"), occurredAt: new Date(formValue(form, "occurredAt")).toISOString(), category: formValue(form, "category"), summary: formValue(form, "summary") }), form);
          }}>
            <label>{c.person}<input name="person" minLength={2} maxLength={200} required /></label>
            <label>{c.personTitle}<input name="personTitle" maxLength={200} /></label>
            <label>{c.workplace}<input name="workplace" maxLength={200} /></label>
            <label>{c.occurredAt}<input name="occurredAt" type="datetime-local" required /></label>
            <label>{c.category}<select name="category">{managementCategories.map((category) => <option key={category} value={category}>{managementCategoryLabel(t, category)}</option>)}</select></label>
            <label>{c.summary}<textarea name="summary" minLength={8} maxLength={4000} required /></label>
            <button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy)}>{c.logBehavior}</button>
          </form>
        </article>

        <article className="thread-message thread-message--steward">
          <h3>{c.retaliation}</h3>
          {data.retaliation.length === 0 ? <p>{c.noRetaliation}</p> : data.retaliation.map((report) => <p key={report.id}><span className={`cwk-chip ${report.status === "submitted" ? "cwk-chip--new" : "cwk-chip--rest"}`}>{enumLabel(c.reportStatus, report.status)}</span> <strong>{report.management_person}</strong><br /><small>{dateTime(report.incident_at, lang)}</small><br />{report.protected_activity}<br />{report.adverse_action}</p>)}
        </article>


        <article className="thread-message thread-message--steward">
          <h3>{c.reminders}</h3>
          {data.reminders.length === 0 && <p>{c.noReminders}</p>}
          {data.reminders.map((item) => <div key={item.id}><p><strong>{item.title}</strong><br /><small>{dateTime(item.remind_at, lang)} · {enumLabel(reminderRecurrenceLabels(c), item.recurrence)} · {enumLabel(c.reminderStatus, item.status)}</small></p>{!['completed', 'dismissed'].includes(item.status) && <p><button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void run(`reminder-done-${item.id}`, () => api.setReminderStatus(item.id, "completed"))}>{c.done}</button><button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void run(`reminder-dismiss-${item.id}`, () => api.setReminderStatus(item.id, "dismissed"))}>{c.dismiss}</button></p>}</div>)}
          <form className="stack-form" onSubmit={(event) => {
            event.preventDefault(); const form = event.currentTarget;
            void run("reminder", () => api.createCaseReminder(data.scope, { title: formValue(form, "title"), remindAt: new Date(formValue(form, "remindAt")).toISOString(), recurrence: formValue(form, "recurrence") }), form);
          }}>
            <label>{c.reminderTitle}<input name="title" minLength={3} maxLength={200} required /></label>
            <label>{c.remindAt}<input name="remindAt" type="datetime-local" required /></label>
            <label>{c.recurrence}<select name="recurrence"><option value="none">{c.none}</option><option value="daily">{c.daily}</option><option value="weekly">{c.weekly}</option><option value="monthly">{c.monthly}</option></select></label>
            <button className="cwk-btn cwk-btn--soft" type="submit" disabled={Boolean(busy)}>{c.addReminder}</button>
          </form>
        </article>

        <article className="thread-message thread-message--steward">
          <h3>{c.graph}</h3>
          <p>{c.graphHelp}</p>
          {data.links.length === 0 ? <p>{c.noLinks}</p> : <ul>{data.links.map((item) => <li key={item.id}><strong>{item.relationship}</strong> → {caseOptions.find((entry) => entry.id === item.target_case_id)?.reference || item.target_kind}<br />{item.note}</li>)}</ul>}
          <form className="stack-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run("case-link", () => api.linkCases(caseId, formValue(form, "targetCaseId"), formValue(form, "relationship"), formValue(form, "note")), form); }}>
            <label>{c.relatedCase}<select name="targetCaseId" required defaultValue=""><option value="" disabled>—</option>{caseOptions.filter((item) => item.id !== caseId).map((item) => <option value={item.id} key={item.id}>{item.reference} · {item.title}</option>)}</select></label>
            <label>{c.relationship}<input name="relationship" minLength={3} maxLength={200} required /></label>
            <label>{c.note}<textarea name="note" minLength={3} maxLength={2000} /></label>
            <button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy)}>{c.link}</button>
          </form>
        </article>
      </div>
    </section>
  );
}

// BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: the reminder
// line says whether the minute sweep has sent it, and staff can record the
// outcome the sweep cannot know (met, waived) or reopen a deadline.
function DeadlineStatusControls({ deadline, api, run, busy, t }) {
  if (!api.setDeadlineStatus) return null;
  const open = ["active", "extended", "missed"].includes(deadline.status);
  const settled = ["met", "waived", "missed"].includes(deadline.status);
  const set = (status) => void run(`deadline-status-${deadline.id}-${status}`, () => api.setDeadlineStatus(deadline.id, status));
  return <p>
    {open && <button className="cwk-btn cwk-btn--soft" type="button" disabled={Boolean(busy)} onClick={() => set("met")}>{t("caseworkDeadlines.markMet")}</button>}
    {open && <button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => set("waived")}>{t("caseworkDeadlines.waive")}</button>}
    {settled && <button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => set("active")}>{t("caseworkDeadlines.reopen")}</button>}
  </p>;
}

// The reminder line tells staff what the sweep actually did: sent (with the
// send time), not sent and why, or still scheduled.
const REMINDER_NOT_SENT = ["expired", "suppressed", "no_recipient"];
function deadlineReminderText(deadline, t, lang) {
  if (deadline.reminder_disposition === "sent" && deadline.reminder_sent_at) {
    return t("caseworkDeadlines.reminderSent", { date: dateTime(deadline.reminder_sent_at, lang) });
  }
  if (REMINDER_NOT_SENT.includes(deadline.reminder_disposition)) {
    return t(`caseworkDeadlines.reminderNotSent.${deadline.reminder_disposition}`, { date: dateTime(deadline.reminder_at, lang) });
  }
  return t("caseworkDeadlines.reminderScheduled", { date: dateTime(deadline.reminder_at, lang) });
}

function DeadlineItem({ deadline, api, run, busy, copy, lang, t }) {
  return <div><p><strong>{deadline.label}</strong><br /><small>{dateTime(deadline.due_at, lang)} · {enumLabel(copy.deadlineStatus, deadline.status)}</small>{deadline.reminder_at && <><br /><small>{deadlineReminderText(deadline, t, lang)}</small></>}<EscalationBadge escalation={deadline.escalation} copy={copy} /></p><DeadlineStatusControls deadline={deadline} api={api} run={run} busy={busy} t={t} />{deadline.extensions.map((extension) => <p key={extension.id}><small>{enumLabel(copy.extensionStatus, extension.status)}: {dateTime(extension.requested_due_at, lang)}</small>{extension.status === "requested" && <><button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void run(`approve-${extension.id}`, () => api.decideDeadlineExtension(extension.id, "approved"))}>{copy.approve}</button><button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={() => void run(`deny-${extension.id}`, () => api.decideDeadlineExtension(extension.id, "denied"))}>{copy.deny}</button></>}</p>)}<form className="stack-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run(`extension-${deadline.id}`, () => api.requestDeadlineExtension(deadline.id, new Date(formValue(form, "extensionDate")).toISOString(), formValue(form, "extensionReason")), form); }}><label>{copy.extensionDate}<input name="extensionDate" type="datetime-local" required /></label><label>{copy.extensionReason}<input name="extensionReason" minLength={8} maxLength={2000} required /></label><button className="cwk-btn cwk-btn--ghost" type="submit" disabled={Boolean(busy)}>{copy.requestExtension}</button></form></div>;
}

// REQ-UG-GC-ESCALATION-FLAGS-20261001: the coordinator badge the server's
// escalation flag carries (old gc-tasks-panel reason badge).
function EscalationBadge({ escalation, copy }) {
  if (!escalation || !copy.escalationFlag?.[escalation.reason]) return null;
  return <><br /><small className="cwk-chip cwk-chip--new" role="status">{copy.escalationFlag[escalation.reason].replace("{hours}", String(escalation.dueHours))}</small></>;
}
