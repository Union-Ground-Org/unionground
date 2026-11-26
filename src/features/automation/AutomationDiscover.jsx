import { useEffect, useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { requestAutomationDraft } from "../../lib/automationCompassApi.js";
import { AUTOMATION_TRIGGER_METADATA } from "./capabilities.js";
import { automationDraftFromProposal } from "./proposals.js";
import { automationAuthoringBlock } from "./authoringBlock.js";
import "../../lib/i18n/features/automationAvailabilityStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";

const EMPTY_DRAFT = {
  schemaVersion: 2, name: "", triggerKind: "overdue_task", thresholdDays: "1",
  cadence: "daily", taskPriority: "medium", conditions: {},
  actionKind: "create_standard_task", actionConfig: {},
};
const MIN_INTENT_LENGTH = 3;
const MAX_INTENT_LENGTH = 500;

// controlPlane.js admits only these two scope tokens. The match sentence
// interpolates a catalogue noun so Spanish does not keep the English token.
const OPPORTUNITY_SCOPE_LABELS = Object.freeze({
  chapter: "automation.opportunity.scopeChapter",
  organization: "automation.opportunity.scopeOrganization",
});

function opportunityScopeLabel(translate, scope) {
  const key = OPPORTUNITY_SCOPE_LABELS[scope];
  return key ? translate(key) : scope;
}

export function AutomationDiscover({
  connected,
  access = {},
  workspaceState = "ready",
  blockedReason = null,
  blockedReasonId = null,
  accessToken = null,
  session = null,
  api = null,
  capabilities = null,
  opportunities = [],
  opportunitiesState = "ready",
  opportunityScopeChapterId = null,
  requestCompass = requestAutomationDraft,
  onStartDraft,
  onOpenRecipes,
  onRetry,
}) {
  const { lang, t } = useLang();
  const [intent, setIntent] = useState("");
  const [intentRefused, setIntentRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState(null);
  const intentHelpId = useId();
  const askButton = useRef(null);
  const request = useRef(null);
  const draftGeneration = useRef(0);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => { draftGeneration.current += 1; }, [api, session]);
  const blockReason = workspaceState === "ready" ? access.reason : workspaceState;
  const personGap = ["mfa_required", "role_denied", "session_inactive"].includes(blockReason);
  // The organization has no connected authoring at all (the "not installed"
  // reason below): nothing on this page can draft for anyone, so the drafting
  // actions are left out rather than shown disabled
  // (BUG-UG-AUTOMATIONS-SHOWS-AUTHORING-ACTIONS-WHEN-NOT-INSTALLED-20261106).
  // A gap this person can close (role, two-step) keeps the disabled actions
  // and their reason.
  const authoringMissing = !personGap && !connected;
  const authoringReason = blockedReason || automationAuthoringBlock(blockReason, t)?.message
    || (!connected
        ? t("automation.connected.authoring.installed")
        : !access.canAuthor
          ? t("automation.discover.staffAndMfaRequired")
          : "");
  const authoringDescriptionId = blockedReasonId || "automation-authoring-disabled";
  const cleanIntent = intent.trim();
  const intentTooShort = cleanIntent.length < MIN_INTENT_LENGTH;
  const intentInvalid = intentTooShort && (intent.length > 0 || intentRefused);

  function changeIntent(event) {
    const value = event.target.value;
    setIntent(value);
    if (value.trim().length >= MIN_INTENT_LENGTH) setIntentRefused(false);
  }

  async function askCompass(event) {
    event.preventDefault();
    if (authoringReason) return;
    if (intentTooShort) {
      askButton.current?.click();
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setProposal(null);
    const result = await requestCompass({
      accessToken, intent: cleanIntent, capabilities, opportunities, locale: lang, signal: controller.signal,
    });
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = null; setBusy(false);
    if (!result?.ok || !automationDraftFromProposal(result.proposal)) {
      setError(result?.reason === "governance_unavailable"
        ? t("automation.discover.compassPaused")
        : t("automation.discover.compassFailed"));
      return;
    }
    setProposal(result.proposal);
  }

  async function startOpportunityDraft(row, title) {
    const draft = { ...EMPTY_DRAFT, name: title, triggerKind: row.triggerKind, thresholdDays: String(row.thresholdDays) };
    const generation = ++draftGeneration.current;
    // A chapter-scoped opportunity names one authorized chapter only when the
    // actor staffs exactly one: seed the draft scope so saving never hits the
    // missing-scope refusal. Any other cardinality keeps the open draft and
    // lets the builder's chapter picker decide.
    // The opportunities payload names the one chapter it counted, when exactly
    // one was counted; that is the scope a non-approver save needs.
    if (row.scope === "chapter" && !row.covered && opportunityScopeChapterId) {
      draft.conditions = { ...draft.conditions, chapterId: opportunityScopeChapterId };
    } else if (row.scope === "chapter" && !row.covered && api?.getScopeOptions) {
      const source = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === row.triggerKind)?.source;
      if (source) {
        try {
          const result = await api.getScopeOptions(session, { source, page: 1, pageSize: 6 });
          if (draftGeneration.current !== generation) return;
          const chapters = result?.ok ? result.data?.chapters : null;
          if (chapters && chapters.total === 1 && chapters.rows.length === 1) draft.conditions = { ...draft.conditions, chapterId: chapters.rows[0].id };
        } catch {
          // Keep the unscoped draft: the builder picker still decides.
          if (draftGeneration.current !== generation) return;
        }
      }
    }
    if (draftGeneration.current !== generation) return;
    onStartDraft(draft);
  }

  return <section className="automation-pages__body automation-discover" aria-labelledby="automation-discover-title">
    <header className="automation-discover__hero">
      <p className="automation-discover__eyebrow">{t("automation.shared.staff.workspace")}</p>
      <h2 id="automation-discover-title">{t("automation.discover.heroTitle")}</h2>
      <p>{t("automation.discover.heroBody")}</p>
      <div className="xus-btnrow">
        {!authoringMissing && <button className="xus-btn xus-btn--go" type="button" disabled={Boolean(authoringReason)} aria-describedby={authoringReason ? authoringDescriptionId : undefined} onClick={() => onStartDraft({ ...EMPTY_DRAFT })}>{t("automation.create.draft")}</button>}
        <button className="xus-btn" type="button" onClick={onOpenRecipes}>{t("automation.browse.recipes")}</button>
      </div>
      {authoringReason && !blockedReasonId && <p id="automation-authoring-disabled" className="automation-pages__disabled-reason" role="status">{authoringReason}</p>}
    </header>

    <section aria-labelledby="automation-how-title">
      <h3 id="automation-how-title">{t("automation.how.it.works")}</h3>
      <ol className="automation-discover__flow">
        {["detect", "draft", "preview", "review", "run"].map((step) => <li key={step}><strong>{t(`automation.how.${step}.title`)}</strong><span>{t(`automation.how.${step}.body`)}</span></li>)}
      </ol>
      <p>{authoringReason ? t("automationAvailability.draftingPaused") : access.canApprove
        ? t("automation.discover.canApproveNote")
        : t("automation.discover.submitForReviewNote")}</p>
    </section>

    {!authoringMissing && <section className="automation-discover__compass" aria-labelledby="automation-compass-title">
      <div><p className="automation-discover__eyebrow">{t("nav.compass")}</p><h3 id="automation-compass-title">{t("automation.describe.outcome.machinery")}</h3><p>{t("automation.discover.compassHelp")}</p></div>
      <form onSubmit={askCompass}>
        <label className="xus-field">{t("automation.describe.routine.work")}<textarea className="xus-input" rows="4" maxLength={MAX_INTENT_LENGTH} aria-describedby={intentHelpId} aria-invalid={intentInvalid || undefined} value={intent} onChange={changeIntent} /></label>
        <p className="xus-note" id={intentHelpId}>{t("automationAvailability.compassIntentCount", { count: intent.length, max: MAX_INTENT_LENGTH })}</p>
        <BusyButton ref={askButton} className="xus-btn xus-btn--go" type="submit" pending={busy} disabled={Boolean(authoringReason) || intentTooShort}
          disabledReason={!authoringReason && intentTooShort ? t("automationAvailability.compassIntentTooShort", { min: MIN_INTENT_LENGTH }) : null}
          onBlockedPress={() => setIntentRefused(true)}
          aria-describedby={authoringReason ? authoringDescriptionId : undefined}>{busy ? t("automation.drafting") : t("automation.ask.compass")}</BusyButton>
      </form>
      {error && <p className="automation-pages__error" role="alert">{error}</p>}
      {proposal && <div className="automation-pages__summary" aria-live="polite"><h4>{proposal.proposal.name}</h4><p>{proposal.explanation}</p>{proposal.assumptions.length > 0 && <><strong>{t("automation.assumptions")}</strong><ul>{proposal.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></>}{proposal.warnings.length > 0 && <><strong>{t("automation.safety.notes")}</strong><ul>{proposal.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}<button className="xus-btn xus-btn--go" type="button" onClick={() => onStartDraft(automationDraftFromProposal(proposal))}>{t("automation.use.draft")}</button></div>}
    </section>}

    <section aria-labelledby="automation-opportunities-title">
      <h3 id="automation-opportunities-title">{t("automation.opportunities.your.scope")}</h3>
      {opportunitiesState === "loading" && <p role="status">{t("automation.checking.bounded.counts")}</p>}
      {opportunitiesState === "unavailable" && <div><p role="status" aria-describedby={authoringReason ? authoringDescriptionId : undefined}>{authoringReason ? t("automationAvailability.opportunitiesPaused") : t("automation.discover.opportunityUnavailable")}</p>{workspaceState === "ready" && !authoringReason && onRetry && <button className="xus-btn" type="button" onClick={onRetry}>{t("automation.try.again")}</button>}</div>}
      {opportunitiesState === "ready" && opportunities.length === 0 && <p>{t("automation.discover.noOpportunities")}</p>}
      {opportunities.length > 0 && <ul className="automation-discover__opportunities">{opportunities.map((row) => {
        const title = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === row.triggerKind)?.label?.[lang] || row.triggerKind;
        const statusId = `automation-opportunity-${row.triggerKind}-${row.thresholdDays}-${row.scope}`;
        return <li key={`${row.triggerKind}:${row.thresholdDays}:${row.scope}`}><h4>{title}</h4><p>{t("automation.opportunity.match", { count: row.candidateCount, scope: opportunityScopeLabel(t, row.scope) })}</p><p id={statusId}>{row.covered ? t("automation.discover.alreadyCovered") : authoringReason || t("automation.yet.covered")}</p>{!authoringMissing && <button className="xus-btn" type="button" disabled={Boolean(authoringReason) || row.covered} aria-describedby={Boolean(authoringReason) || row.covered ? statusId : undefined} onClick={() => void startOpportunityDraft(row, title)}>{t("automation.draft")}</button>}</li>;
      })}</ul>}
    </section>
  </section>;
}
