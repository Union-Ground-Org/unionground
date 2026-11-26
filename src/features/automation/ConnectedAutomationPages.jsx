import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useWorkspace, workspaceHref } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { definitionDraft, isUuid } from "./controlPlane.js";
import { AUTOMATION_TRIGGER_METADATA, AUTOMATION_ACTION_METADATA } from "./capabilities.js";
import { TAB_PAGE_GROUPS } from "../../lib/workspacePages.js";
import { automationContextFromSearch, automationSourceHref, automationEffectHref } from "./links.js";
import { automationConditionLabel } from "./automationUiLabels.js";
import { createAutomationRecipeDraft } from "./recipes.js";
import { AutomationRecipeLibrary, AutomationPager } from "./AutomationRecipeLibrary.jsx";
import { AutomationGuidedBuilder } from "./AutomationGuidedBuilder.jsx";
import { AutomationDiscover } from "./AutomationDiscover.jsx";
import { AutomationReviewPanel } from "./AutomationReviewPanel.jsx";
import { AutomationDefaultRecipes, AutomationRoutingRules } from "./AutomationRoutingRules.jsx";
import { automationAccess } from "./access.js";
import { automationAuthoringBlock } from "./authoringBlock.js";
import "../../lib/i18n/features/automationAvailabilityStrings.js";
import { requestAutomationDraft } from "../../lib/automationCompassApi.js";
import "./automationPages.css";
import { BusyButton } from "../../components/BusyControls.jsx";

const NEW_DRAFT = { schemaVersion: 2, name: "", triggerKind: "overdue_task", thresholdDays: "1", cadence: "daily", taskPriority: "medium", conditions: {}, actionKind: "create_standard_task", actionConfig: {} };
const PAGE_SIZE = 6;
const SAFETY_CAP_LIMITS = Object.freeze({ min: 1, max: 50 });
function formatTime(value, lang) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
async function readWithLegacyFallback(read, control, fallback) {
  if (!read) return control.capabilities?.schemaVersion === 2 ? { ok: false } : fallback();
  const result = await read();
  return !result?.ok && result?.reason === "persistence_unset" && control.capabilities?.schemaVersion !== 2 ? fallback() : result;
}
function useRead(read, dependencies) {
  const [result, setResult] = useState({ state: "loading", data: null });
  useEffect(() => {
    let current = true;
    setResult({ state: "loading", data: null });
    Promise.resolve().then(read).then((response) => {
      if (!current) return;
      if (response?.pending) {
        setResult({ state: "loading", data: null });
        return;
      }
      setResult(response?.ok ? { state: "ready", data: response.data } : { state: "unavailable", data: null });
    }).catch(() => { if (current) setResult({ state: "unavailable", data: null }); });
    return () => { current = false; };
    // The caller supplies the complete immutable query identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  return result;
}

function ReadState({ state }) {
  const { t } = useLang();
  if (state === "ready") return null;
  return <p className="automation-pages__loading" role="status">{state === "loading" ? t("automation.pages.loadingRecords") : t("automation.pages.recordUnavailable")}</p>;
}

export function ConnectedAutomationPages({ session, accessToken = null, api, onNotice = () => {}, requestCompass = requestAutomationDraft }) {
  const workspace = useWorkspace();
  const { t, lang } = useLang();
  const tab = workspace?.page?.tab || "discover";
  const base = TAB_PAGE_GROUPS.automation.base;
  // Identity changes invalidate mutations immediately, before passive effects
  // run. Query generations alone cannot stop an old mutation starting a new
  // load after a different organization or API has already become current.
  const identity = useRef({ api, session, epoch: 0 });
  if (identity.current.api !== api || identity.current.session !== session) {
    identity.current = { api, session, epoch: identity.current.epoch + 1 };
  }
  const identityEpoch = identity.current.epoch;
  const [controlData, setControl] = useState(null);
  const control = controlData?.epoch === identityEpoch ? controlData.value : null;
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [phrase, setPhrase] = useState("");
  const [preview, setPreview] = useState(null);
  const [opportunities, setOpportunities] = useState({ state: "idle", rows: [], scopeChapterId: null });
  const generation = useRef(0);
  const opportunityGeneration = useRef(0);
  const mounted = useRef(false);
  const navigationAllowed = useRef(false);
  const busyRef = useRef(false);
  const params = new URLSearchParams(window.location.search);
  const selectedDefinition = params.get("definition");
  const selectedRun = params.get("run");
  const requestedContext = automationContextFromSearch(window.location.search);
  const hasContext = params.has("sourceKind") || params.has("sourceId");
  const sourceKind = requestedContext?.sourceKind;
  const sourceId = requestedContext?.sourceId;
  const sourceContextValid = Boolean(requestedContext);
  const sourceRead = useRead(() => {
    if (!hasContext) return { ok: true, data: null };
    if (state === "loading") return { pending: true };
    if (state !== "ready" || !sourceContextValid || !api.getSourceContext) return { ok: false };
    return api.getSourceContext(session, sourceKind, sourceId);
  }, [api, session, hasContext, sourceKind, sourceId, sourceContextValid, state]);
  const load = useCallback(async () => {
    if (!mounted.current || identity.current.epoch !== identityEpoch) return;
    const request = ++generation.current;
    try {
      const result = await api.load(session);
      if (!mounted.current || request !== generation.current || identity.current.epoch !== identityEpoch) return;
      setControl(result.state === "ready" ? { value: result.control, epoch: identityEpoch } : null);
      setState(result.state);
    } catch { if (mounted.current && request === generation.current && identity.current.epoch === identityEpoch) { setControl(null); setState("unavailable"); } }
  }, [api, session, identityEpoch]);
  useEffect(() => {
    mounted.current = true;
    setState("loading"); setControl(null); setDraft(null); setPreview(null); setConfirmation(null);
    busyRef.current = false; setBusy(false); setError(""); setPhrase("");
    void load();
    return () => { mounted.current = false; generation.current += 1; };
  }, [load]);
  const loadOpportunities = useCallback(async () => {
    const request = ++opportunityGeneration.current;
    if (state !== "ready" || !control || !api.getOpportunities) {
      setOpportunities({ state: state === "loading" ? "loading" : "unavailable", rows: [], scopeChapterId: null });
      return;
    }
    setOpportunities({ state: "loading", rows: [], scopeChapterId: null });
    try {
      const result = await api.getOpportunities(session);
      if (!mounted.current || request !== opportunityGeneration.current || identity.current.epoch !== identityEpoch) return;
      setOpportunities(result?.ok
        ? { state: "ready", rows: result.data.rows, scopeChapterId: result.data.scopeChapterId ?? null }
        : { state: "unavailable", rows: [], scopeChapterId: null });
    } catch {
      if (mounted.current && request === opportunityGeneration.current && identity.current.epoch === identityEpoch) setOpportunities({ state: "unavailable", rows: [], scopeChapterId: null });
    }
  }, [api, session, state, control, identityEpoch]);
  useEffect(() => {
    if (tab === "discover") void loadOpportunities();
    return () => { opportunityGeneration.current += 1; };
  }, [tab, loadOpportunities, revision]);
  useEffect(() => {
    setPreview(null); setConfirmation(null); setPhrase("");
  }, [tab, selectedDefinition, selectedRun]);
  useEffect(() => {
    if (sourceRead.state !== "ready") return;
    setError((current) => current === t("automation.pages.sourceUnauthorized") ? "" : current);
  }, [sourceRead.state, t]);
  useEffect(() => {
    if (!draft) return;
    const unload = (event) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event) => {
      if (navigationAllowed.current) return;
      const warning = t("automation.pages.leaveDraft");
      if (!window.confirm(warning)) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("sg:before-navigate", navigate);
    return () => { window.removeEventListener("beforeunload", unload); window.removeEventListener("sg:before-navigate", navigate); };
  }, [draft, lang, t]);
  function open(next, reference = {}, { preserveDraft = false } = {}) {
    const query = new URLSearchParams(reference);
    if (hasContext && sourceRead.data && ["recipes", "builder", "definitions"].includes(next)) {
      query.set("sourceKind", sourceRead.data.sourceKind); query.set("sourceId", sourceRead.data.sourceId);
    }
    navigationAllowed.current = preserveDraft;
    workspace.open(`${base}/${next}${query.size ? `?${query}` : ""}`);
    navigationAllowed.current = false;
  }
  async function act(work, notice) {
    const operationEpoch = identityEpoch;
    if (!mounted.current || identity.current.epoch !== operationEpoch) return null;
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await work();
      if (!mounted.current || identity.current.epoch !== operationEpoch) return null;
      if (!result?.ok) {
        if (result?.reason === "stale_approval") setError(t("automation.pages.versionUnapproved"));
        else if (result?.reason === "changes_requested") setError(t("automation.pages.changesRequestedNote"));
        else {
          const key = result?.reason === "stale_definition" ? "admin.automation.errorStale" : result?.reason === "duplicate_name" ? "admin.automation.errorDuplicateName" : result?.reason === "invalid_action" ? "admin.automation.errorInvalid" : result?.reason === "scope_required" ? "admin.automation.errorScopeRequired" : result?.reason === "appointment_supervision" ? "admin.automation.errorAppointmentSupervision" : "admin.automation.errorUnavailable";
          setError(t(key));
        }
        return null;
      }
      if (notice) onNotice(notice);
      await load();
      if (!mounted.current || identity.current.epoch !== operationEpoch) return null;
      setRevision((value) => value + 1);
      return result.data;
    } catch { if (mounted.current && identity.current.epoch === operationEpoch) setError(t("admin.automation.errorUnavailable")); return null; }
    finally { if (mounted.current && identity.current.epoch === operationEpoch) { busyRef.current = false; setBusy(false); } }
  }
  function startDraft(next = NEW_DRAFT) {
    if (hasContext && sourceRead.state === "loading") return;
    if (hasContext && sourceRead.state !== "ready") { setError(t("automation.pages.sourceUnauthorized")); return; }
    const metadata = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === next.triggerKind);
    if (sourceRead.data && metadata?.source !== sourceRead.data.sourceKind) { setError(t("automation.pages.recipeIncompatible")); return; }
    if (draft && !window.confirm(t("automation.replace.unsaved.draft"))) return;
    setDraft({ ...next, schemaVersion: control.capabilities?.schemaVersion === 2 ? 2 : 1, conditions: { ...next.conditions, ...(sourceRead.data ? { sourceId: sourceRead.data.sourceId, chapterId: sourceRead.data.chapterId } : {}) }, actionConfig: { ...next.actionConfig } });
    open("builder", {}, { preserveDraft: true });
  }
  async function saveDraft() {
    const saved = await act(() => api.saveDefinition(session, draft), t("admin.automation.saved"));
    if (saved) { setDraft(null); open("definition", { definition: saved.id || draft.id }, { preserveDraft: true }); }
  }
  async function createPreview(definition) {
    const result = await act(() => api.previewDefinition ? api.previewDefinition(session, definition.id) : api.previewRun(session, definition.id));
    if (result) { setPreview({ ...result, definitionStatus: definition.status, approvedVersion: definition.reviewStatus ? definition.reviewStatus === "approved" && definition.reviewVersion === definition.version : undefined }); setPhrase(""); }
  }
  const ask = (next) => { setConfirmation(next); setPhrase(""); };
  const canConfirm = Boolean(confirmation?.phrase) && phrase === confirmation.phrase;
  const confirmationReason = confirmation?.phrase && !canConfirm
    ? t(phrase ? "automation.pages.confirmationMismatch" : "automation.pages.confirmationNeeded")
    : null;
  async function confirmAction(event) {
    event.preventDefault();
    if (!canConfirm) return;
    const result = await act(confirmation.work, confirmation.notice);
    if (result) { setConfirmation(null); setPhrase(""); setPreview(null); }
  }
  const sessionAccess = automationAccess(session);
  const access = control?.access ? { connected: true, reason: null, organizationId: control.organizationId, ...control.access } : sessionAccess;
  const connected = state === "ready" && control?.capabilities?.schemaVersion === 2 && access.canAuthor === true;
  const block = automationAuthoringBlock(state === "ready" ? access.reason : state, t);
  const workspaceReason = state === "ready" ? block?.message : state === "loading" ? t("admin.automation.loading") : block?.message || t("admin.automation.unavailable");
  const authoringUnavailableReason = block?.message || null;
  const nav = [["discover", t("automation.discover")], ["definitions", t("automation.automations")], ["recipes", t("automation.recipes")], ["history", t("automation.runs")], ["settings", t("automation.readiness.safety")]];
  // Every subroute names itself, so Builder, Definition or Run is never
  // mistaken for the overview when the workspace is not connected (Lovable
  // audit APP-STEWARD-03 to -05).
  const pageName = { builder: t("automation.pages.pageBuilder"), definition: t("automation.pages.pageDefinition"), run: t("automation.pages.pageRun") }[tab]
    || nav.find(([key]) => key === tab)?.[1] || t("automation.discover");
  const sourceContextPending = hasContext && sourceRead.state === "loading";
  const sourceBanner = hasContext ? <div className="automation-pages__body">{sourceRead.state === "loading" ? <ReadState state="loading" /> : sourceRead.state !== "ready" ? <p className="automation-pages__source-unavailable" role="alert">{t("automation.pages.sourceUnavailableBanner")}</p> : <p>{t("automation.pages.recipeSourceLimited")} <a href={workspaceHref(automationSourceHref({ sourceAvailable: true, ...sourceRead.data }) || base)}>{t("automation.back.source")}</a></p>}</div> : null;
  return <article className="automation-pages plane-card" aria-label={t("automation.automation.workspace")}>
    <header className="automation-pages__masthead">
      <p className="automation-discover__eyebrow">{t("automation.governed.staff.tools")}</p>
      <h1>{t("automation.automations")}</h1>
      <p>{t("automation.pages.workspaceIntro")}</p>
    </header>
    <nav className="automation-pages__nav" aria-label={t("automation.automation.pages")}>{nav.map(([key, label]) => <a key={key} href={workspaceHref(`${base}/${key}`)} aria-current={tab === key ? "page" : undefined} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); open(key); }}>{label}</a>)}</nav>
    {state !== "ready" && <div className="automation-pages__body automation-pages__setup"><h2>{t("automation.pages.setupFor", { page: pageName })}</h2><p id="automation-workspace-status" role="status">{state === "loading" ? t("admin.automation.loading") : block?.message || t("admin.automation.unavailable")}</p><p>{t("automationAvailability.learningOpen")}</p>{block ? <a className="xus-btn" href={block.href}>{block.action}</a> : state !== "loading" && <button className="xus-btn" type="button" onClick={load}>{t("app.tryAgain")}</button>}</div>}
    {error && <p className="automation-pages__body automation-pages__error" role="alert">{error}</p>}
    {tab === "discover" && <AutomationDiscover connected={connected} access={access} workspaceState={state} blockedReason={workspaceReason} blockedReasonId={state !== "ready" ? "automation-workspace-status" : null} accessToken={accessToken} session={session} api={api} capabilities={control?.capabilities || null} opportunities={opportunities.rows} opportunitiesState={opportunities.state} opportunityScopeChapterId={opportunities.scopeChapterId} requestCompass={requestCompass} onStartDraft={startDraft} onOpenRecipes={() => open("recipes")} onRetry={loadOpportunities} />}
    {tab === "recipes" && <>
      {sourceBanner}
      <AutomationRecipeLibrary key={sourceRead.state === "ready" ? sourceRead.data?.sourceKind || "all" : "all"} initialGroup={sourceRead.state === "ready" ? ({ task: "tasks", case: "casework", appointment: "appointments", event: "events" })[sourceRead.data?.sourceKind] || "all" : "all"} capabilities={control?.capabilities || null} appointmentSupervision={control?.appointmentSupervision ?? null} connected={connected && !sourceContextPending} disabledReason={sourceContextPending ? t("automation.pages.sourceContextLoading") : authoringUnavailableReason} onChoose={(recipe) => startDraft(createAutomationRecipeDraft(recipe.id, { locale: lang, capabilities: control?.capabilities }))} />
    </>}
    {control && <>
      {tab !== "recipes" && sourceBanner}
      {tab === "builder" && (draft ? <AutomationGuidedBuilder draft={draft} setDraft={setDraft} capabilities={control.capabilities} api={api} session={session} busy={busy} onSave={saveDraft} onCancel={() => { if (window.confirm(t("automation.discard.unsaved.draft"))) { setDraft(null); open("definitions", {}, { preserveDraft: true }); } }} /> : <section className="automation-pages__body"><h2>{t("automation.start.recipe")}</h2><p>{t("automation.pages.noDraftInUrl")}</p><div className="xus-btnrow"><button className="xus-btn xus-btn--go" onClick={() => open("recipes")}>{t("automation.browse.recipes")}</button><button className="xus-btn" onClick={() => startDraft()}>{t("automation.custom.automation")}</button></div></section>)}
      {tab === "definitions" && <DefinitionList api={api} session={session} control={control} revision={revision} open={open} startDraft={startDraft} draft={draft} />}
      {tab === "definition" && <DefinitionDetail api={api} session={session} id={selectedDefinition} revision={revision} control={control} access={access} busy={busy} open={open} edit={startDraft} preview={createPreview} submit={(definition) => act(() => api.submitDefinition(session, definition.id, definition.version), t("automation.version.submitted.review"))} review={(definition, action, note = null) => act(() => api.reviewDefinition(session, definition.id, definition.version, action, note), action === "approve" ? t("automation.version.approved") : t("automation.changes.requested"))} changeStatus={(definition, status) => ask({ phrase: `${status.toUpperCase()} ${definition.id.slice(0, 8)}`, title: status === "active" ? t("automation.activate.definition") : status === "paused" ? t("automation.pause.definition") : t("automation.archive.definition"), body: t("automation.pages.definitionOnlyChange"), work: () => api.setDefinitionStatus(session, definition.id, status, definition.version), notice: t(`admin.automation.${status === "active" ? "activated" : status === "paused" ? "paused" : "archived"}`) })} />}
      {tab === "history" && <RunList api={api} session={session} control={control} revision={revision} definitionId={selectedDefinition} open={open} />}
      {tab === "run" && <RunDetail api={api} session={session} id={selectedRun} revision={revision} open={open} busy={busy} rollback={(run) => ask({ phrase: run.rollbackPhrase, title: t("admin.automation.rollbackTitle", { name: run.definitionName }), body: t("automation.pages.undoUnchangedOnly"), work: () => api.rollbackRun(session, run.id, run.rollbackPhrase), notice: t("admin.automation.rollbackComplete") })} />}
      {tab === "settings" && <><Readiness control={control} access={access} busy={busy} act={act} api={api} session={session} ask={ask} />
        <AutomationDefaultRecipes control={control} open={open} />
        <AutomationRoutingRules api={api} session={session} act={act} busy={busy} revision={revision} /></>}
      {preview && tab === "definition" && <section className="automation-pages__body automation-pages__summary" aria-labelledby="connected-preview-title"><h2 id="connected-preview-title">{t("admin.automation.previewTitle", { name: preview.definitionName })}</h2><p>{t("admin.automation.previewBody")}</p><Counts run={preview} planned />
        {(!control.settings.enabled || preview.definitionStatus !== "active") && <p role="status">{t("admin.automation.previewBlocked")}</p>}
        <p>{t("automation.pages.previewNoEffects")}</p>
        <div className="xus-btnrow"><BusyButton className="xus-btn xus-btn--go" aria-describedby="automation-run-now-requirements" pending={busy} disabled={!access.canOperate || !control.settings.enabled || preview.definitionStatus !== "active" || preview.approvedVersion === false} onClick={() => ask({ phrase: preview.confirmationPhrase, title: t("admin.automation.runNow"), body: t("automation.pages.runPreviewedVersion"), work: () => api.executeRun(session, preview.id, preview.confirmationPhrase), notice: t("admin.automation.runComplete") })}>{t("admin.automation.runNow")}</BusyButton><BusyButton className="xus-btn" pending={busy} onClick={() => { setPreview(null); setConfirmation(null); }}>{t("admin.cancel")}</BusyButton></div>
        <p id="automation-run-now-requirements" className="automation-pages__disabled-reason">{access.canOperate ? t("automation.pages.runRequiresActive") : t("automation.pages.executeAdminOnly")}</p>
      </section>}
      {confirmation && <form className="automation-pages__body automation-pages__summary" onSubmit={confirmAction}>
        <h2>{confirmation.title}</h2>
        <p>{confirmation.body}</p>
        <label className="xus-field">{t("admin.automation.typePhrase", { phrase: confirmation.phrase })}<input className="xus-input" autoComplete="off" value={phrase} onChange={(event) => setPhrase(event.target.value)} /></label>
        <div className="xus-btnrow">
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={!canConfirm} disabledReason={confirmationReason}>{t("admin.automation.confirm")}</BusyButton>
          <BusyButton className="xus-btn" type="button" pending={busy} onClick={() => setConfirmation(null)}>{t("admin.cancel")}</BusyButton>
        </div>
      </form>}
    </>}
  </article>;
}

function Counts({ run, planned = false }) {
  const { t } = useLang();
  const effects = planned ? run.willCreate ?? 0 : run.effectsCreated ?? 0;
  const lineKey = planned ? "automation.counts.planned" : "automation.counts.applied";
  return <div><p>{t(lineKey, { candidates: run.candidatesCount ?? 0, effects, skipped: run.effectsSkipped ?? 0, failed: run.effectsFailed ?? 0 })}</p>
    {run.candidatesCount === 0 && <p>{t("automation.counts.none")}</p>}
    {run.deduplicatedCount > 0 && <p>{t("automation.counts.deduped", { count: run.deduplicatedCount })}</p>}
    {run.capLimitedCount > 0 && <p>{t("automation.counts.capLimited", { count: run.capLimitedCount })}</p>}
  </div>;
}

function DefinitionList({ api, session, control, revision, open, startDraft, draft }) {
  const { lang, t } = useLang();  const [page, setPage] = useState(1); const [search, setSearch] = useState(""); const [status, setStatus] = useState("");
  const result = useRead(() => readWithLegacyFallback(api.getDefinitions && (() => api.getDefinitions(session, { page, pageSize: PAGE_SIZE, search, status: status || undefined })), control, () => {
    const rows = control.definitions.filter((row) => (!status || row.status === status) && row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return { ok: true, data: { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE } };
  }), [api, session, page, search, status, revision, control]);
  return <section className="automation-pages__body"><h2>{t("automation.your.automations")}</h2><p>{t("automation.pages.recipesNotImported")}</p><div className="xus-btnrow"><button className="xus-btn xus-btn--go" onClick={() => open("recipes")}>{t("automation.browse.recipes")}</button><button className="xus-btn" onClick={() => startDraft()}>{t("automation.custom.automation")}</button>{draft && <button className="xus-btn" onClick={() => open("builder", {}, { preserveDraft: true })}>{t("automation.resume.unsaved.draft")}</button>}</div>
    <div className="automation-pages__toolbar"><label className="xus-field">{t("automation.find.automation")}<input className="xus-input" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label><label className="xus-field">{t("automation.definition.status")}<select className="xus-input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">{t("automation.all.statuses")}</option>{["draft", "active", "paused", "archived"].map((value) => <option key={value} value={value}>{t(`admin.automation.status.${value}`)}</option>)}</select></label></div>
    <ReadState state={result.state} />
    {result.state === "ready" && <>{result.data.rows.length === 0 && <div className="automation-pages__summary"><p>{search || status ? t("automation.pages.noDefinitionsMatch") : t("automation.pages.emptyWorkspace")}</p><p>{control.schedulerConfigured ? t("automation.scheduler.installed") : t("automation.pages.schedulerMissing")} {control.settings.enabled ? t("automation.pages.masterEnabledNeedsActive") : t("automation.pages.masterPaused")}</p></div>}
      <ul className="automation-pages__list">{result.data.rows.map((definition) => <li key={definition.id}><h3>{definition.name}</h3><p>{t(`admin.automation.status.${definition.status}`)} · {AUTOMATION_TRIGGER_METADATA.find((item) => item.id === definition.triggerKind)?.label[lang]}{definition.recipeKey ? ` · ${t("automation.defaults.badge")}` : ""}</p><div><button className="xus-btn" onClick={() => open("definition", { definition: definition.id })}>{t("automation.open.automation")}: {definition.name}</button></div></li>)}</ul><AutomationPager {...result.data} onChange={setPage} /></>}
  </section>;
}

// #9946: why Edit or Preview is unavailable to this viewer, in the order the
// button's own disabled test checks it. Each sentence is about the viewer:
// the server's canEdit is per viewer (an approver may still edit an approved
// recipe default), and canPreview follows automation_v3_definition_visible.
// The approved reason names the one next step this page offers every viewer
// who can open it (only author roles can): Custom automation on Automations,
// which starts a new, empty draft (startDraft with NEW_DRAFT), not a copy.
function editBlockedReason(definition, t) {
  if (definition.status === "archived") return t("automation.pages.editArchived");
  if (definition.sourceFilterAvailable === false) return t("automation.pages.sourceUnavailableBlocked");
  if (definition.canEdit !== false) return null;
  if (definition.reviewStatus === "submitted") return t("automation.pages.editWaitingReview");
  if (definition.reviewStatus === "approved") return t("automation.pages.editApproved");
  return t("automation.pages.editAuthorOrApprover");
}

function previewBlockedReason(definition, t) {
  if (definition.status === "archived") return t("automation.pages.previewArchived");
  if (definition.sourceFilterAvailable === false) return t("automation.pages.sourceUnavailableBlocked");
  if (definition.canPreview !== false) return null;
  return t(definition.reviewStatus === "draft" ? "automation.pages.previewDraft" : "automation.pages.previewNoAccess");
}

function DefinitionDetail({ api, session, id, revision, control, access, busy, open, edit, preview, submit, review, changeStatus }) {
  const { lang, t } = useLang();  const result = useRead(() => !isUuid(id) ? { ok: false } : readWithLegacyFallback(api.getDefinition && (() => api.getDefinition(session, id)), control, () => { const definition = control.definitions.find((row) => row.id === id); return definition ? { ok: true, data: { definition } } : { ok: false }; }), [api, session, id, revision, control]);
  const definition = result.data?.definition;
  const latest = latestVisibleRun(control.runs, definition?.id);
  return <section className="automation-pages__body">
    <h2>{t("automation.automation.details")}</h2><ReadState state={result.state} />
    {definition && <>
      <h3>{definition.name}</h3>
      <dl className="automation-pages__facts">
        <dt>{t("automation.status")}</dt><dd>{t(`admin.automation.status.${definition.status}`)}</dd>
        <dt>{t("automation.when")}</dt><dd>{AUTOMATION_TRIGGER_METADATA.find((item) => item.id === definition.triggerKind)?.label[lang]}</dd>
        <dt>{t("automation.action")}</dt><dd>{AUTOMATION_ACTION_METADATA.find((item) => item.id === definition.actionKind)?.label[lang]}</dd>
        <dt>{t("automation.conditions")}</dt><dd>{t("automation.thresholdDays", { days: definition.thresholdDays })}{["status", "deadlineKind", "priority", "assignment"].filter((key) => definition.conditions?.[key]).map((key) => ` · ${automationConditionLabel(definition.conditions[key], lang)}`).join("")}</dd>
        <dt>{t("automation.scope")}</dt><dd>{definition.sourceFilterAvailable === false ? t("automation.pages.sourceUnavailableKept") : <>{definition.conditions?.chapterId ? t("automation.selected.authorized.chapter") : t("automation.all.authorized.chapters")}{definition.conditions?.sourceId ? t("automation.selected.source.only") : ""}</>}</dd>
        <dt>{t("automation.next.planned.evaluation")}</dt><dd>{!control.settings.enabled || definition.status !== "active" ? t("automation.pages.notScheduled") : !control.schedulerConfigured ? t("automation.scheduler.unavailable") : formatTime(definition.nextRunAt, lang) || t("automation.yet.scheduled")}</dd>
        <dt>{t("automation.last.visible.outcome")}</dt><dd>{latest ? `${t(`admin.automation.runStatus.${latest.status}`)}${formatTime(latest.completedAt || latest.startedAt, lang) ? ` · ${formatTime(latest.completedAt || latest.startedAt, lang)}` : ""}` : t("automation.pages.noDefinitionRun")}</dd>
        <dt>{t("automation.version")}</dt><dd>{definition.version}</dd>
        {definition.recipeKey && <><dt>{t("automation.defaults.origin")}</dt><dd>{t("automation.defaults.badge")} · {t(`automation.defaults.recipe.${definition.recipeKey}`)}</dd></>}
      </dl>
      {definition.scheduledAuthority === "pending_approval" && <p role="status">{t("automation.defaults.systemAuthority")}</p>}
      <p>{t("automation.pages.plannedNotRealtime")}</p>
      {definition.reviewStatus && <AutomationReviewPanel definition={definition} access={access} busy={busy} onSubmit={() => submit(definition)} onApprove={(note) => review(definition, "approve", note)} onRequestChanges={(note) => review(definition, "request_changes", note)} />}
      <div className="xus-btnrow">
        <BusyButton className="xus-btn" pending={busy} disabled={definition.canEdit === false || definition.status === "archived" || definition.sourceFilterAvailable === false} disabledReason={editBlockedReason(definition, t)} onClick={() => edit({ ...definitionDraft(definition), id: definition.id, version: definition.version, schemaVersion: 2, conditions: definition.conditions || {}, actionKind: definition.actionKind, actionConfig: definition.actionConfig || {} })}>{t("admin.automation.edit")}</BusyButton>
        <BusyButton className="xus-btn" pending={busy} disabled={definition.canPreview === false || definition.status === "archived" || definition.sourceFilterAvailable === false} disabledReason={previewBlockedReason(definition, t)} onClick={() => preview(definition)}>{t("admin.automation.preview")}</BusyButton>
        {access.canOperate && definition.status !== "archived" && <><BusyButton className="xus-btn" aria-describedby={definition.status !== "active" && definition.reviewStatus && !definition.canActivate ? "automation-activation-unavailable" : undefined} pending={busy} disabled={definition.status !== "active" && definition.reviewStatus && !definition.canActivate || definition.sourceFilterAvailable === false && definition.status !== "active"} onClick={() => changeStatus(definition, definition.status === "active" ? "paused" : "active")}>{t(definition.status === "active" ? "admin.automation.pause" : "admin.automation.activate")}</BusyButton><BusyButton className="xus-btn xus-btn--danger" pending={busy} onClick={() => changeStatus(definition, "archived")}>{t("admin.automation.archive")}</BusyButton></>}
        <button className="xus-btn" onClick={() => open("history", { definition: definition.id })}>{t("automation.view.runs")}</button>
      </div>
      {access.canOperate && definition.status !== "active" && definition.reviewStatus && !definition.canActivate && <p id="automation-activation-unavailable" className="automation-pages__disabled-reason" role="status">{t("automation.pages.activationNeedsApproval")}</p>}
      {definition.status === "active" && definition.dependencyReady === false && <p className="automation-pages__disabled-reason" role="status">{t("automation.pages.scheduledAuthorityUnavailable")}</p>}
    </>}
  </section>;
}

function RunList({ api, session, control, revision, definitionId, open }) {
  const { lang, t } = useLang();  const [page, setPage] = useState(1); const [status, setStatus] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const fromInstant = from && Number.isFinite(Date.parse(from)) ? new Date(from).toISOString() : undefined;
  const toInstant = to && Number.isFinite(Date.parse(to)) ? new Date(to).toISOString() : undefined;
  const invalidRange = fromInstant && toInstant && fromInstant > toInstant;
  const result = useRead(() => invalidRange ? { ok: false } : readWithLegacyFallback(api.getRuns && (() => api.getRuns(session, { page, pageSize: PAGE_SIZE, status: status || undefined, definitionId: isUuid(definitionId) ? definitionId : undefined, from: fromInstant, to: toInstant })), control, () => {
    const rows = control.runs.filter((row) => (!status || row.status === status) && (!definitionId || row.definitionId === definitionId) && (!fromInstant || row.startedAt >= fromInstant) && (!toInstant || row.startedAt <= toInstant));
    return { ok: true, data: { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE } };
  }), [api, session, page, status, definitionId, revision, control, fromInstant, toInstant, invalidRange]);
  return <section className="automation-pages__body"><h2>{t("automation.run.history")}</h2><div className="automation-pages__toolbar"><label className="xus-field">{t("automation.run.status")}<select className="xus-input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">{t("automation.all.outcomes")}</option>{["previewed", "in_progress", "no_op", "succeeded", "partial", "failed", "rolled_back", "rollback_partial"].map((value) => <option key={value} value={value}>{t(`admin.automation.runStatus.${value}`)}</option>)}</select></label><label className="xus-field">{t("automation.from.device.timezone")}<input type="datetime-local" className="xus-input" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label><label className="xus-field">{t("automation.until.device.timezone")}<input type="datetime-local" className="xus-input" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label></div>
    {definitionId && <button className="xus-btn" onClick={() => open("history")}>{t("automation.show.all.definitions")}</button>}
    {control.capabilities?.schemaVersion !== 2 && <p>{t("automation.pages.legacyHistoryCap")}</p>}
    {invalidRange ? <p className="automation-pages__error" role="alert">{t("automation.pages.rangeOrderInvalid")}</p> : <ReadState state={result.state} />}{result.state === "ready" && <>{result.data.rows.length === 0 && <p>{t("automation.pages.noRunsMatch")}</p>}<ul className="automation-pages__list">{result.data.rows.map((run) => <li key={run.id}><h3>{run.definitionName}</h3><p>{t(`admin.automation.runStatus.${run.status}`)} · {formatTime(run.completedAt || run.startedAt, lang)}</p><Counts run={run} /><div><button className="xus-btn" onClick={() => open("run", { run: run.id })}>{t("automation.inspect.run")}</button></div></li>)}</ul><AutomationPager {...result.data} onChange={setPage} /></>}</section>;
}

function RunDetail({ api, session, id, revision, open, busy, rollback }) {
  const { lang, t } = useLang();  const [page, setPage] = useState(1);
  const result = useRead(() => isUuid(id) && api.getRun ? api.getRun(session, id, { page, pageSize: PAGE_SIZE }) : { ok: false }, [api, session, id, page, revision]);
  const run = result.data?.run;
  return <section className="automation-pages__body"><h2>{t("automation.run.details")}</h2><ReadState state={result.state} />{run && <><h3>{run.definitionName}</h3><p>{t(`admin.automation.runStatus.${run.status}`)} · {formatTime(run.completedAt || run.startedAt, lang)}</p><Counts run={run} /><div className="xus-btnrow"><button className="xus-btn" onClick={() => open("definition", { definition: run.definitionId })}>{t("automation.open.definition")}</button>{run.rollbackEligible && run.rollbackPhrase && <BusyButton className="xus-btn xus-btn--danger" pending={busy} onClick={() => rollback(run)}>{t("admin.automation.rollback")}</BusyButton>}</div><RunDefinitionSnapshot run={run} /><h3>{t("automation.sources.effects")}</h3>{!result.data.effects?.rows?.length && <p>{t("automation.pages.noEffectRows")}</p>}<ul className="automation-pages__list">{result.data.effects?.rows?.map((effect) => <EffectRow key={effect.id} effect={effect} selectedHat={session?.selectedHat} />)}</ul>{result.data.effects && <AutomationPager {...result.data.effects} onChange={setPage} />}</>}</section>;
}

function RunDefinitionSnapshot({ run }) {
  const { lang, t } = useLang();  const snapshot = run.definitionSnapshotAvailable === true ? run.definition : null;
  if (!snapshot) return <section aria-labelledby="automation-run-snapshot-title"><h3 id="automation-run-snapshot-title">{t("automation.evaluated.definition")}</h3><p>{t("automation.pages.noHistoricalSnapshot")}</p></section>;
  const trigger = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === snapshot.triggerKind);
  const action = AUTOMATION_ACTION_METADATA.find((item) => item.id === snapshot.actionKind);
  const conditions = snapshot.conditions || {};
  const restrictedFilter = snapshot.sourceFilterAvailable === false;
  const priority = snapshot.actionKind === "raise_task_priority" ? snapshot.actionConfig?.priority : snapshot.actionKind === "create_standard_task" ? snapshot.taskPriority : null;
  const priorities = { low: t("automation.low"), medium: t("automation.medium"), high: t("automation.high") };
  return <section aria-labelledby="automation-run-snapshot-title"><h3 id="automation-run-snapshot-title">{t("automation.evaluated.definition")}</h3><p>{t("automation.pages.snapshotDescribesRun")}</p><dl className="automation-pages__facts">
    <dt>{t("automation.evaluated.version")}</dt><dd>{snapshot.version}</dd>
    <dt>{t("automation.trigger")}</dt><dd>{trigger?.label[lang] || t("automation.historical.trigger.unavailable")}</dd>
    <dt>{t("automation.evaluated.conditions")}</dt><dd>{t("automation.thresholdDays", { days: snapshot.thresholdDays })}{conditions.status ? ` · ${automationConditionLabel(conditions.status, lang)}` : ""}{conditions.deadlineKind ? ` · ${automationConditionLabel(conditions.deadlineKind, lang)}` : ""}{conditions.priority ? ` · ${t("automation.priority")}: ${automationConditionLabel(conditions.priority, lang)}` : ""}{conditions.assignment ? ` · ${automationConditionLabel(conditions.assignment, lang)}` : ""}</dd>
    <dt>{t("automation.source.population")}</dt><dd>{restrictedFilter ? t("automation.pages.historicalFilterRestricted") : conditions.sourceId ? t("automation.pages.historicalSelectedSource") : conditions.chapterId ? t("automation.pages.historicalSelectedChapter") : t("automation.pages.historicalAllChapters")}</dd>
    <dt>{t("automation.evaluated.action")}</dt><dd>{action?.label[lang] || t("automation.historical.action.unavailable")}{priority ? ` · ${priorities[priority] || t("automation.priority.unavailable")}` : ""}</dd>
    <dt>{t("automation.evaluation.cadence")}</dt><dd>{snapshot.cadence === "hourly" ? t("automation.hourly") : snapshot.cadence === "weekly" ? t("automation.weekly") : snapshot.cadence === "daily" ? t("automation.daily") : t("automation.historical.cadence.unavailable")}</dd>
  </dl></section>;
}

function EffectRow({ effect, selectedHat }) {
  const { lang, t } = useLang();
  const sourceHref = automationSourceHref(effect, selectedHat), effectHref = automationEffectHref(effect);
  const statusKey = `automation.effect.${effect.status}`;
  const reasonKey = effect.reasonCode ? `automation.reason.${effect.reasonCode}` : null;
  return <li><strong>{AUTOMATION_ACTION_METADATA.find((item) => item.id === effect.actionKind)?.label[lang] || t("automation.automation.effect")}</strong><p>{effect.sourceAvailable ? t("automation.pages.sourceAccessConfirmed") : t("automation.source.unavailable.restricted")}</p><p>{t(["pending", "created", "rolled_back", "failed", "skipped"].includes(effect.status) ? statusKey : "automation.effect.unknown")}{reasonKey && ["human_modified", "irreversible", "source_unavailable", "action_failed", "deduplicated", "cap_reached", "permission_lost"].includes(effect.reasonCode) ? ` · ${t(reasonKey)}` : ""}</p><div className="xus-btnrow">{sourceHref && <a href={workspaceHref(sourceHref)}>{t("automation.open.source")}</a>}{effectHref && <a href={workspaceHref(effectHref)}>{t("automation.open.resulting.task")}</a>}</div>{effect.rollbackAvailable && <p>{t("automation.pages.undoEligible")}</p>}</li>;
}

function Readiness({ control, access, busy, act, api, session, ask }) {
  const { lang, t } = useLang();
  const [cap, setCap] = useState(String(control.settings.maxEffectsPerRun));
  const capRangeId = useId();
  const capValue = Number(cap);
  const { min, max } = SAFETY_CAP_LIMITS;
  const capValid = Number.isSafeInteger(capValue) && capValue >= min && capValue <= max;
  const capChanged = capValue !== control.settings.maxEffectsPerRun;
  const capRange = t("automation.pages.safetyCapRange", SAFETY_CAP_LIMITS);
  const capReason = !capValid ? capRange
    : !capChanged ? t("automation.pages.safetyCapUnchanged") : null;
  const target = !control.settings.enabled;
  const latest = latestVisibleRun(control.runs);
  return <section className="automation-pages__body">
    <h2>{t("automation.readiness.safety")}</h2>
    <dl className="automation-pages__facts">
      <dt>{t("automation.scheduler")}</dt><dd>{t(control.schedulerConfigured ? "admin.automation.schedulerOn" : "admin.automation.schedulerOff")}</dd>
      <dt>{t("automation.master.switch")}</dt><dd>{t(control.settings.enabled ? "admin.automation.enabled" : "admin.automation.disabled")}</dd>
      <dt>{t("automation.installed.capabilities")}</dt><dd>{control.capabilities?.schemaVersion === 2 ? t("automation.pages.connectedVersion") : t("automation.pages.legacyOnly")}</dd>
      <dt>{t("automation.source.recipient.readiness")}</dt><dd>{t("automation.pages.notPreApproved")}</dd>
      <dt>{t("automation.last.visible.outcome")}</dt><dd>{latest ? `${t(`admin.automation.runStatus.${latest.status}`)}${formatTime(latest.completedAt || latest.startedAt, lang) ? ` · ${formatTime(latest.completedAt || latest.startedAt, lang)}` : ""}` : t("automation.pages.noRunInHistory")}</dd>
    </dl>
    <p>{t("automation.pages.schedulerActiveSeparate")}</p>
    {access.canOperate ? <><div><BusyButton className={`xus-btn ${target ? "xus-btn--go" : "xus-btn--danger"}`} pending={busy} onClick={() => ask({ phrase: target ? "ENABLE AUTOMATION" : "PAUSE AUTOMATION", title: t(target ? "admin.automation.enableAll" : "admin.automation.pauseAll"), body: t("admin.automation.safetyBody"), work: () => api.setEnabled(session, target, target ? "ENABLE AUTOMATION" : "PAUSE AUTOMATION"), notice: t(target ? "admin.automation.enabledNotice" : "admin.automation.pausedNotice") })}>{t(target ? "admin.automation.enableAll" : "admin.automation.pauseAll")}</BusyButton></div>
    <form onSubmit={(event) => { event.preventDefault(); if (capValid && capChanged) void act(() => api.setSafetyCap(session, capValue), t("admin.automation.capSaved")); }}>
      <label className="xus-field">{t("automation.pages.maxEffectsPerRun")}<input className="xus-input" type="number" min={min} max={max} step="1" aria-describedby={capRangeId} value={cap} onChange={(event) => setCap(event.target.value)} /></label>
      <p id={capRangeId}>{capRange}</p>
      <p>{t("automation.pages.sharedLimitNote")}</p>
      <BusyButton type="submit" className="xus-btn" pending={busy} disabled={!capValid || !capChanged} disabledReason={capReason}>{t("admin.save")}</BusyButton>
    </form></> : <p role="status">{t("automation.pages.safetyReadOnly")}</p>}
  </section>;
}

function latestVisibleRun(runs = [], definitionId) {
  return runs.filter((run) => !definitionId || run.definitionId === definitionId).reduce((latest, run) => !latest || (Date.parse(run.startedAt) || 0) > (Date.parse(latest.startedAt) || 0) ? run : latest, null);
}
