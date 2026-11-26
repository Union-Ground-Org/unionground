import { WorkspaceStatusState } from "../components/WorkspaceStatusState.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PlaneHeader } from "../components/PlaneHeader.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../lib/i18n.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { returnFocusAfterModal, useModalExit } from "../lib/useTransitionPresence.js";
import { DemoVoiceStudio } from "../components/DemoVoiceStudio.jsx";
import { WorkspaceSection, useWorkspace, useWorkspaceTitle, workspaceHref, WorkspaceListPager, workspaceListRows } from "../components/WorkspacePages.jsx";
import { StaffEngagement } from "../features/engagement/StaffEngagement.jsx";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "../lib/loadDeadline.js";
import { OfficerRemovalEditor, OfficerRemovalSummary, emptyRemovalDraft, removalDraftFromCampaign } from "../features/governance/OfficerRemovalEditor.jsx";
import { NominationsManager } from "../features/elections/NominationsManager.jsx";
import { BusyButton, BusyFieldset } from "../components/BusyControls.jsx";
import { campaignPublishWithdrawn, isCampaignCloseDateRefusal } from "../lib/campaignPublish.js";
import { runBusyWrite } from "../lib/busyWrite.js";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";

// These RPCs share 22023 across unrelated validation and stale-data refusals.
// Match the deployed messages behind that code and never render the raw text.
const CAMPAIGN_INPUT_REFUSALS = new Map([
  ["both campaign titles are required", "campaigns.refusal.title"],
  ["campaign details are too long", "campaigns.refusal.details"],
  ["close time is required", "campaigns.refusal.closeTime"],
  ["ballot quorum is required", "campaigns.refusal.quorum"],
  ["campaigns need between 2 and 20 options", "campaigns.refusal.optionCount"],
  ["both option labels are required", "campaigns.refusal.optionLabels"],
  ["campaign not found", "campaigns.refusal.unavailable"],
  ["a removal reason of at least 10 characters is required", "campaigns.refusal.removalReason"],
  ["officer not found in this scope", "campaigns.refusal.officer"],
  ["voting has not ended", "campaigns.refusal.votingOpen"],
  ["removal outcome already recorded", "campaigns.refusal.alreadyRecorded"],
  ["officer is no longer in this organization", "campaigns.refusal.officerLeft"],
]);

function campaignRefusalKey(error, fallback) {
  const message = String(error?.message ?? "").split(": ").at(-1);
  if (error?.code === "42501" && message === "officer removal ballots are turned off") return "officerRemoval.off";
  const validation = error?.code === "22023" ? CAMPAIGN_INPUT_REFUSALS.get(message) : undefined;
  return rpcRefusalKey(error, validation || fallback);
}

function emptyDraft(scope = "chapter") {
  const close = new Date(Date.now() + (7 * 86400000));
  close.setMinutes(close.getMinutes() - close.getTimezoneOffset());
  return {
    id: "", kind: "ballot", scope, titleEn: "", titleEs: "",
    bodyEn: "", bodyEs: "", closesAt: close.toISOString().slice(0, 16),
    quorumTarget: 1,
    options: [{ labelEn: "", labelEs: "" }, { labelEn: "", labelEs: "" }],
  };
}

// A Spanish field saved as the English fallback reopens blank, so the editor
// never shows English text in a Spanish box.
function ownSpanish(english, spanish) {
  return spanish && spanish !== english ? spanish : "";
}

export function draftFromCampaign(campaign) {
  const close = new Date(campaign.closesAt);
  close.setMinutes(close.getMinutes() - close.getTimezoneOffset());
  return {
    id: campaign.id, kind: campaign.kind, scope: campaign.scope,
    titleEn: campaign.titleEn || "", titleEs: ownSpanish(campaign.titleEn, campaign.titleEs),
    bodyEn: campaign.bodyEn || "", bodyEs: campaign.bodyEs || "",
    closesAt: close.toISOString().slice(0, 16),
    quorumTarget: campaign.kind === "ballot" ? Number(campaign.quorumTarget) || 1 : null,
    options: campaign.options.map((option) => ({ labelEn: option.labelEn || "", labelEs: ownSpanish(option.labelEn, option.labelEs) })),
  };
}

function campaignTitle(campaign, lang) {
  return lang === "es" ? (campaign.titleEs || campaign.titleEn) : campaign.titleEn;
}

function stateOrder(state) {
  return state === "draft" ? 0 : state === "open" ? 1 : 2;
}

function DraftAction({ feedback, announce = true, children }) {
  return <div className="cam-feedback-action">
    {children}
    <p className="cam-feedback" role={announce ? "status" : undefined}>{feedback}</p>
  </div>;
}

function trackPressFocus(control) {
  let moved = false;
  const markMoved = () => { moved = true; };
  const hadFocus = control && document.activeElement === control;
  if (hadFocus) control.addEventListener("blur", markMoved, { once: true });
  return () => {
    if (!hadFocus) return false;
    control.removeEventListener("blur", markMoved);
    return !moved && document.activeElement === control;
  };
}

function hasResultAction(rows, removalDetails, campaign, isOutcome) {
  return rows.some((row) => row.id === campaign.id && row.kind === campaign.kind
    && (isOutcome ? removalDetails.has(row.id) : row.state === "draft"));
}

// The confirmation closes with the prototype modal's 200 ms scrim fade
//: it keeps focus
// and ignores every further answer until it has gone, then hands focus back
// to the control that opened it, or to the registry heading when a publish or
// close took that control away.
function ConfirmDialog({ campaign, action, busy, error = "", closing = false, onTransitionEnd, onCancel, onConfirm }) {
  const { t, lang } = useLang();
  const layerRef = useRef(null);
  const headingRef = useRef(null);
  const returnFocusRef = useRef(typeof document === "undefined" ? null : document.activeElement);
  useModalIsolation(layerRef);
  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    headingRef.current?.focus();
    return () => {
      returnFocusAfterModal(returnFocus?.isConnected ? returnFocus : document.getElementById("cam-registry-title"));
    };
  }, []);
  const publishing = action === "publish";
  const settled = !busy && !closing;
  const cancel = () => { if (settled) onCancel(); };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      if (busy && !closing) return;
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) {
      event.preventDefault();
      headingRef.current?.focus();
      return;
    }
    const [first] = focusable;
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={layerRef}
      className="cam-dialog-layer"
      data-state={closing ? "closing" : undefined}
      onTransitionEnd={onTransitionEnd}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        cancel();
      }}
    >
      <section className="cam-dialog" role="dialog" aria-modal="true" aria-labelledby="cam-confirm-title" onKeyDown={onKeyDown}>
        <p className="cam-kicker">{t(`campaigns.confirm.${action}.kicker`)}</p>
        <h2 id="cam-confirm-title" ref={headingRef} tabIndex="-1">{t(`campaigns.confirm.${action}.title`)}</h2>
        <p>{t(`campaigns.confirm.${action}.body`)}</p>
        <dl className="cam-summary">
          <div><dt>{t("campaigns.summary.campaign")}</dt><dd>{campaignTitle(campaign, lang)}</dd></div>
          <div><dt>{t("campaigns.summary.eligible")}</dt><dd>{t(campaign.scope === "union" ? "campaigns.scope.unionAudience" : "campaigns.scope.chapterAudience")}</dd></div>
          <div><dt>{t("campaigns.summary.closes")}</dt><dd>{formatDateTimeWithZone(campaign.closesAt, lang)}</dd></div>
          {campaign.kind === "ballot" && <div><dt>{t("campaigns.quorum")}</dt><dd>{t("campaigns.quorumCount", { count: campaign.quorumTarget })}</dd></div>}
          <div><dt>{t("campaigns.options")}</dt><dd>{campaign.options.length}</dd></div>
        </dl>
        {error && <p className="cam-help" role="alert">{t(error)}</p>}
        <div className="cam-actions">
          <BusyButton className="cam-btn cam-btn--quiet" type="button" onClick={cancel} pending={busy}>{t("campaigns.cancel")}</BusyButton>
          <BusyButton className={`cam-btn ${publishing ? "cam-btn--go" : "cam-btn--close"}`} type="button" onClick={() => { if (!closing) onConfirm(); }} pending={busy}>
            {busy ? t("campaigns.saving") : t(`campaigns.confirm.${action}.button`)}
          </BusyButton>
        </div>
      </section>
    </div>
  );
}

function CampaignEditor({ draft, setDraft, canManageUnion, canManageChapter = true, busy, error = "", onCancel, onSave }) {
  const { t } = useLang();
  const titleRef = useRef(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const updateOption = (index, key, value) => set("options", draft.options.map((option, at) => at === index ? { ...option, [key]: value } : option));
  const moveOption = (index, by) => {
    const to = index + by;
    if (to < 0 || to >= draft.options.length) return;
    const next = [...draft.options];
    [next[index], next[to]] = [next[to], next[index]];
    set("options", next);
  };
  const submit = (event) => {
    event.preventDefault();
    onSave({ ...draft, closesAt: new Date(draft.closesAt).toISOString() });
  };
  return (
    <form className="cam-editor" onSubmit={submit} aria-busy={busy}>
      <div className="cam-editor__head">
        <div><p className="cam-kicker">{t("campaigns.editor.kicker")}</p><h2 ref={titleRef} tabIndex="-1">{t(draft.id ? "campaigns.editor.edit" : "campaigns.editor.new")}</h2></div>
        <BusyButton className="cam-btn cam-btn--quiet" type="button" onClick={onCancel} pending={busy}>{t("campaigns.cancel")}</BusyButton>
      </div>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.editor.typeScope")}</legend>
        <div className="cam-choice-row">
          <label><input type="radio" name="cam-kind" checked={draft.kind === "ballot"} onChange={() => set("kind", "ballot")} disabled={Boolean(draft.id)} /> {t("campaigns.kind.ballot")}</label>
          <label><input type="radio" name="cam-kind" checked={draft.kind === "pulse"} onChange={() => set("kind", "pulse")} disabled={Boolean(draft.id)} /> {t("campaigns.kind.pulse")}</label>
        </div>
        <div className="cam-choice-row">
          {canManageChapter && <label><input type="radio" name="cam-scope" checked={draft.scope === "chapter"} onChange={() => set("scope", "chapter")} /> {t("campaigns.scope.chapter")}</label>}
          {canManageUnion && <label><input type="radio" name="cam-scope" checked={draft.scope === "union"} onChange={() => set("scope", "union")} /> {t("campaigns.scope.union")}</label>}
        </div>
        <p className="cam-help">{t(draft.scope === "union" ? "campaigns.scope.unionHelp" : "campaigns.scope.chapterHelp")}</p>
      </BusyFieldset>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.editor.copy")}</legend>
        <p className="cam-help">{t("campaigns.spanishOptional")}</p>
        <div className="cam-grid">
          <label className="cam-field"><span>{t("campaigns.titleEn")}</span><input value={draft.titleEn} onChange={(e) => set("titleEn", e.target.value)} minLength="3" maxLength="160" required /></label>
          <label className="cam-field"><span>{t("campaigns.titleEs")}</span><input value={draft.titleEs} onChange={(e) => set("titleEs", e.target.value)} minLength="3" maxLength="160" /></label>
          <label className="cam-field"><span>{t("campaigns.bodyEn")}</span><textarea value={draft.bodyEn} onChange={(e) => set("bodyEn", e.target.value)} maxLength="1000" /></label>
          <label className="cam-field"><span>{t("campaigns.bodyEs")}</span><textarea value={draft.bodyEs} onChange={(e) => set("bodyEs", e.target.value)} maxLength="1000" /></label>
        </div>
      </BusyFieldset>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.editor.timing")}</legend>
        <div className="cam-grid cam-grid--timing">
          <label className="cam-field"><span>{t("campaigns.closesAt")}</span><input type="datetime-local" value={draft.closesAt} onChange={(e) => set("closesAt", e.target.value)} required /></label>
          {draft.kind === "ballot" ? <label className="cam-field"><span>{t("campaigns.quorum")}</span><input type="number" value={draft.quorumTarget} min="1" max="1000000" onChange={(e) => set("quorumTarget", e.target.value)} required /></label> : <p className="cam-help cam-help--boxed">{t("campaigns.pulseNoQuorum")}</p>}
        </div>
      </BusyFieldset>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.options")}</legend>
        <div className="cam-options">
          {draft.options.map((option, index) => <div className="cam-option" key={`option-${index}`}>
            <span className="cam-option__number">{index + 1}</span>
            <label className="cam-field"><span>{t("campaigns.optionEn", { count: index + 1 })}</span><input value={option.labelEn} onChange={(e) => updateOption(index, "labelEn", e.target.value)} maxLength="160" required /></label>
            <label className="cam-field"><span>{t("campaigns.optionEs", { count: index + 1 })}</span><input value={option.labelEs} onChange={(e) => updateOption(index, "labelEs", e.target.value)} maxLength="160" /></label>
            <div className="cam-order"><BusyButton type="button" className="cam-icon-btn" aria-label={t("campaigns.moveUp", { count: index + 1 })} pending={busy} disabled={index === 0} onClick={() => moveOption(index, -1)}>↑</BusyButton><BusyButton type="button" className="cam-icon-btn" aria-label={t("campaigns.moveDown", { count: index + 1 })} pending={busy} disabled={index === draft.options.length - 1} onClick={() => moveOption(index, 1)}>↓</BusyButton><BusyButton type="button" className="cam-icon-btn cam-icon-btn--danger" aria-label={t("campaigns.removeOption", { count: index + 1 })} pending={busy} disabled={draft.options.length === 2} onClick={() => set("options", draft.options.filter((_, at) => at !== index))}>×</BusyButton></div>
          </div>)}
        </div>
        <BusyButton type="button" className="cam-btn cam-btn--quiet" pending={busy} disabled={draft.options.length >= 20} onClick={() => set("options", [...draft.options, { labelEn: "", labelEs: "" }])}>{t("campaigns.addOption")}</BusyButton>
      </BusyFieldset>
      <div className="cam-actions cam-actions--sticky">
        {error && <p className="cam-feedback cam-feedback--error" role="alert">{error}</p>}
        <BusyButton className="cam-btn cam-btn--go" type="submit" pending={busy}>{busy ? t("campaigns.saving") : t("campaigns.saveDraft")}</BusyButton>
      </div>
    </form>
  );
}

const ENGAGEMENT_ORGANIZATION_ROLES = ["steward", "coordinator", "advisor", "admin", "vp"];

export function CampaignsView({ api, data = null, demo = false, sampleStudio = false, onProfile, onAssistant, engagementClient = null, engagementSession = null, onAppNotice = () => {}, onEngagementChanged = null, loadDeadlineMs = SHELL_LOAD_DEADLINE_MS }) {
  const workspace = useWorkspace();
  // The organization-wide engagement snapshot admits only an organization-wide
  // staff role (private.engagement_require_staff: has_organization_role over
  // these five); with the account's organization roles known and none of them
  // held, the studio skips that refused read . Unknown roles keep the
  // read, whose refusal still falls back to the chapter-only Weekly pool.
  const organizationRoles = data?.member?.organizationRoles;
  // No selected organization in the account data (memberApi leaves the roles
  // empty then) also counts as unknown: the server may still admit the account.
  const organizationSnapshot = !Array.isArray(organizationRoles) || Boolean(data?.rolesUnknown) || !data?.member?.organizationId
    || organizationRoles.some((role) => ENGAGEMENT_ORGANIZATION_ROLES.includes(role));
  // The sample studio exists only in the fixture preview. Signed in to a real
  // organization its address used to show the retired preview's "only in the
  // preview" card while the organization's own engagement studio sat one tab
  // away, so the address now opens that studio, keeping the tab when both
  // studios have it
  // (BUG-UG-CAMPAIGNS-SAMPLE-STUDIO-ADDRESS-SHOWS-RETIRED-PREVIEW-COPY-20261106).
  const studioRedirect = Boolean(workspace) && workspace.section === "campaigns-studio" && !sampleStudio && !demo;
  useEffect(() => {
    if (!studioRedirect) return;
    const tab = window.location.pathname.split("/")[4];
    const engagementTab = ["surveys", "weekly"].includes(tab) ? tab : "surveys";
    workspace.open(`/m/campaigns/engagement/${engagementTab}`, undefined, true);
  }, [studioRedirect, workspace]);
  const { t, lang } = useLang();
  const pageTitle = useWorkspaceTitle(t("nav.campaigns"));
  const [registry, setRegistry] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [visibleEnd, setVisibleEnd] = useState(6);
  const [draft, setDraft] = useState(null);
  const [confirm, setConfirm] = useState(null);
  // A failure belongs to the confirmation it came from; a new one starts clear.
  const [confirmError, setConfirmError] = useState("");
  useEffect(() => { setConfirmError(""); }, [confirm]);
  const confirmExit = useModalExit(confirm);
  const [busy, setBusy] = useState(false);
  const newCampaignBusyReason = useId();
  // Synchronous write locks (record 8435): a second activation before React
  // commits the busy state is refused. Each key names the record a write
  // changes, and each lock is released only by its own write.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  // REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001: removal details ride beside
  // the registry (get_officer_removal_ballot_details); without them every
  // ballot renders exactly as before.
  const [removal, setRemoval] = useState({ enabled: false, byId: new Map() });
  const [removalDraft, setRemovalDraft] = useState(null);
  const [draftError, setDraftError] = useState(null);
  const [draftReceipt, setDraftReceipt] = useState(null);
  const [removalFeedback, setRemovalFeedback] = useState(new Map());
  const [registryReceipt, setRegistryReceipt] = useState(null);
  const draftTrigger = useRef(null);
  const registryHeading = useRef(null);
  const latestLoad = useRef(0);
  const visibleActions = useRef(null);
  const openDraft = (next, trigger, isRemoval = false) => {
    if (busyWriteRef.current.size) return;
    draftTrigger.current = trigger;
    setDraftError(null);
    setDraftReceipt(null);
    setDraft(isRemoval ? null : next);
    setRemovalDraft(isRemoval ? next : null);
  };
  useEffect(() => {
    if (draftReceipt?.restoreFocus) returnFocusAfterModal(draftTrigger.current?.isConnected ? draftTrigger.current : registryHeading.current);
  }, [draftReceipt]);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    setError("");
    try {
      const next = await withLoadDeadline(api.load(), loadDeadlineMs);
      if (request !== latestLoad.current) return;
      setRegistry(next);
      if (api.removalDetails) {
        const ballotIds = (next?.campaigns || []).filter((campaign) => campaign.kind === "ballot").map((campaign) => campaign.id);
        const details = await withLoadDeadline(api.removalDetails(ballotIds), loadDeadlineMs);
        if (request === latestLoad.current) setRemoval(details);
      }
    } catch { if (request === latestLoad.current) setError(t("campaigns.error")); }
  }, [api, t, loadDeadlineMs]);
  useEffect(() => { load(); }, [load]);
  const campaigns = useMemo(() => [...(registry?.campaigns || [])]
    .sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || new Date(b.closesAt) - new Date(a.closesAt)), [registry]);
  const filtered = filter === "all" ? campaigns : campaigns.filter((campaign) => campaign.state === filter);
  const shownCampaigns = workspace ? workspaceListRows(filtered, visibleEnd, true) : filtered;
  useLayoutEffect(() => {
    visibleActions.current = (campaign, isOutcome) => hasResultAction(shownCampaigns, removal.byId, campaign, isOutcome);
  }, [shownCampaigns, removal.byId]);
  // Once the originating action returns, let it show the receipt as text.
  // A later filter change must not replay the registry announcement.
  const receiptActionVisible = registryReceipt && hasResultAction(shownCampaigns, removal.byId, registryReceipt.campaign, registryReceipt.isOutcome);
  useEffect(() => {
    if (receiptActionVisible) setRegistryReceipt(null);
  }, [receiptActionVisible]);
  const reloadAfter = async (message) => { await load(); setNotice(message); };
  const saveEditor = (fields, isRemoval = false) => {
    const kind = isRemoval ? "ballot" : fields.kind;
    const id = fields.id || (isRemoval ? "new-removal" : "new");
    const submittedDraft = isRemoval ? removalDraft : draft;
    return runBusyWrite(busyWriteRef, `campaign:${kind}:${id}`, async () => {
      const active = document.activeElement;
      const finishFocus = trackPressFocus(active?.closest(".cam-editor") ? active : null);
      let restoreFocus;
      setBusy(true); setNotice(""); setDraftError(null); setRegistryReceipt(null);
      try {
        await (isRemoval ? api.saveRemovalDraft(fields) : api.saveDraft(fields));
      } catch (error) {
        setDraftError({
          draft: submittedDraft,
          key: campaignRefusalKey(error, isRemoval ? "officerRemoval.saveFailed" : "campaigns.saveError"),
        });
        return;
      } finally {
        restoreFocus = finishFocus();
        setBusy(false);
      }
      if (isRemoval) setRemovalDraft(null);
      else setDraft(null);
      const key = demo ? "campaigns.savedDemo" : "campaigns.saved";
      const campaign = { ...fields, kind };
      const viaRegistry = Boolean(fields.id && !visibleActions.current(campaign, false));
      setDraftReceipt({ action: id, kind, key, viaRegistry, restoreFocus });
      if (viaRegistry) setRegistryReceipt({ campaign, key, isOutcome: false });
      void load();
    });
  };
  const recordRemoval = (campaign, outcome, control) => runBusyWrite(busyWriteRef, `campaign:${campaign.kind}:${campaign.id}`, () => recordRemovalNow(campaign, outcome, control));
  const recordRemovalNow = async (campaign, outcome, control) => {
    const finishFocus = trackPressFocus(control);
    let focusOutcome;
    setBusy(true); setNotice(""); setRegistryReceipt(null);
    const updateFeedback = (result) => setRemovalFeedback((current) => new Map(current).set(campaign.id, result));
    updateFeedback(null);
    try {
      await api.recordRemovalOutcome(campaign.id, outcome);
    } catch (error) {
      const key = campaignRefusalKey(error, "officerRemoval.recordFailed");
      const viaRegistry = !visibleActions.current(campaign, true);
      updateFeedback({ failedOutcome: outcome, error: key, viaRegistry });
      if (viaRegistry) setRegistryReceipt({ campaign, key, isOutcome: true });
      return;
    } finally {
      focusOutcome = finishFocus();
      setBusy(false);
    }
    // A result can only be recorded once. Hide both controls immediately,
    // including when a refresh is slow or returns an older snapshot.
    const viaRegistry = !visibleActions.current(campaign, true);
    updateFeedback({ outcome, viaRegistry, focusOutcome: focusOutcome && !viaRegistry });
    if (viaRegistry) setRegistryReceipt({ campaign, key: `officerRemoval.outcome.${outcome}`, isOutcome: true });
    void load();
  };
  const draftFeedback = (action, kind) => (
    draftReceipt?.action === action && (!kind || kind === draftReceipt.kind) ? t(draftReceipt.key) : ""
  );
  const canDraftRemoval = Boolean(api.saveRemovalDraft && removal.enabled);
  //: a steward limited to one unit may author no chapter-wide campaign.
  // The registry says so with canManageChapter: false; an answer without the
  // field keeps every control and lets the server decide. Until the registry
  // has answered, who may author is unknown, so no create control shows
  const registryAnswered = registry !== null;
  const canManageChapter = registryAnswered && registry.canManageChapter !== false;
  const canAuthor = registryAnswered && (canManageChapter || Boolean(registry.canManageUnion));
  const authorScope = canManageChapter ? "chapter" : "union";
  // An editor opened under an earlier answer closes when a later answer
  // refuses its scope, rather than staying open for a save the server refuses,
  // and the live notice says why the unsaved draft went away (
  //). An editor whose audience is still allowed keeps its text.
  useEffect(() => {
    if (!registry) return;
    const allowed = (scope) => (scope === "union" ? Boolean(registry.canManageUnion) : registry.canManageChapter !== false);
    const closeDraft = Boolean(draft) && !allowed(draft.scope);
    const closeRemoval = Boolean(removalDraft) && !allowed(removalDraft.scope);
    if (!closeDraft && !closeRemoval) return;
    if (closeDraft) setDraft(null);
    if (closeRemoval) setRemovalDraft(null);
    setNotice(t("campaigns.editorClosedPermission"));
  }, [registry, draft, removalDraft, t]);
  const transition = () => runBusyWrite(busyWriteRef, `campaign:${confirm.campaign.kind}:${confirm.campaign.id}`, () => transitionNow(confirm));
  const transitionNow = async ({ action, campaign }) => {
    setBusy(true); setNotice(""); setConfirmError("");
    try {
      await api[action](campaign.kind, campaign.id);
      setConfirm(null);
      // A deleted or published draft can no longer be saved as a draft, so an
      // editor still open on it closes instead of saving into a missing row.
      if (action !== "close") setDraft((current) => (current?.id === campaign.id && current?.kind === campaign.kind ? null : current));
      await reloadAfter(t(action === "publish" ? "campaigns.published" : action === "delete" ? "campaigns.deleted" : "campaigns.closed"));
    } catch (error) {
      if (action === "publish" && isCampaignCloseDateRefusal(error, campaign.closesAt)) {
        setConfirm(null);
        setNotice(t("campaigns.closeDatePassed"));
      } else {
        setNotice(t("campaigns.saveError"));
        //: the page line is under this window's scrim, which cannot close
        // while this runs (its Cancel waits), so the window says it too.
        setConfirmError("campaigns.saveError");
      }
    } finally { setBusy(false); }
  };

  return <section className="campaigns-screen" data-testid="campaigns-screen" aria-label={t("nav.campaigns")}>
    <PlaneHeader title={pageTitle} sub={t("campaigns.subtitle")} onProfile={onProfile} onAssistant={onAssistant} />
    {demo && <p className="cam-demo-note">{t("campaigns.demo")}</p>}
    {workspace && <nav className="workspace-subpages" aria-label={t("workspace.pages")}>
      {[["/m/campaigns", t("campaigns.registry.title"), "overview"], ...(!demo ? [["/m/campaigns/engagement/surveys", t("workspace.engagement"), "campaigns-engagement"]] : []), ...(sampleStudio ? [["/m/campaigns/studio/surveys", t("workspace.sampleStudio"), "campaigns-studio"]] : [])].map(([path, label, section]) => <a key={path} href={workspaceHref(path)} aria-current={workspace.section === section ? "page" : undefined} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); workspace.open(path); }}>{label}</a>)}
    </nav>}
    {sampleStudio && <WorkspaceSection name="campaigns-studio"><DemoVoiceStudio lang={lang} /></WorkspaceSection>}
    {!demo && <WorkspaceSection name="campaigns-engagement"><StaffEngagement client={engagementClient} session={engagementSession} onNotice={onAppNotice} onSnapshotChanged={onEngagementChanged} organizationSnapshot={organizationSnapshot} /></WorkspaceSection>}
    {/* A subpage this workspace cannot back names the dependency and a way
        back (audit P0 APP-STEWARD-06): the engagement studio needs a live
        organization, and the sample studio exists only in the preview. */}
    {workspace && workspace.section === "campaigns-engagement" && demo && <WorkspaceStatusState title={t("campaigns.engagementUnavailableTitle")} body={t("campaigns.engagementUnavailableBody")} hint={t("campaigns.engagementUnavailableWho")} links={[{ label: t("campaigns.backToCampaigns"), path: "/m/campaigns" }]} />}
    {workspace && workspace.section === "campaigns-studio" && !sampleStudio && demo && <WorkspaceStatusState title={t("campaigns.studioUnavailableTitle")} body={t("campaigns.studioUnavailableBody")} links={[{ label: t("campaigns.openEngagement"), path: "/m/campaigns/engagement/surveys" }, { label: t("campaigns.backToCampaigns"), path: "/m/campaigns" }]} />}
    <WorkspaceSection name="overview"><div className={`cam-shell${draft || removalDraft ? "" : " cam-shell--single"}`}>
      <section className="cam-registry" aria-labelledby="cam-registry-title">
        <div className="cam-registry__head">
          <div><p className="cam-kicker">{t("campaigns.registry.kicker")}</p><h2 id="cam-registry-title" ref={registryHeading} tabIndex="-1">{t("campaigns.registry.heading")}</h2></div>
          {canAuthor && <div className="cam-actions cam-actions--feedback">
            <DraftAction feedback={draftFeedback("new")}>
              <BusyButton className="cam-btn cam-btn--go" type="button" pending={busy} aria-describedby={busy ? newCampaignBusyReason : undefined} onClick={(event) => openDraft(emptyDraft(authorScope), event.currentTarget)}>{t("campaigns.new")}</BusyButton>
              {busy && <span className="busy-reason" id={newCampaignBusyReason}>{t("campaigns.saving")}</span>}
            </DraftAction>
            {canDraftRemoval && <DraftAction feedback={draftFeedback("new-removal")}>
              <BusyButton className="cam-btn cam-btn--quiet" type="button" pending={busy} onClick={(event) => openDraft(emptyRemovalDraft(authorScope), event.currentTarget, true)}>{t("officerRemoval.new")}</BusyButton>
            </DraftAction>}
          </div>}
        </div>
        {registryAnswered && !canAuthor && <p className="cam-help" data-testid="campaigns-leadership-only">{t("campaigns.chapterLeadershipOnly")}</p>}
        {/*  (B-43): organization-wide ballots and pulses are left out of
            this registry for a reader who cannot manage that scope; members
            still see them on Voting, so the page says where they are. */}
        {registryAnswered && registry.canManageUnion === false && <p className="cam-help" data-testid="campaigns-organization-elsewhere">{t("campaigns.organizationVotesElsewhere")}</p>}
        <div className="cam-filters" aria-label={t("campaigns.filters")} aria-busy={registry === null && !error ? true : undefined}>{["all", "draft", "open", "closed"].map((state) => <button type="button" key={state} aria-pressed={filter === state} onClick={() => { setFilter(state); setVisibleEnd(6); }}>{t(`campaigns.filter.${state}`)}{registry != null && <> <span>{state === "all" ? campaigns.length : campaigns.filter((item) => item.state === state).length}</span></>}</button>)}</div>
        <p role="status" className={registry === null && !error ? "cam-state" : "cam-feedback"}>
          {registry === null && !error ? t("campaigns.loading") : registryReceipt && !receiptActionVisible
            ? `${campaignTitle(registryReceipt.campaign, lang)} — ${t(registryReceipt.key)}` : ""}
        </p>
        {error && <div className="cam-state cam-state--error" role="alert"><p>{error}</p><button className="cam-btn" type="button" onClick={load}>{t("app.tryAgain")}</button></div>}
        {registry && filtered.length === 0 && <div className="cam-state"><h3>{t("campaigns.empty")}</h3><p>{t("campaigns.emptyBody")}</p></div>}
        <div className="cam-list">{shownCampaigns.map((campaign) => <article className="cam-card" key={`${campaign.kind}-${campaign.id}`}>
          <div className="cam-card__top"><span className={`cam-status cam-status--${campaign.state}`}>{t(`campaigns.state.${campaign.state}`)}</span><span className="cam-kind">{t(`campaigns.kind.${campaign.kind}`)}</span></div>
          <h3>{campaignTitle(campaign, lang)}</h3>
          <p>{t(campaign.scope === "union" ? "campaigns.scope.unionAudience" : "campaigns.scope.chapterAudience")}</p>
          {campaign.kind === "ballot" && removal.byId.has(campaign.id) && <OfficerRemovalSummary
            scope={campaign.scope}
            detail={removal.byId.get(campaign.id)}
            canRecord={Boolean(api.recordRemovalOutcome)}
            busy={busy}
            recordError={removalFeedback.get(campaign.id)?.error}
            failedOutcome={removalFeedback.get(campaign.id)?.failedOutcome}
            recordedOutcome={removalFeedback.get(campaign.id)?.outcome}
            announceOutcome={!removalFeedback.get(campaign.id)?.viaRegistry}
            focusOutcome={removalFeedback.get(campaign.id)?.focusOutcome}
            onRecord={(outcome, control) => recordRemoval(campaign, outcome, control)}
          />}
          <dl className="cam-card__meta"><div><dt>{t("campaigns.summary.closes")}</dt><dd>{formatDateTimeWithZone(campaign.closesAt, lang)}</dd></div>{campaign.kind === "ballot" && <div><dt>{t("campaigns.quorum")}</dt><dd>{campaign.quorumTarget}</dd></div>}<div><dt>{t("campaigns.options")}</dt><dd>{campaign.options.length}</dd></div></dl>
          {campaign.state === "draft" && campaignPublishWithdrawn(campaign.closesAt) && <p className="cam-help">{t("campaigns.closeDatePassed")}</p>}
          <div className="cam-actions cam-actions--feedback">{campaign.state === "draft" && <><DraftAction feedback={draftFeedback(campaign.id, campaign.kind)} announce={!(draftReceipt?.viaRegistry && draftReceipt.action === campaign.id && draftReceipt.kind === campaign.kind)}><BusyButton className="cam-btn cam-btn--quiet" type="button" pending={busy} aria-label={t("campaigns.editNamed", { title: campaignTitle(campaign, lang) })} onClick={(event) => {
            const detail = campaign.kind === "ballot" && removal.byId.get(campaign.id);
            if (detail) openDraft(removalDraftFromCampaign(campaign, detail), event.currentTarget, true);
            else openDraft(draftFromCampaign(campaign), event.currentTarget);
          }}>{t("campaigns.edit")}</BusyButton></DraftAction>{!campaignPublishWithdrawn(campaign.closesAt) && <button className="cam-btn cam-btn--go" type="button" aria-label={t("campaigns.publishNamed", { title: campaignTitle(campaign, lang) })} onClick={() => setConfirm({ action: "publish", campaign })}>{t("campaigns.publish")}</button>}{api.delete && !(campaign.kind === "ballot" && removal.byId.has(campaign.id)) && <button className="cam-btn cam-btn--quiet" type="button" aria-label={t("campaigns.deleteNamed", { title: campaignTitle(campaign, lang) })} onClick={() => setConfirm({ action: "delete", campaign })}>{t("campaigns.delete")}</button>}</>}{campaign.state === "open" && <button className="cam-btn cam-btn--close" type="button" aria-label={t("campaigns.closeNamed", { title: campaignTitle(campaign, lang) })} onClick={() => setConfirm({ action: "close", campaign })}>{t("campaigns.close")}</button>}</div>
          {api.nominationsClient && campaign.kind === "ballot" && campaign.state === "draft" && !removal.byId.has(campaign.id) && <NominationsManager client={api.nominationsClient} campaign={campaign} onUseNominees={(names) => openDraft({
            ...draftFromCampaign(campaign), options: names.map((name) => ({ labelEn: name, labelEs: name })),
          }, document.activeElement)} />}
        </article>)}</div>
        <WorkspaceListPager count={filtered.length} end={visibleEnd} onChange={setVisibleEnd} />
      </section>
      {draft && <CampaignEditor draft={draft} setDraft={setDraft} canManageUnion={registry?.canManageUnion} canManageChapter={canManageChapter} busy={busy} error={draftError?.draft === draft ? t(draftError.key) : ""} onCancel={() => setDraft(null)} onSave={saveEditor} />}
      {removalDraft && <OfficerRemovalEditor draft={removalDraft} setDraft={setRemovalDraft} canManageUnion={registry?.canManageUnion} canManageChapter={canManageChapter} busy={busy} error={draftError?.draft === removalDraft ? t(draftError.key) : ""} loadTargets={api.removalTargets} onCancel={() => setRemovalDraft(null)} onSave={(fields) => saveEditor(fields, true)} />}
    </div>
    </WorkspaceSection><p className="cam-live" aria-live="polite">{notice}</p>
    {confirmExit.shown && <ConfirmDialog campaign={confirmExit.value.campaign} action={confirmExit.value.action} busy={busy} error={confirmError} closing={confirmExit.closing} onTransitionEnd={confirmExit.onTransitionEnd} onCancel={() => setConfirm(null)} onConfirm={transition} />}
  </section>;
}
