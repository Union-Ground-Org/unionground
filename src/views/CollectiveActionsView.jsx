import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  DIGITAL_ACTION_KINDS,
  DIGITAL_ACTION_PAGE_SIZE,
  DIGITAL_ACTION_PARTICIPATION_KINDS,
  DIGITAL_ACTION_STATUSES,
  digitalActionParticipationKind,
} from "../features/organizationIntelligence/contract.js";
import { buildDigitalActionParticipantCsv } from "../features/organizationIntelligence/export.js";
import {
  createWiredOrganizationIntelligenceAdapter,
  useOrganizationIntelligenceActor,
} from "../lib/organizationIntelligenceWiring.js";
import { createOrganizationIntelligenceAdapter } from "../features/organizationIntelligence/adapter.js";
import { COLLECTIVE_ACTIONS_PREVIEW_SNAPSHOT } from "../features/organizationIntelligence/preview.js";
import { localDateTimeInputToIso, localDateTimeInputValue } from "../lib/localDateTime.js";
import { formatDateTimeWithZone } from "../lib/i18n/zonedDates.js";
import { StaffAuthoringContext, StaffAuthoringHint } from "../components/StaffAuthoringHint.jsx";
import { CampaignPage } from "../alt/takepart/CampaignPage.jsx";
import { GoalBreakdown } from "../features/organizationIntelligence/GoalBreakdown.jsx";
import { canViewCollectiveActionGoalBreakdown } from "../features/organizationIntelligence/authorization.js";
import "../features/organizationIntelligence/organization-intelligence.css";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../lib/busyWrite.js";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";

const COPY = { en: {
  workspaceLabel: "Collective actions workspace",
  title: "Digital Picket Line", sub: "Join petitions, rallies, pickets, meetings, and volunteer actions in your organization.",
  loading: "Loading actions…", retry: "Try again", emptyOrg: "No organization is selected yet.",
  unavailable: "Collective actions are unavailable right now.", unwired: "Collective actions are ready when the database migration is available.",
  noActions: "No active actions yet.", joined: "You joined this action.", join: "Join action", withdraw: "Withdraw",
  windowOpens: "Opens {date}", windowEnded: "Participation closed", windowRefused: "This action isn’t accepting participation right now.",
  strength: "people joined", withheld: "participation withheld", target: "goal", create: "Create action", titleLabel: "Title", summary: "Summary",
  type: "Type", status: "Status", targetCount: "Participation goal", starts: "Starts", ends: "Ends", save: "Save action",
  saving: "Saving…", saved: "Saved.", error: "The change could not be saved.", export: "Export participant list",
  loadMore: "Load more actions", loadingMore: "Loading more…", loadMoreFailed: "More actions could not be loaded. Try again.",
  exporting: "Preparing export…", exportReady: "Protected export downloaded.", exportDenied: "Coordinator, admin, or president access with two-step sign-in is required to export names.",
  exportOrganizationOnly: "Exporting names needs an organization-wide coordinator, admin, or president role.",
  chapterScope: "Actions you create here are for your chapter.",
  chapterOnlyJoin: "Only members of this action's chapter can join it.",
  participation: "Participation", draft: "Draft", published: "Published", closed: "Closed", cancelled: "Cancelled",
  kinds: { petition: "Petition", rally: "Rally", picket: "Picket", meeting: "Meeting", other: "Other" },
  participationKinds: { signature: "Signature", attendee: "Attendee", volunteer: "Volunteer" },
}, es: {
  workspaceLabel: "Espacio de acciones colectivas",
  title: "Línea de Piquete Digital", sub: "Únase a peticiones, concentraciones, piquetes, reuniones y acciones voluntarias de su organización.",
  loading: "Cargando acciones…", retry: "Intentar de nuevo", emptyOrg: "Todavía no hay una organización seleccionada.",
  unavailable: "Las acciones colectivas no están disponibles ahora.", unwired: "Las acciones estarán listas cuando esté disponible la migración de base de datos.",
  noActions: "Todavía no hay acciones activas.", joined: "Se unió a esta acción.", join: "Unirse", withdraw: "Retirarse",
  windowOpens: "Abre el {date}", windowEnded: "La participación cerró", windowRefused: "Esta acción no acepta participación en este momento.",
  strength: "personas participan", withheld: "participación reservada", target: "meta", create: "Crear acción", titleLabel: "Título", summary: "Resumen",
  type: "Tipo", status: "Estado", targetCount: "Meta de participación", starts: "Comienza", ends: "Termina", save: "Guardar acción",
  saving: "Guardando…", saved: "Guardado.", error: "No se pudo guardar el cambio.", export: "Exportar participantes",
  loadMore: "Cargar más acciones", loadingMore: "Cargando más…", loadMoreFailed: "No se pudieron cargar más acciones. Inténtelo de nuevo.",
  exporting: "Preparando exportación…", exportReady: "Se descargó la exportación protegida.", exportDenied: "Se requiere acceso de coordinación, administración o presidencia con verificación en dos pasos.",
  exportOrganizationOnly: "Para exportar nombres se necesita un rol de coordinación, administración o presidencia en toda la organización.",
  chapterScope: "Las acciones que cree aquí son para su capítulo.",
  chapterOnlyJoin: "Solo los miembros del capítulo de esta acción pueden unirse.",
  participation: "Participación", draft: "Borrador", published: "Publicada", closed: "Cerrada", cancelled: "Cancelada",
  kinds: { petition: "Petición", rally: "Concentración", picket: "Piquete", meeting: "Reunión", other: "Otra acción" },
  participationKinds: { signature: "Firma", attendee: "Asistencia", volunteer: "Voluntariado" },
} };

// UX-UG-COLLECTIVE-ACTION-JOIN-OFFERED-OUTSIDE-PARTICIPATION-WINDOW-20260921:
// toggle_digital_action_participation refuses join and withdraw with 55000
// unless the action is published and now falls inside [starts_at, ends_at],
// so the control follows the same window instead of offering a refused tap.
export function participationWindow(action, now = Date.now()) {
  const starts = action.startsAt ? Date.parse(action.startsAt) : NaN;
  const ends = action.endsAt ? Date.parse(action.endsAt) : NaN;
  if (Number.isFinite(starts) && starts > now) return "upcoming";
  if (Number.isFinite(ends) && ends < now) return "ended";
  return "open";
}

const initialAction = { id: "", chapterId: "", kind: "petition", title: "", summary: "", status: "draft", targetCount: 100, startsAt: "", endsAt: "" };

export function downloadExport(payload) {
  if (typeof document === "undefined" || typeof Blob === "undefined" || !payload?.rows) return false;
  const body = buildDigitalActionParticipantCsv(payload);
  const href = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `collective-action-${payload.actionId}-${payload.participationKind}.csv`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}

export async function exportCollectiveActionParticipants(adapter, actor, actionId, participationKind) {
  const payload = await adapter.exportParticipants({ actor, actionId, participationKind });
  if (!downloadExport(payload)) throw new Error("export unavailable");
}

export function CollectiveActionsView({ alt = false, onOpenHome = null, actor, client, lang = "en", preview = false }) {
  const copy = COPY[lang] || COPY.en;
  const t = useOrganizationTranslator(lang);
  const scopedActor = useOrganizationIntelligenceActor(client, actor);
  const previewSnapshot = useRef(COLLECTIVE_ACTIONS_PREVIEW_SNAPSHOT);
  const adapter = useMemo(() => preview ? createOrganizationIntelligenceAdapter({
    fetchActions: async () => previewSnapshot.current,
    saveAction: async ({ actor: _actor, ...input }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, actions: [...current.actions.filter((row) => row.id !== input.id), { ...input, id: input.id || `preview-action-${Date.now()}`, participantCount: 0, viewerParticipation: null, viewerCanEdit: true, publishedAt: input.status === "draft" ? null : new Date().toISOString() }] };
    },
    toggleParticipation: async ({ actionId, participationKind, joined }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, actions: current.actions.map((row) => row.id === actionId ? { ...row, viewerParticipation: joined ? participationKind : null, participantCount: Math.max(0, row.participantCount + (joined ? 1 : -1)) } : row) };
    },
    exportParticipants: async ({ actionId, participationKind }) => ({ actionId, actionTitle: previewSnapshot.current.actions.find((row) => row.id === actionId)?.title || "Collective action", participationKind, rows: [{ participationKind, memberName: "Alex Rivera", email: "alex@example.test", chapterName: "Central Chapter", joinedAt: "2026-08-28T12:00:00Z" }] }),
  }) : createWiredOrganizationIntelligenceAdapter(client), [client, preview]);
  const scope = useMemo(() => ({ adapter, scopedActor }), [adapter, scopedActor]);
  const { generation, isCurrent } = useBusyScope(scope);
  const readVersion = useRef(0);
  const [page, setPage] = useState(null);
  const currentPage = page?.generation === generation ? page : null;
  const model = currentPage?.model ?? null;
  const loading = currentPage?.loading ?? true;
  const moreFailed = currentPage?.more === "failed";
  // #9166: the empty-page hint offers only hats the server says manage actions
  // here (authoringHats), never a unit-limited steward's hat the save refuses.
  const authoring = useContext(StaffAuthoringContext);
  const authoringHats = model?.authoringHats;
  const hintContext = useMemo(() => (Array.isArray(authoringHats)
    ? { ...authoring, hats: (authoring?.hats || []).filter((hat) => authoringHats.includes(hat)) }
    : authoring), [authoring, authoringHats]);
  const [writeBusyKey, setBusyKey] = useState("");
  const busyKey = currentPage?.more === "loading" ? "load-more" : writeBusyKey;
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(initialAction);
  const load = useCallback(async () => {
    if (!isCurrent(generation)) return;
    const version = ++readVersion.current;
    setPage((prior) => ({ generation, model: prior?.generation === generation ? prior.model : null, loading: true }));
    const next = await adapter.loadActions({ actor: scopedActor, limit: DIGITAL_ACTION_PAGE_SIZE, offset: 0 });
    if (isCurrent(generation) && version === readVersion.current) setPage({ generation, model: next, loading: false });
  }, [adapter, scopedActor, generation, isCurrent]);
  useEffect(() => { load(); }, [load]);
  // Record 8435: each key (join-<action>, save-action, export-<action>-<kind>,
  // load-more) is locked synchronously, before React commits busyKey.
  const busyWriteRef = useRef(new Set());
  const run = (key, operation, success = copy.saved, reload = true) => runBusyWrite(busyWriteRef, key, () => runNow(key, operation, success, reload));
  const runNow = async (key, operation, success, reload) => { setBusyKey(key); setNotice(""); try { await operation(); if (reload) await load(); setNotice(success); } catch (error) { setNotice(error?.code === "55000" ? copy.windowRefused : copy.error); } finally { setBusyKey(""); } };
  const set = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  const stateMessage = loading ? copy.loading : model?.state === "empty" ? copy.emptyOrg : model?.state === "unset" ? copy.unwired : copy.unavailable;
  // One handler per server action, shared by the classic cards and the
  // alternate shell's Campaign page.
  const toggleJoin = (action) => {
    const joined = Boolean(action.viewerParticipation);
    return run(`join-${action.id}`, () => adapter.toggleParticipation({ actionId: action.id, participationKind: joined ? action.viewerParticipation : digitalActionParticipationKind(action.kind), joined: !joined }));
  };
  const editAction = (action) => setForm({ ...action, startsAt: action.startsAt ? localDateTimeInputValue(action.startsAt) : "", endsAt: action.endsAt ? localDateTimeInputValue(action.endsAt) : "" });
  const exportKind = (action, kind) => run(`export-${action.id}-${kind}`, () => exportCollectiveActionParticipants(adapter, scopedActor, action.id, kind), copy.exportReady);
  const loadMore = () => {
    if (loading || !model?.hasMore) return;
    const version = readVersion.current;
    return runBusyWrite(busyWriteRef, `load-more:${generation}:${version}`, async () => {
      setPage({ ...currentPage, more: "loading" });
      const next = await adapter.loadActions({ actor: scopedActor, limit: DIGITAL_ACTION_PAGE_SIZE, offset: model.nextOffset })
        .catch(() => ({ state: "error" }));
      if (!isCurrent(generation) || version !== readVersion.current) return;
      if (next.state === "error") {
        setPage({ ...currentPage, more: "failed" });
      } else {
        setPage({ generation, model: next.state === "ready" ? { ...next, actions: [...model.actions, ...next.actions] } : next, loading: false });
      }
    });
  };
  const createForm = model?.state === "ready" && model.manageAllowed && <form className="oi-form oi-card oi-action-form" onSubmit={(event) => { event.preventDefault(); run("save-action", async () => { await adapter.saveAction({ actor: scopedActor, ...form, chapterId: model.manageScope === "chapter" ? model.manageChapterId : form.chapterId, startsAt: localDateTimeInputToIso(form.startsAt), endsAt: localDateTimeInputToIso(form.endsAt) }); setForm(initialAction); }); }}>
        <h2>{copy.create}</h2>{model.manageScope === "chapter" && <p className="oi-muted">{copy.chapterScope}</p>}<div className="oi-form__grid">
          <label className="oi-field"><span>{copy.titleLabel}</span><input required minLength={3} maxLength={180} value={form.title} onChange={set("title")} /></label>
          <label className="oi-field oi-field--wide"><span>{copy.summary}</span><textarea required minLength={3} maxLength={2000} value={form.summary} onChange={set("summary")} /></label>
          <label className="oi-field"><span>{copy.type}</span><select value={form.kind} onChange={set("kind")}>{DIGITAL_ACTION_KINDS.map((kind) => <option key={kind} value={kind}>{copy.kinds[kind] || kind}</option>)}</select></label>
          <label className="oi-field"><span>{copy.status}</span><select value={form.status} onChange={set("status")}>{DIGITAL_ACTION_STATUSES.map((status) => <option key={status} value={status}>{copy[status]}</option>)}</select></label>
          <label className="oi-field"><span>{copy.targetCount}</span><input type="number" min="1" max="1000000" value={form.targetCount} onChange={set("targetCount")} /></label>
          <label className="oi-field"><span>{copy.starts}</span><input type="datetime-local" value={form.startsAt} onChange={set("startsAt")} /></label>
          <label className="oi-field"><span>{copy.ends}</span><input type="datetime-local" value={form.endsAt} onChange={set("endsAt")} /></label>
        </div><BusyButton className="oi-button" pending={Boolean(busyKey)} type="submit">{busyKey === "save-action" ? copy.saving : copy.save}</BusyButton>
      </form>;
  // The alternate shell draws the prototype's Campaign page (pages/campaign.js)
  // on this same model and these same handlers.
  if (alt) {
    return <StaffAuthoringContext.Provider value={hintContext}><CampaignPage
      lang={lang} copy={copy} model={model} loading={loading} stateMessage={stateMessage} notice={notice} busyKey={busyKey}
      onRetry={load} onToggleJoin={toggleJoin} onEdit={editAction} onExport={exportKind} onLoadMore={loadMore} moreFailed={moreFailed} createForm={createForm} onOpenHome={onOpenHome} windowOf={participationWindow}
    /></StaffAuthoringContext.Provider>;
  }
  return <StaffAuthoringContext.Provider value={hintContext}><section className="oi-shell" aria-label={copy.workspaceLabel} data-mi1-surface="collective-actions">
    <header className="oi-hero oi-hero--action"><p>{copy.title}</p><h1>{t("nav.collectiveActions")}</h1><span>{copy.sub}</span></header>
    {(loading || model?.state !== "ready") && <div className="oi-state" role="status"><p>{stateMessage}</p>{!loading && <button className="oi-button oi-button--secondary" type="button" onClick={load}>{copy.retry}</button>}</div>}
    {model?.state === "ready" && <>
      {notice && <p className="oi-notice" role="status">{notice}</p>}
      <div className="oi-action-grid">{model.actions.length ? model.actions.map((action) => {
        const joined = Boolean(action.viewerParticipation);
        const joinWindow = action.status === "published" ? participationWindow(action) : null;
        const available = joinWindow === "open";
        // #9166: a manager sees other chapters' actions but may join only its own chapter's.
        const joinable = joined || action.viewerCanJoin !== false;
        return <article className="oi-action-card" key={action.id}>
          <div className="oi-action-card__top"><span className="oi-badge">{copy.kinds[action.kind] || action.kind}</span><span className={`oi-status oi-status--${action.status}`}>{copy[action.status]}</span></div>
          <h2>{action.title}</h2><p>{action.summary}</p>
          <div className="oi-meter"><div>{action.participantCount === null ? <strong>{copy.withheld}</strong> : <><strong>{action.participantCount}</strong> {copy.strength}</>}<span>{action.targetCount} {copy.target}</span></div>{action.strengthPercent !== null && <progress max="100" value={action.strengthPercent}>{action.strengthPercent}%</progress>}</div>
          {joined && <p className="oi-joined">{copy.joined} · {copy.participationKinds[action.viewerParticipation] || action.viewerParticipation}</p>}
          <div className="oi-actions">
            {available && !joinable && <p className="oi-muted">{copy.chapterOnlyJoin}</p>}
            {available && joinable && <BusyButton className="oi-button" pending={Boolean(busyKey)} type="button" onClick={() => toggleJoin(action)}>{busyKey === `join-${action.id}` ? copy.saving : joined ? copy.withdraw : copy.join}</BusyButton>}
            {joinWindow === "upcoming" && <p className="oi-muted">{copy.windowOpens.replace("{date}", formatDateTimeWithZone(action.startsAt, lang))}</p>}
            {joinWindow === "ended" && <p className="oi-muted">{copy.windowEnded}</p>}
            {action.viewerCanEdit && <button className="oi-button oi-button--secondary" type="button" onClick={() => editAction(action)}>{copy.save}</button>}
          </div>
          {canViewCollectiveActionGoalBreakdown(scopedActor) && adapter.goalBreakdown && <GoalBreakdown actionId={action.id} load={adapter.goalBreakdown} lang={lang} />}
          {model.exportAllowed ? <details className="oi-export"><summary>{copy.export}</summary><div>{DIGITAL_ACTION_PARTICIPATION_KINDS.map((kind) => <BusyButton key={kind} pending={Boolean(busyKey)} type="button" className="oi-link" onClick={() => exportKind(action, kind)}>{copy.participationKinds[kind] || kind}</BusyButton>)}</div></details> : model.manageAllowed && <p className="oi-muted">{model.manageScope === "chapter" ? copy.exportOrganizationOnly : copy.exportDenied}</p>}
        </article>;
      }) : <><p className="oi-state">{copy.noActions}</p>{!model.manageAllowed && <StaffAuthoringHint item="actions" className="oi-state staff-authoring-hint" buttonClassName="oi-button oi-button--secondary" />}</>}</div>
      {model.hasMore && <div className="oi-load-more"><BusyButton className="oi-button oi-button--secondary" pending={Boolean(busyKey)} type="button" onClick={loadMore}>{busyKey === "load-more" ? copy.loadingMore : copy.loadMore}</BusyButton>{moreFailed && <p role="alert">{copy.loadMoreFailed}</p>}</div>}
      {createForm}
    </>}
  </section></StaffAuthoringContext.Provider>;
}
