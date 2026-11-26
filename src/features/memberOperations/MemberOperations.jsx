import { useRoutedTab, RoutedTabLink } from "../../components/WorkspacePages.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import {
  GRIEVANCE_IMPORT_FIELDS,
  MEMBER_IMPORT_FIELDS,
  OPERATIONAL_PROFILE_FIELDS,
} from "./contract.js";
import { normalizeMemberOperationsActor } from "./authorization.js";
import { createMemberOperationsAdapter } from "./adapter.js";
import { parseMemberOperationsCsv, validateMemberOperationsMapping } from "./csv.js";
import { loadEngagementDeliveryStatus } from "../engagement/api.js";
import { featureActorIdentityKey } from "../../lib/featureActorIdentity.js";
import "./member-operations.css";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

const PROFILE_MAX_LENGTHS = {
  memberNumber: 80,
  jobTitle: 160,
  department: 160,
  workLocation: 200,
  membershipClass: 120,
};

function labelled(t, prefix, value, fallback) {
  const key = `${prefix}.${value}`;
  const translated = t(key);
  return translated === key ? (fallback ?? String(value ?? "")) : translated;
}

function LanguageOptions({ t, includeNotSet = false }) {
  return <>
    {includeNotSet && <option value="">{t("memberOperations.languageName.notSet")}</option>}
    <option value="en">{t("memberOperations.languageName.en")}</option>
    <option value="es">{t("memberOperations.languageName.es")}</option>
  </>;
}

function State({ state, actor, retry, t }) {
  if (state === "loading") return <p className="member-operations-state" role="status">{t("memberOperations.state.loading")}</p>;
  if (state === "ready") return null;
  const text = state === "mfa_required" ? t("memberOperations.state.mfaRequired")
    : state === "unauthorized" ? t(actor.selectedHat === "admin" ? "memberOperations.state.accessUnverified" : "memberOperations.state.unauthorized")
      : state === "unavailable" ? t("memberOperations.state.unavailable")
        : t("memberOperations.state.loadError");
  return <div className="member-operations-state" role="status"><p>{text}</p><button type="button" onClick={retry}>{t("memberOperations.state.tryAgain")}</button></div>;
}

function Directory({ workspace, actor, adapter, busy, commit, reload, onNotice, t }) {
  const [query, setQuery] = useState("");
  // The rendered listing carries the generation it belongs to. Every
  // replacement (workspace synchronization or a search result) starts a new
  // generation, so a next-page request or response is matched to the listing
  // whose cursor produced it: a page that settles after its listing was
  // replaced continues a superseded query and must not append rows or a
  // cursor onto the replacement, and a Load next page activated from a
  // rendering that was already replaced but not yet re-rendered is ignored.
  // One in-flight request per cursor keeps a repeated Load next page from
  // appending the same page twice.
  const [listing, setListing] = useState(() => ({ directory: workspace.directory, generation: 0 }));
  const directory = listing.directory;
  const syncedWorkspaceDirectory = useRef(workspace.directory);
  const listingGeneration = useRef(0);
  const pendingPage = useRef(null);
  const replaceDirectory = (next) => {
    const generation = listingGeneration.current + 1;
    listingGeneration.current = generation;
    pendingPage.current = null;
    setListing({ directory: next, generation });
  };
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({});
  const [checked, setChecked] = useState([]);
  const [bulkField, setBulkField] = useState("department");
  const [bulkValue, setBulkValue] = useState("");
  useEffect(() => {
    // Mount state already contains this directory. Reapplying it in a delayed
    // passive effect can overwrite a page loaded immediately after the commit.
    if (syncedWorkspaceDirectory.current === workspace.directory) return;
    syncedWorkspaceDirectory.current = workspace.directory;
    replaceDirectory(workspace.directory);
  }, [workspace.directory]);

  async function search(event) {
    event.preventDefault();
    try {
      const result = await adapter.listDirectory(actor, { query: query.trim() || null });
      replaceDirectory(result);
      setChecked([]);
    } catch (error) {
      onNotice(error?.message || t("memberOperations.errors.search"));
    }
  }

  async function choose(item) {
    try {
      const detail = await adapter.loadProfile(actor, item.userId);
      setSelected(detail);
      setDraft(detail.profile || {});
    } catch (error) {
      onNotice(error?.message || t("memberOperations.errors.profileLoad"));
    }
  }

  async function nextPage() {
    const { generation } = listing;
    const cursor = directory.nextCursor;
    // A cursor from a rendering whose listing was already replaced belongs to
    // a superseded query; do not request its page at all.
    if (!cursor || generation !== listingGeneration.current || pendingPage.current?.cursorId === cursor.id) return;
    const request = { cursorId: cursor.id, generation };
    pendingPage.current = request;
    try {
      const next = await adapter.listDirectory(actor, {
        query: query.trim() || null,
        afterName: cursor.name,
        afterId: cursor.id,
      });
      // The listing may have been replaced while the request was in flight;
      // a superseded page is discarded, never merged into the replacement.
      setListing((latest) => (latest.generation === generation
        ? { directory: { items: [...latest.directory.items, ...(next.items || [])], nextCursor: next.nextCursor }, generation }
        : latest));
    } catch (error) {
      if (listingGeneration.current === generation) onNotice(error?.message || t("memberOperations.errors.nextPage"));
    } finally {
      if (pendingPage.current === request) pendingPage.current = null;
    }
  }

  return <section className="member-operations-section" aria-labelledby="member-operations-directory-title">
    <div className="member-operations-heading"><div><p>{t("memberOperations.directory.eyebrow")}</p><h3 id="member-operations-directory-title">{t("memberOperations.directory.title")}</h3></div><span>{t("memberOperations.directory.shown", { count: directory.items.length })}</span></div>
    <form className="member-operations-search" onSubmit={search}>
      <label><span className="sr-only">{t("memberOperations.directory.searchLabel")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memberOperations.directory.searchPlaceholder")} minLength={2} /></label>
      <BusyButton type="submit" pending={busy} disabled={query.length > 0 && query.trim().length < 2}>{t("memberOperations.directory.search")}</BusyButton>
    </form>
    <div className="member-operations-directory">
      <div className="member-operations-list" aria-label={t("memberOperations.directory.listLabel")}>
        {directory.items.length === 0 && <p className="member-operations-empty">{t("memberOperations.directory.empty")}</p>}
        {directory.items.map((item) => <div className="member-operations-row" key={item.userId}>
          <label className="member-operations-check"><input type="checkbox" checked={checked.includes(item.userId)} onChange={(event) => setChecked((current) => event.target.checked ? [...new Set([...current, item.userId])] : current.filter((id) => id !== item.userId))} /><span className="sr-only">{t("memberOperations.directory.selectMember", { name: item.fullName })}</span></label>
          <button type="button" className="member-operations-row__main" onClick={() => choose(item)}>
            <strong>{item.fullName}</strong><span>{[item.chapterName, item.profile?.department, item.profile?.jobTitle].filter(Boolean).join(" · ") || t("memberOperations.directory.profileNotStarted")}</span>
          </button>
          <span className="member-operations-status">{t("memberOperations.directory.version", { version: item.version })}</span>
        </div>)}
        {directory.nextCursor && <button type="button" className="member-operations-secondary" onClick={nextPage}>{t("memberOperations.directory.loadNext")}</button>}
      </div>
      <div className="member-operations-editor">
        {!selected ? <p className="member-operations-empty">{t("memberOperations.directory.editorEmpty")}</p> : <form onSubmit={(event) => {
          event.preventDefault();
          commit(() => adapter.saveProfile(actor, { memberUserId: selected.userId, expectedVersion: selected.version, fields: draft }), t("memberOperations.directory.saved"), () => { setSelected(null); reload(); });
        }}>
          <div className="member-operations-heading"><div><p>{t("memberOperations.directory.selectedEyebrow")}</p><h4>{selected.fullName}</h4></div><span>{t("memberOperations.directory.version", { version: selected.version })}</span></div>
          {OPERATIONAL_PROFILE_FIELDS.map((field) => <label key={field}>{t(`memberOperations.profileLabels.${field}`)}
            {field === "administrativeNotes" ? <textarea maxLength={4000} value={draft[field] || ""} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
              : field === "preferredLanguage" ? <select value={draft[field] || ""} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}><LanguageOptions t={t} includeNotSet /></select>
                : <input type={field === "hireDate" ? "date" : "text"} maxLength={PROFILE_MAX_LENGTHS[field]} value={draft[field] || ""} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />}
          </label>)}
          <div className="member-operations-actions"><BusyButton type="submit" pending={busy}>{t("memberOperations.directory.save")}</BusyButton><button type="button" className="member-operations-secondary" onClick={() => setSelected(null)}>{t("memberOperations.directory.cancel")}</button></div>
        </form>}
      </div>
    </div>
    <form className="member-operations-bulk" onSubmit={(event) => {
      event.preventDefault();
      commit(() => adapter.bulkUpdateProfiles(actor, { memberUserIds: checked, field: bulkField, value: bulkValue }), t("memberOperations.bulk.updated", { count: checked.length }), () => { setChecked([]); setBulkValue(""); reload(); });
    }}>
      <strong>{t("memberOperations.bulk.title")}</strong>
      <label>{t("memberOperations.bulk.field")}<select value={bulkField} onChange={(event) => { setBulkField(event.target.value); setBulkValue(""); }}><option value="department">{t("memberOperations.bulk.fields.department")}</option><option value="workLocation">{t("memberOperations.bulk.fields.workLocation")}</option><option value="membershipClass">{t("memberOperations.bulk.fields.membershipClass")}</option><option value="preferredLanguage">{t("memberOperations.bulk.fields.preferredLanguage")}</option></select></label>
      <label>{t("memberOperations.bulk.newValue")}{bulkField === "preferredLanguage"
        ? <select value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}><LanguageOptions t={t} includeNotSet /></select>
        : <input value={bulkValue} maxLength={PROFILE_MAX_LENGTHS[bulkField]} onChange={(event) => setBulkValue(event.target.value)} />}</label>
      <BusyButton type="submit" pending={busy} disabled={checked.length === 0}>{checked.length ? t("memberOperations.bulk.update", { count: checked.length }) : t("memberOperations.bulk.updateSelected")}</BusyButton>
    </form>
  </section>;
}

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 74): the
// create form takes the welcome message directly. The server keeps a message
// as a campaign step with a subject, so the message is saved as the first
// step (day 0, the page language) under a plain default subject; the step
// form below still edits it like any other step.
const NEW_CAMPAIGN = Object.freeze({ name: "", state: "draft", message: "" });

// A campaign saved before its message failed is kept (createdId): the next
// Create retries only the message, so a retry never makes a second campaign,
// and the list reloads at once so the saved campaign shows (Codex review on
// #6640).
async function createWelcomeCampaign(adapter, actor, campaign, lang, subject, { onCreated = null, reload = null } = {}) {
  let campaignId = campaign.createdId || null;
  let saved = null;
  if (!campaignId) {
    saved = await adapter.saveWelcomeCampaign(actor, { name: campaign.name, state: campaign.state });
    campaignId = saved?.id ?? null;
    onCreated?.(campaignId);
  }
  const body = campaign.message.trim();
  if (body) {
    try {
      await adapter.saveWelcomeStep(actor, { campaignId, position: 0, delayDays: 0, locale: lang === "es" ? "es" : "en", subject, body, active: true });
    } catch (error) {
      if (saved) reload?.();
      throw error;
    }
  }
  return saved ?? { id: campaignId };
}

function Welcome({ workspace, actor, adapter, busy, commit, reload, onNotice, t }) {
  const { lang } = useLang();
  const [campaign, setCampaign] = useState(NEW_CAMPAIGN);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [campaigns, setCampaigns] = useState(workspace.campaigns);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState(workspace.directory.items);
  const [memberUserId, setMemberUserId] = useState("");
  const [editingStep, setEditingStep] = useState(null);
  useEffect(() => setCampaigns(workspace.campaigns), [workspace.campaigns]);
  useEffect(() => setMemberResults(workspace.directory.items), [workspace.directory.items]);
  const deliveryStatus = workspace.deliveryStatusUnavailable
    ? t("memberOperations.welcome.noteStatus.unavailable")
    : workspace.deliveryConfigured
      ? t("memberOperations.welcome.noteStatus.configured")
      : t("memberOperations.welcome.noteStatus.unset");
  async function searchMembers(event) {
    event.preventDefault();
    try {
      const result = await adapter.listDirectory(actor, { query: memberQuery.trim(), limit: 25 });
      setMemberResults(result?.items || []);
      setMemberUserId("");
    } catch (error) {
      onNotice(error?.message || t("memberOperations.errors.search"));
    }
  }
  async function loadOlder(campaignId, cursor) {
    try {
      const page = await adapter.listWelcomeEnrollments(actor, {
        campaignId, beforeEnrolledAt: cursor.enrolledAt, beforeId: cursor.id,
      });
      setCampaigns((current) => current.map((item) => item.id === campaignId ? {
        ...item,
        enrollments: [...item.enrollments, ...(page?.items || [])],
        enrollmentNextCursor: page?.nextCursor || null,
      } : item));
    } catch (error) {
      onNotice(error?.message || t("memberOperations.errors.olderEnrollments"));
    }
  }
  return <section className="member-operations-section" aria-labelledby="member-operations-welcome-title">
    <div className="member-operations-heading"><div><p>{t("memberOperations.welcome.eyebrow")}</p><h3 id="member-operations-welcome-title">{t("memberOperations.welcome.title")}</h3></div><BusyButton type="button" pending={busy} onClick={() => commit(() => adapter.queueWelcome(actor), t("memberOperations.welcome.queued"), reload)}>{t("memberOperations.welcome.queueDue")}</BusyButton></div>
    <p className="member-operations-note">{t("memberOperations.welcome.note", { status: deliveryStatus })}</p>
    <form className="member-operations-formline" onSubmit={(event) => { event.preventDefault(); commit(() => createWelcomeCampaign(adapter, actor, campaign, lang, t("memberOperations.welcome.defaultSubject"), { onCreated: (createdId) => setCampaign((current) => ({ ...current, createdId })), reload }), t("memberOperations.welcome.saved"), () => { setCampaign(NEW_CAMPAIGN); reload(); }); }}>
      {campaign.createdId && <p className="member-operations-note" role="status">{t("memberOperations.welcome.messageRetry")}</p>}
      <label>{t("memberOperations.welcome.campaignName")}<input value={campaign.name} maxLength={160} required readOnly={Boolean(campaign.createdId)} onChange={(event) => setCampaign((current) => ({ ...current, name: event.target.value }))} /></label>
      <label>{t("memberOperations.welcome.state")}<select value={campaign.state} disabled={Boolean(campaign.createdId)} onChange={(event) => setCampaign((current) => ({ ...current, state: event.target.value }))}><option value="draft">{t("memberOperations.welcome.stateOption.draft")}</option><option value="active">{t("memberOperations.welcome.stateOption.active")}</option><option value="paused">{t("memberOperations.welcome.stateOption.paused")}</option><option value="archived">{t("memberOperations.welcome.stateOption.archived")}</option></select></label>
      <div className="member-operations-wide"><label>{t("memberOperations.welcome.message")}<textarea value={campaign.message} maxLength={10000} aria-describedby="member-operations-welcome-message-help" onChange={(event) => setCampaign((current) => ({ ...current, message: event.target.value }))} /></label><small id="member-operations-welcome-message-help">{t("memberOperations.welcome.messageHelp", { subject: t("memberOperations.welcome.defaultSubject") })}</small></div>
      <BusyButton type="submit" pending={busy} disabled={!campaign.name.trim()}>{t("memberOperations.welcome.create")}</BusyButton>
    </form>
    <div className="member-operations-campaigns">
      {campaigns.length === 0 && <p className="member-operations-empty">{t("memberOperations.welcome.empty")}</p>}
      {campaigns.map((item) => {
        const enrollmentBlock = item.state === "archived" ? "enrollArchived"
          : item.state !== "active" ? "enrollInactive" : !memberUserId ? "enrollChooseMember" : null;
        return <article className="member-operations-card" key={item.id}>
          <div className="member-operations-heading"><div><h4>{item.name}</h4><p>{t("memberOperations.welcome.summary", { steps: item.steps.length, enrollments: item.enrollments.length })}</p></div><span className="member-operations-status">{labelled(t, "memberOperations.welcome.campaignState", item.state)}</span></div>
          <div className="member-operations-actions">
            <button type="button" className="member-operations-secondary" onClick={() => { setEditingStep(null); setSelectedCampaign(selectedCampaign === item.id ? null : item.id); }} aria-expanded={selectedCampaign === item.id}>{t("memberOperations.welcome.manage")}</button>
            {item.state !== "archived" && <BusyButton type="button" pending={busy} onClick={() => commit(() => adapter.saveWelcomeCampaign(actor, { campaignId: item.id, name: item.name, state: item.state === "active" ? "paused" : "active" }), item.state === "active" ? t("memberOperations.welcome.paused") : t("memberOperations.welcome.activated"), reload)}>{item.state === "active" ? t("memberOperations.welcome.pause") : t("memberOperations.welcome.activate")}</BusyButton>}
            {item.state !== "archived" && <BusyButton type="button" className="member-operations-destructive" pending={busy} onClick={() => window.confirm(t("memberOperations.welcome.archiveConfirm", { name: item.name })) && commit(() => adapter.saveWelcomeCampaign(actor, { campaignId: item.id, name: item.name, state: "archived" }), t("memberOperations.welcome.archived"), reload)}>{t("memberOperations.welcome.archive")}</BusyButton>}
          </div>
          {selectedCampaign === item.id && <div className="member-operations-campaign-detail">
            <form key={editingStep?.id || "new-step"} className="member-operations-gridform" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); commit(() => adapter.saveWelcomeStep(actor, { campaignId: item.id, stepId: editingStep?.id, position: data.get("position"), delayDays: data.get("delayDays"), locale: data.get("locale"), subject: data.get("subject"), body: data.get("body"), active: data.get("active") === "on" }), t("memberOperations.welcome.step.saved"), () => { form.reset(); setEditingStep(null); reload(); }); }}>
              <h5>{editingStep ? t("memberOperations.welcome.step.editTitle") : t("memberOperations.welcome.step.addTitle")}</h5><label>{t("memberOperations.welcome.step.position")}<input name="position" type="number" min="0" max="50" defaultValue={editingStep?.position} required /></label><label>{t("memberOperations.welcome.step.delayDays")}<input name="delayDays" type="number" min="0" max="365" defaultValue={editingStep?.delayDays} required /></label><label>{t("memberOperations.welcome.step.language")}<select name="locale" defaultValue={editingStep?.locale || "en"}><LanguageOptions t={t} /></select></label><label>{t("memberOperations.welcome.step.subject")}<input name="subject" maxLength={200} defaultValue={editingStep?.subject} required /></label><label className="member-operations-wide">{t("memberOperations.welcome.step.message")}<textarea name="body" maxLength={10000} defaultValue={editingStep?.body} required /></label><label><input name="active" type="checkbox" defaultChecked={editingStep?.active !== false} /> {t("memberOperations.welcome.step.active")}</label><BusyButton type="submit" pending={busy}>{editingStep ? t("memberOperations.welcome.step.save") : t("memberOperations.welcome.step.add")}</BusyButton>{editingStep && <BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={() => setEditingStep(null)}>{t("memberOperations.welcome.step.cancelEdit")}</BusyButton>}
            </form>
            <form className="member-operations-formline" onSubmit={searchMembers}><label>{t("memberOperations.welcome.findMember")}<input type="search" value={memberQuery} minLength={2} onChange={(event) => setMemberQuery(event.target.value)} /></label><BusyButton type="submit" pending={busy} disabled={memberQuery.trim().length < 2}>{t("memberOperations.welcome.searchMembers")}</BusyButton></form>
            <form className="member-operations-formline" onSubmit={(event) => {
              event.preventDefault();
              if (enrollmentBlock) return;
              commit(() => adapter.enrollWelcome(actor, { campaignId: item.id, memberUserId }), t("memberOperations.welcome.enrolled"), () => { setMemberUserId(""); reload(); });
            }}>
              <label>{t("memberOperations.welcome.enrollMember")}<select value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)} required><option value="">{t("memberOperations.welcome.chooseMember")}</option>{memberResults.map((person) => <option value={person.userId} key={person.userId}>{person.fullName}</option>)}</select></label>
              <BusyButton type="submit" pending={busy} disabled={Boolean(enrollmentBlock)} disabledReason={enrollmentBlock ? t(`memberOperations.welcome.${enrollmentBlock}`) : null}>{t("memberOperations.welcome.enroll")}</BusyButton>
            </form>
            <ol className="member-operations-step-list">{item.steps.map((step) => <li key={step.id}><strong>{t("memberOperations.welcome.stepDay", { days: step.delayDays, subject: step.subject })}</strong><span>{t("memberOperations.welcome.stepMeta", { language: labelled(t, "memberOperations.languageName", step.locale || "en"), position: step.position, status: step.active ? t("memberOperations.welcome.stepStatus.active") : t("memberOperations.welcome.stepStatus.inactive") })}</span><div className="member-operations-actions"><BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={() => setEditingStep(step)}>{t("memberOperations.welcome.edit")}</BusyButton><BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={() => commit(() => adapter.saveWelcomeStep(actor, { campaignId: item.id, stepId: step.id, position: step.position, delayDays: step.delayDays, locale: step.locale, subject: step.subject, body: step.body, active: !step.active }), step.active ? t("memberOperations.welcome.stepDeactivated") : t("memberOperations.welcome.stepActivated"), reload)}>{step.active ? t("memberOperations.welcome.deactivate") : t("memberOperations.welcome.activateStep")}</BusyButton></div></li>)}</ol>
            <div className="member-operations-list">{item.enrollments.map((enrollment) => <div className="member-operations-enrollment" key={enrollment.id}><div className="member-operations-row"><div className="member-operations-row__main"><strong>{enrollment.memberName}</strong><span>{t("memberOperations.welcome.nextStep", { position: enrollment.nextStepPosition })} · {t("memberOperations.welcome.deliveryRecords", { count: enrollment.deliveries.length })}</span></div><span className="member-operations-status">{labelled(t, "memberOperations.welcome.enrollmentState", enrollment.state)}</span>{["active", "paused"].includes(enrollment.state) && <BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={() => commit(() => adapter.transitionWelcome(actor, { enrollmentId: enrollment.id, state: enrollment.state === "active" ? "paused" : "active" }), t("memberOperations.welcome.enrollmentUpdated"), reload)}>{enrollment.state === "active" ? t("memberOperations.welcome.pauseEnrollment") : t("memberOperations.welcome.resumeEnrollment")}</BusyButton>}{["active", "paused"].includes(enrollment.state) && <BusyButton type="button" className="member-operations-destructive" pending={busy} onClick={() => window.confirm(t("memberOperations.welcome.cancelEnrollmentConfirm", { name: enrollment.memberName })) && commit(() => adapter.transitionWelcome(actor, { enrollmentId: enrollment.id, state: "cancelled" }), t("memberOperations.welcome.enrollmentCancelled"), reload)}>{t("memberOperations.welcome.cancelEnrollment")}</BusyButton>}</div>{enrollment.deliveries.length > 0 && <ul className="member-operations-deliveries" aria-label={t("memberOperations.welcome.deliveryHistory", { name: enrollment.memberName })}>{enrollment.deliveries.map((delivery) => <li key={delivery.id}><span>{labelled(t, "memberOperations.welcome.deliveryState", delivery.state)}</span><span>{delivery.errorCode ? t("memberOperations.welcome.attemptError", { count: delivery.attemptCount, code: delivery.errorCode }) : t("memberOperations.welcome.attempts", { count: delivery.attemptCount })}</span></li>)}</ul>}</div>)}{item.enrollmentNextCursor && <BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={() => loadOlder(item.id, item.enrollmentNextCursor)}>{t("memberOperations.welcome.loadOlder")}</BusyButton>}</div>
          </div>}
        </article>;
      })}
    </div>
  </section>;
}

function importStageKey(count) {
  if (count === 0) return "memberOperations.imports.stage.none";
  return count === 1 ? "memberOperations.imports.stage.one" : "memberOperations.imports.stage.many";
}

function Imports({ workspace, actor, adapter, busy, commit, reload, onNotice, t }) {
  const [kind, setKind] = useState("member");
  const [filename, setFilename] = useState("");
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [parseError, setParseError] = useState("");
  const [batches, setBatches] = useState(workspace.imports);
  const [nextCursor, setNextCursor] = useState(workspace.importsNextCursor || null);
  useEffect(() => {
    setBatches(workspace.imports);
    setNextCursor(workspace.importsNextCursor || null);
  }, [workspace.imports, workspace.importsNextCursor]);
  const fields = kind === "member" ? MEMBER_IMPORT_FIELDS : GRIEVANCE_IMPORT_FIELDS;
  const mappingState = useMemo(() => validateMemberOperationsMapping(kind, mapping), [kind, mapping]);
  async function readFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setParseError("");
    setParsed(null);
    try {
      const next = parseMemberOperationsCsv(await file.text());
      setFilename(file.name);
      setParsed(next);
      setMapping(Object.fromEntries(next.headers.map((header) => [header, fields.includes(header) ? header : ""])));
    } catch (error) {
      setFilename("");
      setMapping({});
      setParseError(error?.message || t("memberOperations.errors.csvRead"));
    }
  }
  function normalizedRows() {
    return parsed.rows.map((row) => Object.fromEntries(Object.entries(mapping).filter(([, target]) => target).map(([source, target]) => [target, row[source] || ""])));
  }
  async function loadOlder() {
    if (!nextCursor) return;
    try {
      const page = await adapter.listImports(actor, {
        beforeCreatedAt: nextCursor.createdAt, beforeId: nextCursor.id,
      });
      setBatches((current) => [...current, ...(page?.items || [])]);
      setNextCursor(page?.nextCursor || null);
    } catch (error) {
      onNotice(error?.message || t("memberOperations.errors.olderImports"));
    }
  }
  return <section className="member-operations-section" aria-labelledby="member-operations-imports-title">
    <div className="member-operations-heading"><div><p>{t("memberOperations.imports.eyebrow")}</p><h3 id="member-operations-imports-title">{t("memberOperations.imports.title")}</h3></div><span>{t("memberOperations.imports.maxRows")}</span></div>
    <p className="member-operations-note">{t("memberOperations.imports.note")}</p>
    <form className="member-operations-import" onSubmit={(event) => { event.preventDefault(); commit(() => adapter.stageImport(actor, { kind, filename, mapping, rows: normalizedRows() }), t("memberOperations.imports.staged"), () => { setParsed(null); setFilename(""); reload(); }); }}>
      <label>{t("memberOperations.imports.type")}<select value={kind} onChange={(event) => { setKind(event.target.value); setParsed(null); setFilename(""); setMapping({}); setParseError(""); }}><option value="member">{t("memberOperations.imports.typeOption.member")}</option><option value="grievance">{t("memberOperations.imports.typeOption.grievance")}</option></select></label>
      <label>{t("memberOperations.imports.csvFile")}<input type="file" accept=".csv,text/csv" aria-describedby="member-operations-import-feedback" onChange={readFile} /></label>
      {parsed && <div className="member-operations-mapping"><h4>{t("memberOperations.imports.mapColumns")}</h4>{parsed.headers.map((header) => <label key={header}>{header}<select value={mapping[header] || ""} onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value }))}><option value="">{t("memberOperations.imports.ignore")}</option>{fields.map((field) => <option value={field} key={field}>{labelled(t, "memberOperations.imports.field", field, field.replaceAll("_", " "))}</option>)}</select></label>)}</div>}
      <div id="member-operations-import-feedback" className={parseError || (parsed && !mappingState.valid) ? "member-operations-error" : "member-operations-note-inline"} role="status">
        {parseError || (parsed && !mappingState.valid ? mappingState.errors.join(" ") : parsed ? t(parsed.rows.length === 1 ? "memberOperations.imports.rowsReady.one" : "memberOperations.imports.rowsReady.many", { count: parsed.rows.length }) : t("memberOperations.imports.hint"))}
      </div>
      <BusyButton type="submit" pending={busy} disabled={!parsed || !mappingState.valid}>{t(importStageKey(parsed?.rows.length || 0), { count: parsed?.rows.length || 0 })}</BusyButton>
    </form>
    <div className="member-operations-list">{batches.length === 0 && <p className="member-operations-empty">{t("memberOperations.imports.empty")}</p>}{batches.map((batch) => <article className="member-operations-card" key={batch.id}><div className="member-operations-heading"><div><h4>{batch.filename}</h4><p>{labelled(t, "memberOperations.imports.kind", batch.kind)} · {t(batch.validCount === 1 ? "memberOperations.imports.validCountOne" : "memberOperations.imports.validCount", { count: batch.validCount })} · {t(batch.errorCount === 1 ? "memberOperations.imports.errorCountOne" : "memberOperations.imports.errorCount", { count: batch.errorCount })}</p></div><span className="member-operations-status">{labelled(t, "memberOperations.imports.batchState", batch.state)}</span></div>{batch.errors.map((error) => <p className="member-operations-error" key={`${error.rowNumber}-${error.field}-${error.code}`}>{t("memberOperations.imports.rowError", { row: error.rowNumber, field: error.field, message: error.message })}</p>)}<div className="member-operations-actions">{["uploaded", "validated", "failed"].includes(batch.state) && <BusyButton type="button" pending={busy} onClick={() => commit(() => adapter.validateImport(actor, batch.id), t("memberOperations.imports.validated"), reload)}>{t("memberOperations.imports.validate")}</BusyButton>}{batch.state === "validated" && batch.errorCount === 0 && <BusyButton type="button" pending={busy} onClick={() => commit(() => adapter.commitImport(actor, batch.id), t("memberOperations.imports.committed"), async (result) => { await reload(); if (result?.state !== "committed") throw new Error(t("memberOperations.imports.revalidationError")); })}>{t("memberOperations.imports.commit")}</BusyButton>}{["uploaded", "validated", "failed"].includes(batch.state) && <BusyButton type="button" className="member-operations-destructive" pending={busy} onClick={() => window.confirm(t("memberOperations.imports.discardConfirm", { filename: batch.filename })) && commit(() => adapter.discardImport(actor, batch.id), t("memberOperations.imports.discarded"), reload)}>{t("memberOperations.imports.discard")}</BusyButton>}</div></article>)}{nextCursor && <BusyButton type="button" className="member-operations-secondary" pending={busy} onClick={loadOlder}>{t("memberOperations.imports.loadOlder")}</BusyButton>}</div>
  </section>;
}

export function MemberOperations({ actor, client, session = null, onNotice = () => {} }) {
  const { t } = useLang();
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const actorKey = featureActorIdentityKey(actor);
  const current = useMemo(() => {
    void actorKey;
    return normalizeMemberOperationsActor(actorRef.current);
  }, [actorKey]);
  const adapter = useMemo(() => createMemberOperationsAdapter(client), [client]);
  const [workspace, setWorkspace] = useState({ state: "loading", directory: { items: [] }, campaigns: [], imports: [] });
  const [tab, setTab] = useRoutedTab("memberOperations", "directory");
  const [busy, setBusy] = useState(false);
  // Every write goes through commit(): one synchronous lock refuses a second
  // activation before React commits `busy` (#8435).
  const busyWriteRef = useRef(new Set());
  const accessToken = session?.access_token || null;
  const load = useCallback(async () => {
    const next = await adapter.load(current);
    if (next.state === "ready" && accessToken) {
      try {
        const delivery = await loadEngagementDeliveryStatus(sessionRef.current);
        next.deliveryConfigured = delivery?.configured === true;
        next.deliveryStatusUnavailable = false;
      } catch {
        next.deliveryStatusUnavailable = true;
      }
    }
    setWorkspace(next);
  }, [accessToken, adapter, current]);
  useEffect(() => { void load(); }, [actorKey, load]);
  const commit = useCallback(async (operation, message, after) => {
    if (busy) return;
    await runBusyWrite(busyWriteRef, "memberOperations", async () => {
      setBusy(true);
      try { const result = await operation(); await after?.(result); onNotice(message); } catch (error) { onNotice(error?.message || t("memberOperations.errors.save")); }
      finally { setBusy(false); }
    });
  }, [busy, onNotice, t]);
  const tabs = [
    ["directory", t("memberOperations.tab.directory")],
    ["welcome", t("memberOperations.tab.welcome")],
    ["imports", t("memberOperations.tab.imports")],
  ];
  return <article id="admin-member-operations" className="member-operations" data-mi1-surface="member-operations">
    <header className="member-operations-header"><div><p>{t("memberOperations.eyebrow")}</p><h2>{t("memberOperations.title")}</h2><span>{t("memberOperations.subtitle")}</span></div></header>
    <State state={workspace.state} actor={current} retry={load} t={t} />
    {workspace.state === "ready" && <>
      <div className="member-operations-tabs" role="group" aria-label={t("memberOperations.tabsLabel")}>{tabs.map(([id, text]) => <RoutedTabLink group="memberOperations" value={id} type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{text}</RoutedTabLink>)}</div>
      {tab === "directory" && <Directory {...{ workspace, actor: current, adapter, busy, commit, reload: load, onNotice, t }} />}
      {tab === "welcome" && <Welcome {...{ workspace, actor: current, adapter, busy, commit, reload: load, onNotice, t }} />}
      {tab === "imports" && <Imports {...{ workspace, actor: current, adapter, busy, commit, reload: load, onNotice, t }} />}
    </>}
  </article>;
}
