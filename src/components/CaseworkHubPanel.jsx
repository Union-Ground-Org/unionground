import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { sharedStatus } from "../lib/caseSelection.js";
import { caseTypeLabel } from "../lib/caseRowLine.js";
import { rpcErrorTextStrict } from "../lib/rpcErrorText.js";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";
import "./caseworkHubPanel.css";

const COPY = {
  en: {
    retry: "Try again", refresh: "Refresh", failed: "That casework action could not be saved.",
    bargaining: "Bargaining", bargainingHelp: "Track proposals, response clocks, the live timeline, and team pulse in one workspace.", noWorkspaces: "No bargaining workspace has been created for this campaign.", workspaceTitle: "Workspace title", proposalTitle: "Proposal title", startsAt: "Session starts (optional)", createWorkspace: "Create workspace", sessionStatus: "Session status", update: "Update", proposal: "New proposal", side: "Side", body: "Proposal text", responseDue: "Response due (optional)", addProposal: "Add proposal", proposalStatus: "Proposal status", countdown: "Response clock", noDue: "No response clock", liveUpdate: "Live timeline update", pulse: "Team pulse", addUpdate: "Add update", noTimeline: "No live updates yet.",
    intake: "Intake draft autosave", intakeHelp: "Draft recovery uses optimistic revisions. Link a issue to carry assignment context without copying sensitive issue content.", draftTitle: "Draft title", draftNotes: "Intake notes", linkedCase: "Linked issue (optional)", saving: "Saving…", savedAt: "Saved", emptyDraft: "Start typing to create an autosaved draft.",
    patterns: "Retaliation pattern review", patternHelp: "Scan authorized reports for repeated management-person patterns across the campaign's rolling three-year history.", scan: "Scan reports", noPatterns: "No repeated pattern is currently flagged.", reports: "reports", status: "Review status", disposition: "Disposition", note: "Investigation note (optional)", saveReview: "Save review",
    overdue: "{hours}h overdue", hoursRemaining: "{hours}h remaining", daysRemaining: "{days}d remaining",
    history: "Advanced issue operations", historyHelp: "Search current and historical assigned issues, apply the full issue filters, and update a bounded selection.", search: "Search reference or title", caseType: "Issue type", caseStatus: "Issue status", access: "Access", all: "All", active: "Active", resolved: "Resolved", restricted: "Restricted", standard: "Standard", apply: "Apply filters", selected: "selected", nextStatus: "New status", bulkUpdate: "Update selected", noCases: "No issues match these filters.", previous: "Previous", next: "Next", showing: "Showing", of: "of",
    caseStatusLabel: { active: "Active", resolved: "Resolved" }, caseStatusUnknown: "Status unavailable",
    unnamedPattern: "Pattern",
    tools: "Jump to a tool", openWorkspace: "Open workspace", hideWorkspace: "Hide workspace", workspaces: "workspaces",
    proposalCount: { one: "{count} proposal", other: "{count} proposals" }, overdueCount: "{count} overdue",
  },
  es: {
    retry: "Intentar de nuevo", refresh: "Actualizar", failed: "No se pudo guardar esa acción.",
    bargaining: "Negociación", bargainingHelp: "Sigue propuestas, plazos de respuesta, cronología en vivo y pulso del equipo en un espacio.", noWorkspaces: "No hay un espacio de negociación para esta campaña.", workspaceTitle: "Nombre del espacio", proposalTitle: "Título de la propuesta", startsAt: "Inicio de sesión (opcional)", createWorkspace: "Crear espacio", sessionStatus: "Estado de la sesión", update: "Actualizar", proposal: "Nueva propuesta", side: "Parte", body: "Texto de la propuesta", responseDue: "Respuesta límite (opcional)", addProposal: "Agregar propuesta", proposalStatus: "Estado de propuesta", countdown: "Reloj de respuesta", noDue: "Sin plazo de respuesta", liveUpdate: "Actualización en vivo", pulse: "Pulso del equipo", addUpdate: "Agregar actualización", noTimeline: "Aún no hay actualizaciones.",
    intake: "Autoguardado de borrador", intakeHelp: "La recuperación usa revisiones optimistas. Vincula un asunto para conservar el contexto de asignación sin copiar contenido sensible.", draftTitle: "Título del borrador", draftNotes: "Notas de admisión", linkedCase: "Asunto vinculado (opcional)", saving: "Guardando…", savedAt: "Guardado", emptyDraft: "Empieza a escribir para crear un borrador autoguardado.",
    patterns: "Revisión de patrones de represalias", patternHelp: "Analiza informes autorizados para detectar patrones repetidos de personas gerenciales en el historial móvil de tres años.", scan: "Analizar informes", noPatterns: "No hay patrones repetidos marcados.", reports: "informes", status: "Estado de revisión", disposition: "Disposición", note: "Nota de investigación (opcional)", saveReview: "Guardar revisión",
    overdue: "hace {hours} h", hoursRemaining: "quedan {hours} h", daysRemaining: "quedan {days} d",
    history: "Operaciones avanzadas de asuntos", historyHelp: "Busca asuntos asignados actuales e históricos, aplica todos los filtros y actualiza una selección limitada.", search: "Buscar referencia o título", caseType: "Tipo de asunto", caseStatus: "Estado del asunto", access: "Acceso", all: "Todos", active: "Activos", resolved: "Resueltos", restricted: "Restringido", standard: "Estándar", apply: "Aplicar filtros", selected: "seleccionados", nextStatus: "Nuevo estado", bulkUpdate: "Actualizar selección", noCases: "Ningún asunto coincide con los filtros.", previous: "Anterior", next: "Siguiente", showing: "Mostrando", of: "de",
    caseStatusLabel: { active: "Activo", resolved: "Resuelto" }, caseStatusUnknown: "Estado no disponible",
    unnamedPattern: "Patrón",
    tools: "Ir a una herramienta", openWorkspace: "Abrir espacio", hideWorkspace: "Ocultar espacio", workspaces: "espacios",
    proposalCount: { one: "{count} propuesta", other: "{count} propuestas" }, overdueCount: "{count} vencidas",
  },
};

function value(form, name) { return String(new FormData(form).get(name) || "").trim(); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function stamp(value, lang) { return value ? formatGroupMoment(value, lang) || "—" : "—"; }
function fill(template, vars) { return template.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match); }
function enumLabel(labels, value) {
  const key = String(value ?? "");
  if (Object.prototype.hasOwnProperty.call(labels || {}, key)) return labels[key];
  return key.replaceAll("_", " ");
}
function statusOptions(labels) {
  return Object.entries(labels).map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>);
}
// Select option text is catalogue copy under casework.hub.<group>.<token>; the
// option values stay the stored tokens.
const OPTION_TOKENS = {
  workspaceStatus: ["session", ["planning", "live", "paused", "tentative_agreement", "closed"]],
  proposalStatus: ["proposal", ["draft", "proposed", "countered", "tentative", "accepted", "rejected", "withdrawn"]],
  proposalSide: ["side", ["union", "management", "joint"]],
  pulse: ["pulse", ["steady", "watch", "urgent"]],
  patternStatus: ["review", ["flagged", "investigating", "substantiated", "dismissed"]],
};
function optionLabels(t) {
  return Object.fromEntries(Object.entries(OPTION_TOKENS).map(([name, [group, tokens]]) => [
    `${name}Labels`,
    Object.fromEntries(tokens.map((token) => [token, t(`casework.hub.${group}.${token}`)])),
  ]));
}
// A timeline chip names the event in the reader's language: the team pulse
// when the update carries one, otherwise the event type. The stored codes stay
// in the chip's title for operators.
const EVENT_TYPE_TOKENS = ["note", "proposal_status", "session_status", "pulse"];
function eventTypeLabels(t) {
  return Object.fromEntries(EVENT_TYPE_TOKENS.map((token) => [token, t(`casework.hub.event.${token}`)]));
}
function eventChip(event, c) {
  const labels = event.pulse ? c.pulseLabels : c.eventTypeLabels;
  const token = event.pulse || event.event_type;
  return {
    label: Object.hasOwn(labels, token) ? labels[token] : c.eventUnknown,
    code: [event.event_type, event.pulse].filter(Boolean).join(" · "),
  };
}
function intakeDraftFields(chapterId, payload) {
  if (!payload.title.trim() && !payload.notes.trim()) return null;
  return { chapterId, caseId: payload.caseId || null, payload: { title: payload.title, notes: payload.notes } };
}
function sameIntakeDraftFields(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.chapterId === right.chapterId
    && (left.caseId || null) === (right.caseId || null)
    && left.payload.title === right.payload.title
    && left.payload.notes === right.payload.notes;
}
// The chip shows a singular label; the filter options above use the plural
// forms. An unrecognised token gets a generic label instead of the raw value.
function caseStatusLabel(status, c) {
  return Object.hasOwn(c.caseStatusLabel, status) ? c.caseStatusLabel[status] : c.caseStatusUnknown;
}
function countdown(value, c) {
  if (!value) return c.noDue;
  const hours = Math.ceil((new Date(value).getTime() - Date.now()) / 3600000);
  if (hours <= 0) return fill(c.overdue, { hours: Math.abs(hours) });
  if (hours < 48) return fill(c.hoursRemaining, { hours });
  return fill(c.daysRemaining, { days: Math.ceil(hours / 24) });
}

function intakeWriteBarrier() {
  let pending = 0;
  let waiters = [];
  return {
    start() {
      pending += 1;
      return () => {
        pending -= 1;
        if (pending === 0) {
          const ready = waiters;
          waiters = [];
          for (const resolve of ready) resolve();
        }
      };
    },
    wait() {
      return pending ? new Promise((resolve) => waiters.push(resolve)) : null;
    },
    ready() { return pending === 0; },
  };
}

export function CaseworkHubPanel(props) {
  const { chapterId, api } = props;
  const [writesByApi] = useState(() => new WeakMap());
  let chapterWrites = writesByApi.get(api);
  if (!chapterWrites) { chapterWrites = new Map(); writesByApi.set(api, chapterWrites); }
  let intakeWrites = chapterWrites.get(chapterId);
  if (!intakeWrites) { intakeWrites = intakeWriteBarrier(); chapterWrites.set(chapterId, intakeWrites); }
  const [scope, setScope] = useState({ chapterId, api, generation: 0 });
  if (scope.chapterId !== chapterId || scope.api !== api) {
    // Reset before committing children with replacement scope props. This
    // retires A's editor/queue and its loaded rows together; a child key alone
    // could otherwise initialize B from the parent's retained A snapshot.
    setScope({ chapterId, api, generation: scope.generation + 1 });
    return null;
  }
  return <CaseworkHubScopeGate key={scope.generation} {...props} intakeWrites={intakeWrites} />;
}

function CaseworkHubScopeGate(props) {
  const { t } = useLang();
  const { intakeWrites } = props;
  const [ready, setReady] = useState(() => intakeWrites.ready());
  useEffect(() => {
    if (ready) return undefined;
    let active = true;
    // Mount the returning hub only after its retired editor confirms or
    // fails the entire first/final write sequence. Other scopes stay usable.
    void Promise.resolve(intakeWrites.wait()).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [intakeWrites, ready]);
  if (!ready) return <section className="cwk-panel"><p className="cwk-empty">{t("casework.hubLoading")}</p></section>;
  return <CaseworkHubScope {...props} />;
}

function CaseworkHubScope({ chapterId, caseOptions = [], api, onNotice = () => {}, intakeWrites }) {
  const { lang, t } = useLang();
  // The surface name, and every string that repeats it, comes from the
  // catalogue: the panel's own table used to say "casework center" while the
  // heading right above it said "Casework hub".
  const c = useMemo(() => ({
    ...(COPY[lang] || COPY.en),
    ...optionLabels(t),
    title: t("workspace.caseworkHub"),
    loading: t("casework.hubLoading"),
    unavailable: t("casework.hubUnavailable"),
    saved: t("casework.hubUpdated"),
    // Reused from the catalogue (both locales) instead of a panel-local key:
    // CaseBulkActions renders the same sentence for the same refusal.
    mixedStatus: t("caseBulk.mixedStatus"),
    eventTypeLabels: eventTypeLabels(t),
    eventUnknown: t("casework.hub.event.unknown"),
  }), [lang, t]);
  const scope = useMemo(() => ({ api, chapterId }), [api, chapterId]);
  const activeScope = useRef(null);
  const requestGeneration = useRef(0);
  const [result, setState] = useState({ loading: true, error: false, data: null });
  const state = result.scope === scope ? result : { loading: true, error: false, data: null };
  const [busy, setBusy] = useState("");
  useLayoutEffect(() => {
    activeScope.current = scope;
    setBusy("");
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
      const data = await api.loadCaseworkHub(chapterId);
      if (activeScope.current === scope && generation === requestGeneration.current) setState({ scope, loading: false, error: false, data });
    } catch {
      if (activeScope.current === scope && generation === requestGeneration.current) setState({ scope, loading: false, error: true, data: null });
    }
  }, [api, chapterId, scope]);
  useEffect(() => { void load(); }, [load]);
  async function run(key, work, form = null) {
    if (busy || activeScope.current !== scope || !state.data) return; setBusy(key);
    try {
      await work();
      if (activeScope.current !== scope) return;
      form?.reset();
      await load();
      if (activeScope.current === scope) onNotice(c.saved);
    }
    // A refused write arrives as raw database policy text; the notice must
    // stay catalogue copy in the member's own language.
    catch (error) { if (activeScope.current === scope) onNotice(rpcErrorTextStrict(t, error, c.failed)); }
    finally { if (activeScope.current === scope) setBusy(""); }
  }
  if (state.loading && !state.data) return <section className="cwk-panel"><p className="cwk-empty">{c.loading}</p></section>;
  if (state.error || !state.data) return <section className="cwk-panel"><p className="cwk-empty">{c.unavailable}</p><button className="cwk-btn cwk-btn--soft" type="button" onClick={load}>{c.retry}</button></section>;
  return <section className="cwk-panel role-section-target" id="casework-center" tabIndex="-1" aria-labelledby="casework-center-title">
    <div className="cwk-panel__head"><div className="cwk-panel__heading"><WorkspaceCardTitle className="cwk-panel__title" id="casework-center-title">{c.title}</WorkspaceCardTitle></div><button className="cwk-btn cwk-btn--ghost" type="button" disabled={Boolean(busy)} onClick={load}>{c.refresh}</button></div>
    {/* Every tool is one step from the top of the hub, however many
        bargaining tables sit above the others. */}
    <nav className="cwk-hub-tools" aria-label={c.tools}>{[
      ["casework-hub-bargaining", c.bargaining],
      ["casework-hub-intake", c.intake],
      api.scanRetaliationPatterns && ["casework-hub-patterns", c.patterns],
      api.loadCaseworkHistory && ["casework-hub-history", c.history],
    ].filter(Boolean).map(([id, label]) => <a key={id} className="cwk-btn cwk-btn--ghost" href={`#${id}`} onClick={(event) => { event.preventDefault(); document.getElementById(id)?.focus(); }}>{label}</a>)}</nav>
    <div className="cwk-grid">
      <div className="cwk-col"><BargainingPanel data={state.data.workspaces} copy={c} lang={lang} busy={busy} chapterId={chapterId} api={api} run={run} /></div>
      {/* The retaliation-pattern scan is a coordinator tool:
          casework_scan_retaliation_patterns and
          casework_review_retaliation_pattern demand a
          coordinator/advisor/admin/vp hat. A plane whose caller lacks that hat
          hands this panel an api WITHOUT those methods, so the control stays
          off the page instead of answering the first click with a 42501 the
          sensitive-content client rewrites as "Sensitive content is
          unavailable" — an outage sentence for a permission the caller never
          had. Step checklist templates and the retaliation timing scan (which
          raised unfair labor practice filing flags) are left out: Union
          Ground issues have no grievance procedure and no legal filing
          deadline (owner decision, 2026-10-13). */}
      <div className="cwk-col"><IntakeDraftPanel drafts={state.data.drafts} caseOptions={caseOptions} chapterId={chapterId} api={api} copy={c} lang={lang} t={t} onNotice={onNotice} intakeWrites={intakeWrites} />{api.scanRetaliationPatterns && <PatternPanel patterns={state.data.patterns} chapterId={chapterId} copy={c} busy={busy} api={api} run={run} />}</div>
    </div>
    {api.loadCaseworkHistory && <HistoryPanel api={api} copy={c} busy={busy} run={run} />}
  </section>;
}

const WORKSPACE_PAGE_SIZE = 10;
const SETTLED_PROPOSAL = new Set(["accepted", "rejected", "withdrawn"]);

// Typing in a workspace's forms survives collapsing that workspace or paging
// past it. The forms stay uncontrolled: each field's value is kept by form key
// as it changes and written back when the form mounts again, and only a
// successful save drops it. The restored value is the field's value, not its
// default, so the form's reset after a save still returns to the stored row.
function useFormDrafts() {
  const drafts = useRef(new Map());
  const restorers = useRef(new Map());
  const remember = useCallback((key) => (event) => {
    const { name, value: typed } = event.target;
    if (name) drafts.current.set(key, { ...drafts.current.get(key), [name]: typed });
  }, []);
  const restore = useCallback((key) => {
    if (!restorers.current.has(key)) {
      restorers.current.set(key, (form) => {
        const entry = form && drafts.current.get(key);
        if (!entry) return;
        for (const [name, typed] of Object.entries(entry)) {
          const field = form.elements.namedItem(name);
          if (field && field.value !== typed) field.value = typed;
        }
      });
    }
    return restorers.current.get(key);
  }, []);
  const forget = useCallback((key) => { drafts.current.delete(key); }, []);
  return { remember, restore, forget };
}

// One bargaining table open at a time, ten tables to a page. A chapter with
// a single table has nothing to choose between, so that table stays open.
function BargainingPanel({ data, copy: c, lang, busy, chapterId, api, run }) {
  const { remember, restore, forget } = useFormDrafts();
  const [expandedId, setExpandedId] = useState(null);
  const [page, setPage] = useState(0);
  const rangeRef = useRef(null);
  const focusRangeRef = useRef(false);
  const pageCount = Math.max(1, Math.ceil(data.length / WORKSPACE_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const shown = data.slice(current * WORKSPACE_PAGE_SIZE, (current + 1) * WORKSPACE_PAGE_SIZE);
  const single = data.length === 1;
  const paged = data.length > WORKSPACE_PAGE_SIZE;
  // After a page turn, focus lands on the range line that names the new page
  // instead of staying on a button that may have just become disabled.
  useEffect(() => {
    if (!focusRangeRef.current) return;
    focusRangeRef.current = false;
    rangeRef.current?.focus();
  }, [current]);
  function turn(delta) {
    focusRangeRef.current = true;
    setPage(Math.min(Math.max(current + delta, 0), pageCount - 1));
  }
  function save(key, work, form = null) {
    return run(key, async () => { await work(); forget(key); }, form);
  }
  function draftForm(key) {
    return { ref: restore(key), onChange: remember(key) };
  }
  return <article id="casework-hub-bargaining" tabIndex={-1} className="thread-message thread-message--steward"><h3>{c.bargaining}</h3><p>{c.bargainingHelp}</p>{data.length === 0 && <p>{c.noWorkspaces}</p>}
    {paged && <p className="cwk-hub-range" ref={rangeRef} tabIndex={-1}><small>{c.showing} {current * WORKSPACE_PAGE_SIZE + 1}–{current * WORKSPACE_PAGE_SIZE + shown.length} {c.of} {data.length} {c.workspaces}</small></p>}
    {shown.map((workspace) => {
      const open = single || expandedId === workspace.id;
      const detailId = `casework-workspace-${workspace.id}`;
      const overdue = workspace.proposals.filter((proposal) => proposal.response_due_at && !SETTLED_PROPOSAL.has(proposal.status) && new Date(proposal.response_due_at).getTime() < Date.now()).length;
      return <section key={workspace.id} className="cwk-hub-workspace">
        <p><strong id={`${detailId}-title`}>{workspace.title}</strong> <span className={`cwk-chip ${workspace.status === "live" ? "cwk-chip--new" : "cwk-chip--rest"}`}>{enumLabel(c.workspaceStatusLabels, workspace.status)}</span><br /><small>{workspace.starts_at ? stamp(workspace.starts_at, lang) : c.noDue}</small></p>
        <p className="cwk-hub-workspace__summary"><small>{fill(workspace.proposals.length === 1 ? c.proposalCount.one : c.proposalCount.other, { count: workspace.proposals.length })}{overdue > 0 && <> · {fill(c.overdueCount, { count: overdue })}</>}</small></p>
        {!single && <button className="cwk-btn cwk-btn--ghost cwk-hub-toggle" type="button" aria-expanded={open} aria-controls={detailId} aria-describedby={`${detailId}-title`} onClick={() => setExpandedId(open ? null : workspace.id)}>{open ? c.hideWorkspace : c.openWorkspace}</button>}
        <div id={detailId} hidden={!open}>{open && <>
          <form className="stack-form" {...draftForm(`workspace-${workspace.id}`)} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void save(`workspace-${workspace.id}`, () => api.setBargainingStatus(workspace.id, workspace.status, value(form, "status"))); }}><label>{c.sessionStatus}<select name="status" defaultValue={workspace.status}>{statusOptions(c.workspaceStatusLabels)}</select></label><button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)}>{c.update}</button></form>
          {workspace.proposals.map((proposal) => <div key={proposal.id}><p><strong>{proposal.title}</strong> · {enumLabel(c.proposalSideLabels, proposal.side)}<br />{proposal.body}<br /><small>{c.countdown}: {countdown(proposal.response_due_at, c)}</small></p><form className="stack-form" {...draftForm(`proposal-${proposal.id}`)} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void save(`proposal-${proposal.id}`, () => api.transitionBargainingProposal(proposal.id, proposal.status, value(form, "status"), iso(value(form, "due")))); }}><label>{c.proposalStatus}<select name="status" defaultValue={proposal.status}>{statusOptions(c.proposalStatusLabels)}</select></label><label>{c.responseDue}<input name="due" type="datetime-local" /></label><button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)}>{c.update}</button></form></div>)}
          <form className="stack-form" {...draftForm(`proposal-new-${workspace.id}`)} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void save(`proposal-new-${workspace.id}`, () => api.addBargainingProposal(workspace.id, { side: value(form, "side"), title: value(form, "title"), body: value(form, "body"), responseDueAt: iso(value(form, "due")) }), form); }}><h4>{c.proposal}</h4><label>{c.side}<select name="side">{statusOptions(c.proposalSideLabels)}</select></label><label>{c.proposalTitle}<input name="title" minLength={3} maxLength={200} required /></label><label>{c.body}<textarea name="body" minLength={8} maxLength={20000} required /></label><label>{c.responseDue}<input name="due" type="datetime-local" /></label><button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy)}>{c.addProposal}</button></form>
          <h4>{c.liveUpdate}</h4>{workspace.events.length === 0 ? <p>{c.noTimeline}</p> : workspace.events.map((event) => { const chip = eventChip(event, c); return <p key={event.id}><span className={`cwk-chip ${event.pulse === "urgent" ? "cwk-chip--new" : "cwk-chip--rest"}`} title={chip.code}>{chip.label}</span> {event.body}<br /><small>{stamp(event.created_at, lang)}</small></p>; })}
          <form className="stack-form" {...draftForm(`event-${workspace.id}`)} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void save(`event-${workspace.id}`, () => api.addBargainingEvent(workspace.id, "pulse", value(form, "body"), value(form, "pulse")), form); }}><label>{c.liveUpdate}<textarea name="body" minLength={1} maxLength={4000} required /></label><label>{c.pulse}<select name="pulse">{statusOptions(c.pulseLabels)}</select></label><button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy)}>{c.addUpdate}</button></form>
        </>}</div>
      </section>;
    })}
    {paged && <div className="cwk-actions cwk-hub-pager"><button className="cwk-btn cwk-btn--ghost" type="button" disabled={current === 0} onClick={() => turn(-1)}>{c.previous}</button><button className="cwk-btn cwk-btn--ghost" type="button" disabled={current >= pageCount - 1} onClick={() => turn(1)}>{c.next}</button></div>}
    <form className="stack-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run("workspace-new", () => api.createBargainingWorkspace(chapterId, value(form, "title"), iso(value(form, "startsAt"))), form); }}><label>{c.workspaceTitle}<input name="title" minLength={3} maxLength={200} required /></label><label>{c.startsAt}<input name="startsAt" type="datetime-local" /></label><button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy)}>{c.createWorkspace}</button></form>
  </article>;
}

function IntakeDraftPanel({ drafts, caseOptions, chapterId, api, copy: c, lang, t, onNotice, intakeWrites }) {
  const initial = drafts[0] || null;
  const [payload, setPayload] = useState(() => ({ title: initial?.payload?.title || "", notes: initial?.payload?.notes || "", caseId: initial?.case_id || "" }));
  const [saveState, setSaveState] = useState({ saving: false, savedAt: initial?.updated_at || null });
  const rowRef = useRef(initial ? { id: initial.id, revision: initial.revision } : { id: null, revision: 0 });
  const firstRef = useRef(true);
  const pendingRef = useRef(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const confirmedFieldsRef = useRef(intakeDraftFields(chapterId, payload));
  const latestFieldsRef = useRef(confirmedFieldsRef.current);
  const retiredFieldsRef = useRef(null);
  const unstartedDebounceRef = useRef(false);
  const saveOnUnmountRef = useRef(() => {});
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const fields = latestFieldsRef.current;
      const inFlight = savingRef.current;
      // Retire the mounted queue, retaining the latest snapshot until an
      // in-flight write confirms the identity/revision for one final save.
      // A write that already ran and failed must not be retried here: the
      // identity/revision is still unconfirmed, and a null-ID create could
      // already have inserted a row.
      pendingRef.current = null;
      if (inFlight) {
        retiredFieldsRef.current = fields;
        return;
      }
      if (
        !unstartedDebounceRef.current
        || !fields
        || sameIntakeDraftFields(fields, confirmedFieldsRef.current)
      ) return;
      saveOnUnmountRef.current(fields);
    };
  }, []);
  const savePending = useCallback(async () => {
    if (savingRef.current || !mountedRef.current) return;
    const finishWrite = intakeWrites.start();
    savingRef.current = true;
    try {
      while (mountedRef.current && pendingRef.current) {
        const fields = pendingRef.current;
        pendingRef.current = null;
        setSaveState((current) => ({ ...current, saving: true }));
        try {
          // Read identity only after the preceding write has confirmed it.
          const row = await api.saveIntakeDraft({ ...rowRef.current, ...fields });
          rowRef.current = { id: row.id, revision: row.revision };
          confirmedFieldsRef.current = fields;
          if (!mountedRef.current) {
            const retired = retiredFieldsRef.current;
            retiredFieldsRef.current = null;
            if (retired && !sameIntakeDraftFields(retired, fields)) {
              // Use this loop's original API and the just-confirmed row.
              // A rejected/uncertain first write never reaches this branch.
              const finalRow = await api.saveIntakeDraft({ ...rowRef.current, ...retired });
              rowRef.current = { id: finalRow.id, revision: finalRow.revision };
              confirmedFieldsRef.current = retired;
            }
          }
          if (mountedRef.current) setSaveState({ saving: Boolean(pendingRef.current), savedAt: row.updated_at });
        } catch (error) {
          if (mountedRef.current) {
            setSaveState((current) => ({ ...current, saving: false }));
          }
          // The parent notice surface can outlive this panel: a started write
          // must still report failure after navigation retires its queue. The
          // text is catalogue copy, never the raw refusal the server raised.
          onNotice(rpcErrorTextStrict(t, error, c.failed));
          // A conflict or uncertain write needs another deliberate edit, not
          // an automatic retry with the same unconfirmed identity/revision.
          break;
        }
      }
    } finally { savingRef.current = false; retiredFieldsRef.current = null; finishWrite(); }
  }, [api, c.failed, t, onNotice, intakeWrites]);
  const savePendingRef = useRef(savePending);
  useLayoutEffect(() => { savePendingRef.current = savePending; }, [savePending]);
  saveOnUnmountRef.current = (fields) => {
    // savePending bails once mountedRef is false, so the last write is a
    // single direct call that never re-enters the queue loop.
    const finishWrite = intakeWrites.start();
    savingRef.current = true;
    void api.saveIntakeDraft({ ...rowRef.current, ...fields }).then((row) => {
      rowRef.current = { id: row.id, revision: row.revision };
      confirmedFieldsRef.current = fields;
    }, (error) => {
      // Same contract as the queued path: catalogue copy, never the raw refusal.
      onNotice(rpcErrorTextStrict(t, error, c.failed));
    }).finally(() => { savingRef.current = false; finishWrite(); });
  };
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return undefined; }
    const fields = intakeDraftFields(chapterId, payload);
    latestFieldsRef.current = fields;
    if (!fields) {
      unstartedDebounceRef.current = false;
      return undefined;
    }
    unstartedDebounceRef.current = true;
    const timer = setTimeout(() => {
      unstartedDebounceRef.current = false;
      pendingRef.current = fields;
      // Presentation-only callback changes must neither retry an uncertain
      // create nor postpone an actual edit's existing debounce deadline.
      void savePendingRef.current();
    }, 650);
    return () => { clearTimeout(timer); pendingRef.current = null; };
  }, [chapterId, payload]);
  return <article id="casework-hub-intake" tabIndex={-1} className="thread-message thread-message--steward"><h3>{c.intake}</h3><p>{c.intakeHelp}</p><form className="stack-form" onSubmit={(event) => event.preventDefault()}><label>{c.draftTitle}<input value={payload.title} maxLength={200} onChange={(event) => setPayload((current) => ({ ...current, title: event.target.value }))} /></label><label>{c.draftNotes}<textarea value={payload.notes} maxLength={20000} onChange={(event) => setPayload((current) => ({ ...current, notes: event.target.value }))} /></label><label>{c.linkedCase}<select value={payload.caseId} onChange={(event) => setPayload((current) => ({ ...current, caseId: event.target.value }))}><option value="">—</option>{caseOptions.map((item) => <option value={item.id} key={item.id}>{item.reference} · {item.title}</option>)}</select></label><p aria-live="polite"><small>{saveState.saving ? c.saving : saveState.savedAt ? `${c.savedAt} ${stamp(saveState.savedAt, lang)}` : c.emptyDraft}</small></p></form></article>;
}

function PatternPanel({ patterns, chapterId, copy: c, busy, api, run }) {
  return <article id="casework-hub-patterns" tabIndex={-1} className="thread-message thread-message--steward"><h3>{c.patterns}</h3><p>{c.patternHelp}</p><button className="cwk-btn cwk-btn--soft" type="button" disabled={Boolean(busy)} onClick={() => void run("pattern-scan", () => api.scanRetaliationPatterns(chapterId))}>{c.scan}</button>{patterns.length === 0 ? <p>{c.noPatterns}</p> : patterns.map((pattern) => <form className="stack-form" key={pattern.id} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void run(`pattern-${pattern.id}`, () => api.reviewRetaliationPattern(pattern.id, value(form, "status"), value(form, "disposition"), value(form, "note")), form); }}><p><strong>{pattern.subject_label || c.unnamedPattern} · {pattern.report_count} {c.reports}</strong><br />{enumLabel(c.patternStatusLabels, pattern.status)}</p>{pattern.casework_retaliation_pattern_notes?.map((item) => <p key={item.id}><small>{item.body}</small></p>)}<label>{c.status}<select name="status" defaultValue={pattern.status}>{statusOptions(c.patternStatusLabels)}</select></label><label>{c.disposition}<input name="disposition" defaultValue={pattern.disposition || ""} maxLength={2000} /></label><label>{c.note}<textarea name="note" maxLength={4000} /></label><button className="cwk-btn cwk-btn--ghost" disabled={Boolean(busy)}>{c.saveReview}</button></form>)}</article>;
}

function HistoryPanel({ api, copy: c, busy, run }) {
  // Stored issue types read in the reader's language; custom prose stays as typed.
  const { t } = useLang();
  const [filters, setFilters] = useState({ search: "", status: "all", caseType: "", restricted: "all", page: 0 });
  const [result, setResult] = useState({ loading: true, error: false, rows: [], total: 0, page: 0, pageSize: 50 });
  const [selected, setSelected] = useState(() => new Set());
  // Only status changes in bulk: Union Ground issues carry no grievance
  // step to move (owner decision, 2026-10-13).
  const [bulkStatus, setBulkStatus] = useState("");
  const load = useCallback(async (next = filters) => {
    setResult((current) => ({ ...current, loading: true, error: false }));
    try { setResult({ loading: false, error: false, ...(await api.loadCaseworkHistory(next)) }); }
    catch { setResult((current) => ({ ...current, loading: false, error: true })); }
  }, [api, filters]);
  useEffect(() => { void load(filters); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function toggle(id) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function applyBulk(event) {
    event.preventDefault();
    const form = event.currentTarget; const status = value(form, "nextStatus");
    if (!status) return;
    const rows = result.rows.filter((row) => selected.has(row.id));
    // casework_bulk_update_cases takes ONE p_expected_status and refuses the
    // whole batch on drift, so the batch is refused before the request rather
    // than grouped into per-status requests that can half-apply.
    const expectedStatus = sharedStatus(rows);
    if (!expectedStatus) return;
    await run("history-bulk", async () => {
      try {
        await api.bulkUpdateCases(rows.map((row) => row.id), expectedStatus, { status });
      } finally {
        // A failed batch can still have moved some rows, and the selection's
        // expected status is already stale either way: reconcile the rows and
        // the selection from the server instead of leaving a retry that
        // resends moved ids with an obsolete expected status.
        setSelected(new Set()); await load(filters);
      }
    }, form);
  }
  function submitFilters(event) {
    event.preventDefault(); const form = event.currentTarget;
    const next = { search: value(form, "search"), status: value(form, "status"), caseType: value(form, "caseType"), restricted: value(form, "restricted"), page: 0 };
    setFilters(next); setSelected(new Set()); void load(next);
  }
  function page(delta) { const next = { ...filters, page: Math.max(0, filters.page + delta) }; setFilters(next); setSelected(new Set()); void load(next); }
  const first = result.total === 0 ? 0 : (result.page * result.pageSize) + 1;
  const last = Math.min(result.total, (result.page * result.pageSize) + result.rows.length);
  const selectionStatus = sharedStatus(result.rows.filter((row) => selected.has(row.id)));
  return <article id="casework-hub-history" tabIndex={-1} className="thread-message thread-message--steward"><h3>{c.history}</h3><p>{c.historyHelp}</p><form className="stack-form stack-form--grid" onSubmit={submitFilters}><label>{c.search}<input name="search" type="search" defaultValue={filters.search} /></label><label>{c.caseStatus}<select name="status" defaultValue={filters.status}><option value="all">{c.all}</option><option value="active">{c.active}</option><option value="resolved">{c.resolved}</option></select></label><label>{c.caseType}<input name="caseType" defaultValue={filters.caseType} /></label><label>{c.access}<select name="restricted" defaultValue={filters.restricted}><option value="all">{c.all}</option><option value="restricted">{c.restricted}</option><option value="standard">{c.standard}</option></select></label><button className="cwk-btn cwk-btn--ghost" disabled={result.loading}>{c.apply}</button></form>{result.error ? <p role="alert">{c.unavailable}</p> : result.loading && result.rows.length === 0 ? <p>{c.loading}</p> : result.rows.length === 0 ? <p>{c.noCases}</p> : <>{result.rows.map((row) => <label className="cwk-row" key={row.id}><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /><span className="cwk-row__main"><span className="cwk-row__top"><span className="cwk-name">{row.member?.full_name || row.reference}</span><span className={`cwk-chip ${row.is_restricted ? "cwk-chip--new" : "cwk-chip--rest"}`}>{row.is_restricted ? c.restricted : caseStatusLabel(row.status, c)}</span></span><span className="cwk-sub">{row.reference} · {row.title}</span><span className="cwk-meta">{caseTypeLabel(row.case_type, t)}</span></span></label>)}<p><small>{c.showing} {first}–{last} {c.of} {result.total}</small></p><div className="cwk-actions"><button className="cwk-btn cwk-btn--ghost" type="button" disabled={result.page === 0 || result.loading} onClick={() => page(-1)}>{c.previous}</button><button className="cwk-btn cwk-btn--ghost" type="button" disabled={last >= result.total || result.loading} onClick={() => page(1)}>{c.next}</button></div></>}
    <form className="stack-form stack-form--grid" onSubmit={applyBulk}><p><strong>{selected.size} {c.selected}</strong></p><label>{c.nextStatus}<select name="nextStatus" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}><option value="">—</option><option value="active">{c.active}</option><option value="resolved">{c.resolved}</option></select></label><button className="cwk-btn cwk-btn--soft" disabled={Boolean(busy) || selected.size === 0 || !bulkStatus || !selectionStatus}>{c.bulkUpdate}</button>{selected.size > 0 && !selectionStatus && <p className="cwk-empty cwk-empty--inset" role="alert">{c.mixedStatus}</p>}</form>
  </article>;
}
