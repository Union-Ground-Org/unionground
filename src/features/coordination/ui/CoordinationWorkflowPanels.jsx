import { useEffect, useRef, useState } from "react";
import { useLang } from "../../../lib/LanguageContext.jsx";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { dateTimeFormat } from "../../../lib/i18n.js";
import { CoordinationForm } from "./CoordinationForm.jsx";
import {
  canPerformCoordinationIntent,
  coordinationExtensionFields,
  networkLinksForCapability,
  NETWORK_RESOURCE_CAPABILITY,
  normalizeCoordinationActor,
} from "../authorization.js";
import {
  COORDINATION_EXTENSIONS_RETRYABLE_STATES,
  COORDINATION_TABS,
  EMPTY_COORDINATION_EXTENSIONS,
} from "../contract.js";

function Panel({ title, children }) {
  return <section className="coord-workflow-panel"><h3>{title}</h3>{children}</section>;
}

// Coverage copy never prints recommendedUserId: it is an account identifier,
// and the Chapter tab is open to every organization member.
function coverageLabelKey(coverage) {
  if (coverage?.state === "failed") return "coordination.panel.coverageFailed";
  return coverage?.state === "covered" ? "coordination.panel.coverageCovered" : "coordination.panel.coverageNone";
}

// REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001: the recommendation now
// carries the steward's display name and only the contact routes that steward
// opted into (the Find my steward roster's audience). The account id is still
// never printed. A 'nearest' result means nobody is scheduled right now.
function CoverageResult({ coverage, t }) {
  const steward = coverage?.steward && typeof coverage.steward.name === "string" && coverage.steward.name.trim()
    ? coverage.steward : null;
  if (!steward) {
    return <p className="coord-muted" role="status">{t(coverage?.state === "nearest" ? "coordination.panel.coverageNone" : coverageLabelKey(coverage))}</p>;
  }
  const email = typeof steward.contact?.email === "string" && steward.contact.email ? steward.contact.email : null;
  const phone = typeof steward.contact?.phone === "string" && steward.contact.phone ? steward.contact.phone : null;
  const level = ["work_location", "department", "chapter"].includes(coverage.matchLevel) ? coverage.matchLevel : null;
  return <div role="status">
    <p className="coord-muted">{coverage.state === "nearest"
      ? t("stewardMatch.nearest", { name: steward.name })
      : t("stewardMatch.recommended", { name: steward.name })}</p>
    {level && <p className="coord-muted">{t(`stewardMatch.level.${level}`)}</p>}
    {(email || phone) && <p>
      {email && <a href={`mailto:${email}`}>{t("stewardMatch.email", { email })}</a>}
      {email && phone && " · "}
      {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}>{t("stewardMatch.phone", { phone })}</a>}
    </p>}
    {steward.contact?.conversation && <p className="coord-muted">{t("stewardMatch.message")}</p>}
  </div>;
}

// Every way the deferred load can fail, and whether pressing the control again
// is honest. adapter.loadDirectoryExtensions funnels each rejection through
// deferredDirectoryState() (src/features/coordination/adapter.js), which yields
// four distinct states — so "not error" never meant "not failed". Showing the idle
// invitation for the other three re-offered a control whose next press re-issues
// an RPC that writes a 'directory_viewed' audit row.
//
// Only ONE of them keeps the control: `unavailable`, which the adapter derives
// only from failures that provably happened before the function ran, so no audit
// row can exist and one more press is safe. A missing two-step check and a refused
// authorization earn the same answer again. And the generic `error` is ambiguous —
// the insert may already have committed when the response was lost — so it states
// that the result could not be confirmed and asks for a reload instead of offering
// a press that would write a second row for the same visit.
const DIRECTORY_FAILURES = Object.freeze({
  mfa_required: Object.freeze({ title: "coordination.directoryMfaTitle", body: "coordination.directoryMfaBody" }),
  unauthorized: Object.freeze({ title: "coordination.directoryUnauthorizedTitle", body: "coordination.directoryUnauthorizedBody" }),
  unavailable: Object.freeze({ title: "coordination.directoryUnavailableTitle", body: "coordination.directoryUnavailableBody" }),
  error: Object.freeze({ title: "coordination.directoryUnconfirmedTitle", body: "coordination.directoryRequestError" }),
});

// `idle` and `loading` are the only non-failure states this surface renders; a
// ready or answered-empty projection is handled by the caller. Anything else is
// a failure, and an unrecognized one is treated as the generic error rather than
// silently falling back to the invitation copy. Whether it keeps the control is
// the contract's list, the same one the wiring's latch reads.
function directoryFailure(state) {
  if (state === "idle" || state === "loading") return null;
  const copy = DIRECTORY_FAILURES[state] || DIRECTORY_FAILURES.error;
  return { ...copy, retry: COORDINATION_EXTENSIONS_RETRYABLE_STATES.includes(state) };
}

// The idle and failure surface for the deferred directory projection. It is an
// ordinary body panel inside the ready .coord-desk — NOT a .coord-state
// whole-page panel and NOT the "nobody opted into directory visibility" empty
// state, which would claim the backend answered when nothing was asked. It
// reuses .coord-button (48 px minimum target) and the card/muted token pair the
// desk already ships, and it never replaces the page heading or the tab links.
//
// role="status" is what makes the request legible without sight: idle -> loading
// -> outcome all happen inside this one panel, and every one of those is a state
// change an operator has to hear, not a new page.
//
// The control is never given the `disabled` attribute. A real browser blurs a
// focused element the instant it becomes disabled, so `disabled` while the RPC is
// in flight threw the operator who had just pressed it onto <body> — and for the
// two outcomes that KEEP the control (unavailable, error) nothing ever brought
// them back, because the heading anchor below only fires on the transition that
// removes the control and `offersControl` never changes on those paths. The
// control is therefore made inert in place instead: aria-disabled="true" tells
// assistive technology it will not act, aria-busy="true" says why, and the click
// handler refuses activation itself, so a second press during the load issues no
// second writing RPC. The node stays in the tab order and stays focused, which is
// the whole point: the operator does not move.
//
// The heading still carries tabIndex=-1 as a non-interactive focus anchor, for
// the two refusals (mfa_required/unauthorized) that delete the control outright:
// there the focused node really does leave the document, so without the anchor
// focus falls to <body> and a keyboard or screen-reader operator loses their
// place in the desk at the exact moment the panel is explaining the refusal. The
// anchor is taken only on that transition, and only when focus is still inside
// this panel or already stranded on <body>, so it can never steal focus from an
// operator who has moved on. src/features/coordination/ui/organizationCoordination.css
// gives it the desk's :focus-visible ring so the landing is visible, not just
// programmatic.
// Why the control cannot act yet, when the reason is the session's own scope
// rather than a load. The RPC behind it takes no organization argument — it
// resolves one from private.current_member_organization() and writes a
// 'directory_viewed' row for THAT organization — so pressing it while the desk
// still holds the organization the route was mounted with can record another
// tenant's audit row and only then answer "unauthorized". The control therefore
// stays visible, focusable and explained, and refuses to act, until
// get_my_chapter_memberships has answered.
const DIRECTORY_SCOPE_BODIES = Object.freeze({
  pending: "coordination.directoryScopePendingBody",
  unconfirmed: "coordination.directoryScopeUnconfirmedBody",
});

function DirectoryExtensionsRequest({ state, busy, onShow, sessionScope = "resolved", onRetryScope = null }) {
  const { t } = useLang();
  const loading = state === "loading";
  const failure = directoryFailure(state);
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const offersControl = Boolean(onShow) && (!failure || failure.retry);
  const hadControl = useRef(offersControl);
  const authoritative = sessionScope === "resolved";
  // Inert, not removed from the focus order: `busy` is a desk-wide write in
  // flight, `loading` is this request's own, and an unresolved session scope is
  // the third — none of them may move focus, and none of them may let the press
  // through.
  const inert = Boolean(busy) || loading || !authoritative;
  const offersScopeRetry = sessionScope === "unconfirmed" && typeof onRetryScope === "function";

  useEffect(() => {
    if (hadControl.current && !offersControl) {
      const active = typeof document === "undefined" ? null : document.activeElement;
      const stranded = !active || active === document.body;
      if (stranded || panelRef.current?.contains(active)) headingRef.current?.focus();
    }
    hadControl.current = offersControl;
  }, [offersControl]);

  return <section ref={panelRef} className="coord-workflow-panel" role="status" data-coordination-extensions={state} data-coordination-scope={sessionScope}>
    <h3 ref={headingRef} tabIndex={-1}>{t(failure ? failure.title : "coordination.directoryRequestTitle")}</h3>
    <p className="coord-muted">{t(failure
      ? failure.body
      : (authoritative ? "coordination.directoryRequestBody" : DIRECTORY_SCOPE_BODIES[sessionScope]))}</p>
    {offersControl && <button
      type="button"
      className="coord-button"
      aria-disabled={inert ? "true" : undefined}
      aria-busy={loading ? "true" : undefined}
      onClick={() => { if (!inert) onShow(); }}
    >
      {loading ? t("coordination.directoryRequestLoading") : t("coordination.directoryRequestAction")}
    </button>}
    {offersScopeRetry && <button
      type="button"
      className="coord-button"
      onClick={onRetryScope}
    >
      {t("coordination.directoryScopeRetryAction")}
    </button>}
  </section>;
}

// The line an answered load leaves behind, and the place focus lands when the
// answer removes the control. The request control is gone by then, so without this
// the panel simply vanished: the operator could not tell the projection had loaded
// and, having pressed the control, was dropped on <body> because the focused node
// left the document — the refusal states kept their panel and its heading anchor,
// the two SUCCESSFUL states had nothing to hand focus to at all. It is a plain body
// line reusing the shipped .coord-muted token pair, deliberately not a .coord-state
// panel; it keeps role="status" so the outcome is spoken, and tabIndex=-1 so it is a
// landing place rather than a new tab stop.
//
// Focus is taken only when it is stranded — no active element, or <body> — which is
// exactly the state the browser leaves behind when it removes the focused control.
// An operator who had already moved on keeps their place.
function DirectoryExtensionsAcknowledged({ state, rendered, stale = false }) {
  const { t } = useLang();
  const lineRef = useRef(null);
  useEffect(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!active || active === document.body) lineRef.current?.focus();
  }, []);
  return <p
    ref={lineRef}
    tabIndex={-1}
    className="coord-muted"
    role="status"
    data-coordination-extensions={state}
  >
    {t(rendered ? "coordination.directoryRequestReady" : "coordination.directoryRequestEmpty")}
    {stale ? <><br />{t("coordination.directoryRequestStale")}</> : null}
  </p>;
}

// The projection fields each tab actually renders. `chapter` renders none of them
// — the page-attachment surface it would have shown was never built, and the
// callbacks, adapter mutations and `pageAttachments` contract field behind it
// were removed rather than left unreachable
// (DEBT-UG-COORDINATION-PAGE-ATTACHMENT-DEAD-WIRING-20260920) — which is why
// a ready load must still acknowledge itself there. `network` is always
// considered rendered because its directory panel appears on any ready load and
// states its own emptiness, so the acknowledgement would only repeat it.
const TAB_EXTENSION_FIELDS = Object.freeze({
  missions: Object.freeze(["badges", "recentActivity"]),
  network: Object.freeze(["directory"]),
  coalitions: Object.freeze(["invitations"]),
  operations: Object.freeze(["mergeJobs"]),
  chapter: Object.freeze([]),
  mobilize: Object.freeze(["mobilizationProgress"]),
});

function extensionsRenderedOnTab(tab, extensions) {
  if (tab === "network") return true;
  return (TAB_EXTENSION_FIELDS[tab] || []).some((field) => (extensions?.[field] || []).length > 0);
}

// Partner messages and network access events carry the stored ISO-8601
// createdAt, which the rows used to interpolate verbatim — every reader saw
// 2026-08-01T12:00:00Z where a date and time belonged. One formatter per render
// serves every row, and an absent or unparseable stamp renders nothing rather
// than throwing or putting the raw string back on the page.
const NETWORK_STAMP_OPTIONS = Object.freeze({ dateStyle: "medium", timeStyle: "short" });

function networkStampFormatter(lang) {
  const formatter = dateTimeFormat(lang, NETWORK_STAMP_OPTIONS);
  return (value) => {
    const instant = new Date(value ?? "").getTime();
    return Number.isNaN(instant) ? "" : formatter.format(instant);
  };
}

// The save sends every field, so the form must open on the saved profile:
// a blank form would reset the summary, visibility, contact routing and parent
// link the officer never touched. It is keyed by the saved row so a reload or a
// save that changes it re-seeds the fields.
function NetworkProfileForm({ profile, busy, onSaveProfile }) {
  const [displayName, setDisplayName] = useState(profile?.displayName || "");
  const [summary, setSummary] = useState(profile?.summary || "");
  const [visibility, setVisibility] = useState(profile?.visibility || "private");
  const [contactMode, setContactMode] = useState(profile?.contactMode || "disabled");
  const [parentOrganizationId, setParentOrganizationId] = useState(profile?.parentOrganizationId || "");
  const { t } = useLang();
  return <form className="coord-inline-form" onSubmit={(event) => { event.preventDefault(); onSaveProfile({ displayName, summary, visibility, contactMode, parentOrganizationId: parentOrganizationId || null }); }}>
    <label>{t("coordination.panel.displayName")}<input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
    <label>{t("coordination.panel.summary")}<textarea maxLength={1000} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
    <label>{t("coordination.panel.visibility")}<select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="private">{t("coordination.panel.visibilityPrivate")}</option><option value="partners">{t("coordination.panel.visibilityPartners")}</option><option value="directory">{t("coordination.panel.visibilityDirectory")}</option></select></label>
    <label>{t("coordination.panel.contactRouting")}<select value={contactMode} onChange={(event) => setContactMode(event.target.value)}><option value="disabled">{t("coordination.panel.contactDisabled")}</option><option value="coordinator_routed">{t("coordination.panel.contactCoordinatorRouted")}</option></select></label>
    <label>{t("coordination.panel.parentOrganization")}<input value={parentOrganizationId} onChange={(event) => setParentOrganizationId(event.target.value)} placeholder={t("coordination.panel.parentPlaceholder")} /></label>
    <BusyButton className="coord-button" pending={busy}>{t("coordination.panel.saveProfile")}</BusyButton>
  </form>;
}

function NetworkPanel({
  actor,
  model,
  gate,
  extensionsReady,
  extensionsAnswered,
  extensionsRequestable,
  busy,
  pagingMessages,
  onSaveProfile,
  onSetPermission,
  onResource,
  onRespondResource,
  onOpenSharedDocument,
  onLoadMoreMessages,
}) {
  const [networkRecordId, setNetworkRecordId] = useState("");
  const [granteeOrganizationId, setGranteeOrganizationId] = useState("");
  const [capability, setCapability] = useState("message");
  const [resourceRecordId, setResourceRecordId] = useState("");
  const [resourceKind, setResourceKind] = useState("request");
  const [resourceTitle, setResourceTitle] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [openedDocument, setOpenedDocument] = useState(null);
  const [messageQuery, setMessageQuery] = useState("");
  const { lang, t } = useLang();
  const stamp = networkStampFormatter(lang);
  const links = (model.records || []).filter((record) => record.kind === "network_link" && record.status === "active");
  const staff = Boolean(model.staff);
  // upsert_organization_network_profile and set_organization_network_permission
  // narrow to coordinator/admin/vp while canManageCoordination admits steward and
  // advisor too, so these two panels read the intent table; the resource and
  // oversight panels keep the desk-wide staff flag their RPCs accept.
  const canSaveProfile = canPerformCoordinationIntent(actor, "saveProfile");
  const canSetPermission = canPerformCoordinationIntent(actor, "setPermission");
  // The directory projection always includes the caller's own saved profile, so
  // the form is seeded from it once that projection has answered.
  const ownProfile = (model.directory || []).find((entry) => entry.organizationId === actor?.selectedOrganizationId) || null;
  // Unknown until the deferred projection answers; see networkLinksForCapability.
  const grants = extensionsReady ? (model.permissions || []) : null;
  // A resource row is refused unless the two organizations hold the grant for
  // the kind being sent, and request and share are separate grants — so the
  // type a link cannot carry is not offered for it, and a link that carries
  // neither is not offered at all.
  const resourceLinks = Object.fromEntries(Object.entries(NETWORK_RESOURCE_CAPABILITY)
    .map(([kind, capability]) => [kind, networkLinksForCapability(model.records, capability, grants)]));
  const resourceKinds = Object.keys(resourceLinks).filter((kind) => resourceLinks[kind].length > 0);
  const selectedResourceKind = resourceKinds.includes(resourceKind) ? resourceKind : (resourceKinds[0] || "request");
  const selectedResourceLinks = resourceLinks[selectedResourceKind] || [];
  const selectedResourceRecordId = selectedResourceLinks.some((record) => record.id === resourceRecordId) ? resourceRecordId : "";
  const conversations = new Map((model.records || []).map((record) => [record.id, record.title]));
  const normalizedQuery = messageQuery.trim().toLowerCase();
  const visibleMessages = [...(model.messages || [])]
    .filter((message) => !normalizedQuery
      || String(message.body || "").toLowerCase().includes(normalizedQuery)
      || String(conversations.get(message.conversationId) || "").toLowerCase().includes(normalizedQuery))
    .reverse();

  return <div className="coord-workflow-stack">
    {gate}
    {extensionsReady && <Panel title={t("coordination.panel.directoryTitle")}>
      {(model.directory || []).length ? <div className="coord-list">{model.directory.map((entry) => <article key={entry.organizationId} className="coord-list__row"><strong>{entry.displayName}</strong><span>{entry.summary || t("coordination.panel.directoryNoSummary")}</span><small>{entry.contactMode.replaceAll("_", " ")}{entry.parentOrganizationId ? ` · ${t("coordination.panel.directoryParent", { id: entry.parentOrganizationId })}` : ""}</small></article>)}</div> : <p className="coord-muted">{t("coordination.panel.directoryEmpty")}</p>}
    </Panel>}
    {canSaveProfile && (extensionsAnswered || extensionsRequestable) && <Panel title={t("coordination.panel.profileTitle")}>
      {extensionsAnswered
        ? <NetworkProfileForm key={ownProfile ? `${ownProfile.organizationId}:${ownProfile.updatedAt || ""}` : "new"} profile={ownProfile} busy={busy} onSaveProfile={onSaveProfile} />
        : <p className="coord-muted">{t("coordination.panel.profileLoadFirst")}</p>}
    </Panel>}
    {canSetPermission && links.length > 0 && <Panel title={t("coordination.panel.permissionsTitle")}>
      <CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.grantPermission")} onSubmit={(publish) => onSetPermission({ networkRecordId, granteeOrganizationId, capability, enabled: true }, publish)}>
        <label>{t("coordination.panel.acceptedNetwork")}<select required value={networkRecordId} onChange={(event) => setNetworkRecordId(event.target.value)}><option value="">{t("coordination.panel.chooseLink")}</option>{links.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>
        <label>{t("coordination.panel.partnerOrganizationId")}<input required value={granteeOrganizationId} onChange={(event) => setGranteeOrganizationId(event.target.value)} /></label>
        <label>{t("coordination.panel.capability")}<select value={capability} onChange={(event) => setCapability(event.target.value)}>{["directory_contact", "message", "resource_request", "resource_share", "oversight"].map((value) => <option key={value} value={value}>{t(`coordination.panel.capability.${value}`)}</option>)}</select></label>
      </CoordinationForm>
    </Panel>}
    {staff && resourceKinds.length > 0 && <Panel title={t("coordination.panel.resourceTitle")}>
      <CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.submitResource")} onSubmit={(publish) => onResource({ recordId: selectedResourceRecordId, kind: selectedResourceKind, title: resourceTitle, documentId: selectedResourceKind === "share" ? documentId : null }, publish)}>
        <label>{t("coordination.panel.network")}<select required value={selectedResourceRecordId} onChange={(event) => setResourceRecordId(event.target.value)}><option value="">{t("coordination.panel.chooseLink")}</option>{selectedResourceLinks.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>
        <label>{t("coordination.panel.type")}<select value={selectedResourceKind} onChange={(event) => setResourceKind(event.target.value)}>{resourceKinds.map((kind) => <option key={kind} value={kind}>{t(kind === "share" ? "coordination.panel.resourceShare" : "coordination.panel.resourceRequest")}</option>)}</select></label>
        <label>{t("coordination.panel.title")}<input required value={resourceTitle} onChange={(event) => setResourceTitle(event.target.value)} /></label>
        {selectedResourceKind === "share" && <label>{t("coordination.panel.chapterDocumentId")}<input required value={documentId} onChange={(event) => setDocumentId(event.target.value)} /></label>}
      </CoordinationForm>
    </Panel>}
    {staff && (model.resources || []).length > 0 && <Panel title={t("coordination.panel.resourceInbox")}>
      <div className="coord-list">{model.resources.map((resource) => <article className="coord-list__row" key={resource.id}><strong>{resource.title}</strong><span>{resource.kind} · {resource.status}</span><div className="coord-card__actions">{resource.toOrganizationId === actor.selectedOrganizationId && ["requested", "available"].includes(resource.status) && <><BusyButton className="coord-button" pending={busy} onClick={() => onRespondResource(resource.id, true)}>{t("coordination.panel.accept")}</BusyButton><BusyButton className="coord-button coord-button--secondary" pending={busy} onClick={() => onRespondResource(resource.id, false)}>{t("coordination.panel.decline")}</BusyButton></>}{resource.kind === "share" && resource.status === "accepted" && <BusyButton className="coord-button coord-button--secondary" pending={busy} onClick={() => onOpenSharedDocument(resource.id).then(setOpenedDocument).catch(() => setOpenedDocument(null))}>{t("coordination.panel.openSharedDocument")}</BusyButton>}</div></article>)}</div>
      {openedDocument && <article className="coord-shared-document"><h4>{openedDocument.title}</h4><p>{openedDocument.summary}</p><div>{openedDocument.body}</div></article>}
    </Panel>}
    {(model.messages || []).length > 0 && <Panel title={t("coordination.networkMessagesTitle")}>
      <label>{t("coordination.panel.searchMessages")}<input type="search" value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} /></label>
      <div className="coord-list coord-message-history">{visibleMessages.map((message) => <article className="coord-list__row" key={message.id}><strong>{conversations.get(message.conversationId) || t("coordination.panel.authorizedConversation")}</strong><p>{message.body}</p><small>{t(message.senderOrganizationId === actor.selectedOrganizationId ? "coordination.networkMessageSenderSelf" : "coordination.networkMessageSenderPartner")} · {stamp(message.createdAt)}</small></article>)}</div>
      {model.nextMessagesCursor && onLoadMoreMessages && <BusyButton type="button" className="coord-button coord-button--secondary" pending={pagingMessages} onClick={onLoadMoreMessages}>{t(pagingMessages ? "coordination.panel.loadingOlderMessages" : "coordination.panel.loadOlderMessages")}</BusyButton>}
    </Panel>}
    {staff && (model.networkAccessEvents || []).length > 0 && <Panel title={t("coordination.networkOversightTitle")}><div className="coord-list">{model.networkAccessEvents.map((event) => <article className="coord-list__row" key={event.id}><strong>{String(event.action || t("coordination.panel.activityFallback")).replaceAll("_", " ")}</strong><span>{event.outcome} · {event.actorOrganizationId === actor.selectedOrganizationId ? t("coordination.panel.initiatedHere") : t("coordination.panel.receivedHere")}</span><small>{stamp(event.createdAt)}</small></article>)}</div></Panel>}
  </div>;
}

function CoalitionPanel({
  actor,
  model,
  gate,
  busy,
  onInviteOrganization,
  onRespondParticipant,
  onAssignParticipant,
  onProposeCoalitionDecision,
  onVoteCoalitionDecision,
}) {
  const { t } = useLang();
  const [recordId, setRecordId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [assignRecordId, setAssignRecordId] = useState("");
  const [userId, setUserId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [subjectRecordId, setSubjectRecordId] = useState("");
  const [decisionTitle, setDecisionTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [action, setAction] = useState("authorize_work");
  const [requiredApprovals, setRequiredApprovals] = useState("");
  const records = (model.records || []).filter((record) => ["coalition", "coalition_campaign", "committee"].includes(record.kind));
  // invite_organization_coordination_participant requires an owner or approver on the
  // coalition; a partner org can read another org's coalition but cannot invite to it.
  const invitableCoalitions = records.filter((record) => record.kind === "coalition" && record.organizationId === actor.selectedOrganizationId);
  const campaigns = records.filter((record) => record.kind === "coalition_campaign" && ["active", "paused"].includes(record.status));
  const workItems = (model.records || []).filter((record) => (
    record.kind === "coalition_work_item" && record.parentId === campaignId
  ));
  const decisions = model.coalitionDecisions || [];
  const canRespondToInvitations = canPerformCoordinationIntent(actor, "respondParticipant");
  return <div className="coord-workflow-stack">
    {gate}
    {(model.invitations || []).length > 0 && <Panel title={t("coordination.panel.invitations")}><div className="coord-list">{model.invitations.map((invite) => <article className="coord-list__row" key={invite.recordId}><strong>{invite.title}</strong><span>{invite.kind} · {invite.role}</span>{canRespondToInvitations && <div className="coord-card__actions"><BusyButton className="coord-button" pending={busy} onClick={() => onRespondParticipant(invite.recordId, true)}>{t("coordination.panel.accept")}</BusyButton><BusyButton className="coord-button coord-button--secondary" pending={busy} onClick={() => onRespondParticipant(invite.recordId, false)}>{t("coordination.panel.decline")}</BusyButton></div>}</article>)}</div></Panel>}
    {canPerformCoordinationIntent(actor, "inviteOrganization") && invitableCoalitions.length > 0 && <Panel title={t("coordination.panel.inviteOrganization")}><CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.sendInvitation")} onSubmit={(publish) => { if (!invitableCoalitions.some((record) => record.id === recordId)) return; return onInviteOrganization({ recordId, organizationId, role: "member" }, publish); }}><label>{t("coordination.panel.coalition")}<select required value={recordId} onChange={(event) => setRecordId(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{invitableCoalitions.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label><label>{t("coordination.panel.organizationId")}<input required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} /></label></CoordinationForm></Panel>}
    {model.staff && records.length > 0 && <Panel title={t("coordination.panel.selectMember")}><CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.addMember")} onSubmit={(publish) => { const selected = records.find((record) => record.id === assignRecordId); return onAssignParticipant({ recordId: assignRecordId, userId, role: selected?.kind === "committee" ? "committee_member" : "campaign_lead", active: true }, publish); }}><label>{t("coordination.panel.workRecord")}<select required value={assignRecordId} onChange={(event) => setAssignRecordId(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{records.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label><label>{t("coordination.panel.memberId")}<input required value={userId} onChange={(event) => setUserId(event.target.value)} /></label></CoordinationForm></Panel>}
    {model.staff && campaigns.length > 0 && <Panel title={t("coordination.panel.openDecisionTitle")}>
      <p className="coord-muted">{t("coordination.panel.decisionThresholdNote")}</p>
      <CoordinationForm className="coord-inline-form" busy={busy} disabled={workItems.length === 0} disabledReason={t(campaignId ? "coordination.panel.openDecisionNeedsWork" : "coordination.panel.openDecisionNeedsCampaign")} submitLabel={t("coordination.panel.openDecision")} onSubmit={(publish) => {
        if (workItems.length === 0) return;
        return onProposeCoalitionDecision({
          campaignId,
          subjectRecordId,
          title: decisionTitle,
          rationale,
          action,
          requiredApprovals: requiredApprovals ? Number(requiredApprovals) : null,
        }, publish);
      }}>
        <label>{t("coordination.panel.decisionCampaign")}<select required value={campaignId} onChange={(event) => { setCampaignId(event.target.value); setSubjectRecordId(""); }}><option value="">{t("coordination.panel.choose")}</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.title}</option>)}</select></label>
        <label>{t("coordination.panel.workItem")}<select required value={subjectRecordId} onChange={(event) => setSubjectRecordId(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{workItems.map((work) => <option key={work.id} value={work.id}>{work.title}</option>)}</select></label>
        <label>{t("coordination.panel.decisionTitle")}<input required minLength={2} maxLength={160} value={decisionTitle} onChange={(event) => setDecisionTitle(event.target.value)} /></label>
        <label>{t("coordination.panel.action")}<select value={action} onChange={(event) => setAction(event.target.value)}><option value="authorize_work">{t("coordination.panel.actionAuthorize")}</option><option value="pause_work">{t("coordination.panel.actionPause")}</option><option value="complete_work">{t("coordination.panel.actionComplete")}</option></select></label>
        <label>{t("coordination.panel.approvalThreshold")}<input inputMode="numeric" min="1" max="100" placeholder={t("coordination.panel.thresholdPlaceholder")} value={requiredApprovals} onChange={(event) => setRequiredApprovals(event.target.value)} /></label>
        <label>{t("coordination.panel.rationale")}<textarea maxLength={4000} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
      </CoordinationForm>
    </Panel>}
    {decisions.length > 0 && <Panel title={t("coordination.panel.decisionsTitle")}><div className="coord-list">{decisions.map((decision) => <article className="coord-list__row" key={decision.id}>
      <strong>{decision.title}</strong>
      <span>{decision.status} · {t("coordination.panel.decisionApprovals", { approvals: decision.approvals || 0, required: decision.requiredApprovals })} · {String(decision.action || "").replaceAll("_", " ")}</span>
      {decision.rationale && <p>{decision.rationale}</p>}
      {decision.status === "open" && <div className="coord-card__actions"><BusyButton type="button" className="coord-button" pending={busy} onClick={() => onVoteCoalitionDecision({ decisionId: decision.id, vote: "approve" })}>{t("coordination.panel.approveDecision", { title: decision.title })}</BusyButton><BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onVoteCoalitionDecision({ decisionId: decision.id, vote: "reject" })}>{t("coordination.panel.rejectDecision", { title: decision.title })}</BusyButton></div>}
    </article>)}</div></Panel>}
  </div>;
}

function OperationsPanel({ actor, model, gate, busy, onReviewMergeMatch, onExecuteMerge, onDownloadExport }) {
  // get_organization_coordination_export_payload narrows to coordinator/admin/vp,
  // so a ready internal_download run must not offer a steward or advisor a
  // download the server refuses.
  const canDownloadExport = canPerformCoordinationIntent(actor, "downloadExport");
  const { t } = useLang();
  const [planId, setPlanId] = useState("");
  const [sourceUserId, setSourceUserId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [decision, setDecision] = useState("approved");
  const canExecute = ["admin", "vp"].includes(actor.selectedHat)
    && actor.organizationRoles.includes(actor.selectedHat);
  const plans = (model.records || []).filter((record) => record.kind === "merger_plan"
    && record.status === "active"
    && record.partnerOrganizationId === actor.selectedOrganizationId);
  return <div className="coord-workflow-stack">
    {gate}
    {model.staff && canExecute && plans.length > 0 && <Panel title={t("coordination.panel.reviewMatchTitle")}><CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.saveReview")} onSubmit={(publish) => onReviewMergeMatch({ planId, sourceUserId, targetUserId, decision }, publish)}><label>{t("coordination.panel.acceptedPlan")}<select required value={planId} onChange={(event) => setPlanId(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}</select></label><label>{t("coordination.panel.sourceMemberId")}<input required value={sourceUserId} onChange={(event) => setSourceUserId(event.target.value)} /></label><label>{t("coordination.panel.targetMemberId")}<input required value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} /></label><label>{t("coordination.panel.decision")}<select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="approved">{t("coordination.panel.approveMapping")}</option><option value="rejected">{t("coordination.panel.rejectMapping")}</option></select></label></CoordinationForm></Panel>}
    {model.staff && canExecute && plans.map((plan) => <Panel key={plan.id} title={t("coordination.panel.executeTitle", { title: plan.title })}><p className="coord-muted">{t("coordination.panel.executeNote")}</p><BusyButton className="coord-button" pending={busy} onClick={() => onExecuteMerge({ planId: plan.id, sourceOrganizationId: plan.organizationId, targetOrganizationId: plan.partnerOrganizationId })}>{t("coordination.panel.executeButton")}</BusyButton></Panel>)}
    {(model.mergeJobs || []).length > 0 && <Panel title={t("coordination.panel.mappingJobs")}><div className="coord-list">{model.mergeJobs.map((job) => <article className="coord-list__row" key={job.id}><strong>{job.status}</strong><span>{t("coordination.panel.approvedMappings", { count: job.approvedMatchCount })}</span></article>)}</div></Panel>}
    {(model.exportRuns || []).length > 0 && <Panel title={t("coordination.panel.exportRuns")}><div className="coord-list">{model.exportRuns.map((run) => {
      const dataset = exportRunDataset(run, model.records);
      const downloadable = canDownloadExport && exportRunDownloadable(run) && canReadExportDataset(actor, dataset);
      return <article className="coord-list__row" key={run.id}><strong>{run.format.toUpperCase()} · {run.status}</strong><span>{t("coordination.panel.exportRows", { count: run.rowCount })} · {run.deliveryMode.replaceAll("_", " ")}</span><span>{t(`exportsRestore.dataset.${dataset}`)}{EXPORT_RUN_STATUS_NOTES.has(run.status) ? ` · ${t(run.status === "not_configured" ? `exportsRestore.status.not_configured.${run.deliveryMode === "sftp_unset" ? "sftp" : "email"}` : `exportsRestore.status.${run.status}`)}` : ""}</span>{downloadable && <BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onDownloadExport(run.id)}>{t("coordination.panel.downloadExport")}</BusyButton>}{downloadable && <BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onDownloadExport(run.id, "xlsx")}>{t("exportsRestore.downloadXlsx")}</BusyButton>}</article>;
    })}</div></Panel>}
  </div>;
}

// REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001. A run names its dataset; older
// projections do not, so the schedule's config is the fallback.
function exportRunDataset(run, records = []) {
  if (run.dataset) return run.dataset;
  const schedule = records.find((record) => record.id === run.scheduleId);
  return schedule?.config?.dataset || "coordination_records";
}

// The server downloads a ready in-app run, and an email or SFTP run once its
// delivery has an outcome (delivered, or honestly not configured).
function exportRunDownloadable(run) {
  if (run.deliveryMode === "internal_download") return run.status === "ready";
  return ["email_unset", "sftp_unset"].includes(run.deliveryMode) && ["delivered", "not_configured"].includes(run.status);
}

function canReadExportDataset(actor, dataset) {
  if (dataset !== "members_directory") return true;
  return ["admin", "vp"].includes(actor.selectedHat) && (actor.organizationRoles || []).includes(actor.selectedHat);
}

const EXPORT_RUN_STATUS_NOTES = new Set(["queued", "delivered", "not_configured", "skipped", "failed"]);

function ChapterPanel({
  actor,
  model,
  gate,
  busy,
  onSaveChapterProfile,
  onSaveMicrositeSection,
  onSaveMicrositePage,
  onAttachPublicPageDocument,
  onTakeOverPublicPage,
  onRecommendCoverage,
}) {
  const { t } = useLang();
  const editor = model.micrositeEditor || {};
  // The ready-state projection carries the saved profile copy so the same form
  // doubles as the edit/publish control; a draft must stay reachable after the
  // create form disappears, otherwise it could never be published.
  const profile = editor.profile;
  const [profileTitleEn, setProfileTitleEn] = useState(profile?.titleEn || "");
  const [profileTitleEs, setProfileTitleEs] = useState(profile?.titleEs || "");
  const [profileSummaryEn, setProfileSummaryEn] = useState(profile?.bodyEn || "");
  const [profileSummaryEs, setProfileSummaryEs] = useState(profile?.bodyEs || "");
  const [profilePublished, setProfilePublished] = useState(Boolean(profile?.published));
  const [sectionSlug, setSectionSlug] = useState("");
  const [sectionTitleEn, setSectionTitleEn] = useState("");
  const [sectionTitleEs, setSectionTitleEs] = useState("");
  const [sectionBodyEn, setSectionBodyEn] = useState("");
  const [sectionBodyEs, setSectionBodyEs] = useState("");
  const [sectionPublished, setSectionPublished] = useState(false);
  const [pageSectionSlug, setPageSectionSlug] = useState("");
  const [pageSlug, setPageSlug] = useState("");
  const [pageTitleEn, setPageTitleEn] = useState("");
  const [pageTitleEs, setPageTitleEs] = useState("");
  const [pageBodyEn, setPageBodyEn] = useState("");
  const [pageBodyEs, setPageBodyEs] = useState("");
  const [pagePublished, setPagePublished] = useState(false);
  const [attachmentPageKey, setAttachmentPageKey] = useState("");
  const [handoffPageKey, setHandoffPageKey] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [coverage, setCoverage] = useState(null);
  const chapterCode = editor.chapterCode || actor.chapterId;
  const hasChapter = Boolean(chapterCode);
  // A failed editor read substitutes the empty 'missing' editor, which is
  // indistinguishable from a real missing profile except through
  // degradedProjections. Offering the blank create form then would let a
  // submit overwrite an existing profile whose copy could not be read, so a
  // degraded editor renders retry-only copy with no profile write control.
  const editorDegraded = (model.degradedProjections || []).includes("micrositeEditor");
  const sections = editor.sections || [];
  const pages = editor.pages || [];
  const attachmentPage = pages.find((page) => `${page.sectionSlug}/${page.slug}` === attachmentPageKey);
  const handoffPage = pages.find((page) => `${page.sectionSlug}/${page.slug}` === handoffPageKey);
  const canTakeOver = ["admin", "vp"].includes(actor.selectedHat)
    && actor.organizationRoles.includes(actor.selectedHat);
  // The form passes the updatedAt the editor projected at load so the RPC can
  // refuse a stale submit: a second editor's save after this form loaded must
  // surface as a conflict, not silently overwrite the first save. The create
  // (missing) state has no projected profile, so it says so with
  // expectedMissing and the RPC refuses a profile another editor created since.
  const profileForm = hasChapter ? <form className="coord-inline-form" onSubmit={(event) => { event.preventDefault(); onSaveChapterProfile({ chapterCode, titleEn: profileTitleEn, titleEs: profileTitleEs, bodyEn: profileSummaryEn, bodyEs: profileSummaryEs, published: profilePublished, expectedUpdatedAt: profile?.updatedAt ?? null, expectedMissing: !profile }); }}>
    <label>{t("coordination.panel.englishTitle")}<input required maxLength={120} value={profileTitleEn} onChange={(event) => setProfileTitleEn(event.target.value)} /></label>
    <label>{t("coordination.panel.spanishTitle")}<input required maxLength={120} value={profileTitleEs} onChange={(event) => setProfileTitleEs(event.target.value)} /></label>
    <label>{t("coordination.panel.englishSummary")}<textarea required maxLength={600} value={profileSummaryEn} onChange={(event) => setProfileSummaryEn(event.target.value)} /></label>
    <label>{t("coordination.panel.spanishSummary")}<textarea required maxLength={600} value={profileSummaryEs} onChange={(event) => setProfileSummaryEs(event.target.value)} /></label>
    <label className="coord-checkbox"><input type="checkbox" checked={profilePublished} onChange={(event) => setProfilePublished(event.target.checked)} />{t("coordination.panel.publishChapterProfile")}</label>
    <BusyButton className="coord-button" pending={busy}>{t("coordination.panel.saveChapterProfile")}</BusyButton>
  </form> : null;
  return <div className="coord-workflow-stack">
    {gate}
    {actor.chapterId && <Panel title={t("coordination.panel.coverageTitle")}><BusyButton className="coord-button coord-button--secondary" pending={busy} onClick={() => { Promise.resolve().then(() => onRecommendCoverage(actor.chapterId)).then(setCoverage, () => setCoverage({ state: "failed" })); }}>{t("coordination.panel.findSteward")}</BusyButton>{coverage && <CoverageResult coverage={coverage} t={t} />}</Panel>}
    {model.staff && !hasChapter && <Panel title={t("coordination.panel.chapterProfileTitle")}>
      <p className="coord-muted">{t("coordination.panel.chapterProfileNoChapter")}</p>
    </Panel>}
    {model.staff && hasChapter && editor.state === "missing" && <Panel title={t("coordination.panel.chapterProfileTitle")}>
      {editorDegraded ? <p className="coord-muted">{t("coordination.panel.chapterEditorDegraded")}</p> : <>
      <p className="coord-muted">{t("coordination.panel.chapterProfileRoot")}</p>
      {profileForm}
      </>}
    </Panel>}
    {model.staff && hasChapter && editor.state === "ready" && profile && <Panel title={t("coordination.panel.chapterProfileTitle")}>
      <p className="coord-muted">{t(profile.published ? "coordination.panel.chapterProfilePublished" : "coordination.panel.chapterProfileDraft")}</p>
      <details className="coord-disclosure" open={!profile.published}><summary>{t("coordination.panel.editChapterProfile")}</summary>{profileForm}</details>
    </Panel>}
    {model.staff && editor.state === "ready" && <Panel title={t("coordination.panel.hierarchyTitle")}>
      <details className="coord-disclosure"><summary>{t("coordination.panel.manageSections")}</summary>
        <CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.saveSection")} onSubmit={(publish) => onSaveMicrositeSection({ chapterCode, slug: sectionSlug, titleEn: sectionTitleEn, titleEs: sectionTitleEs, bodyEn: sectionBodyEn, bodyEs: sectionBodyEs, published: sectionPublished }, publish)}>
          <h4 className="coord-form-heading">{t("coordination.panel.section")}</h4>
          <label>{t("coordination.panel.sectionSlug")}<input required pattern="[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]" value={sectionSlug} onChange={(event) => setSectionSlug(event.target.value)} /></label>
          <label>{t("coordination.panel.englishTitle")}<input required maxLength={120} value={sectionTitleEn} onChange={(event) => setSectionTitleEn(event.target.value)} /></label>
          <label>{t("coordination.panel.spanishTitle")}<input required maxLength={120} value={sectionTitleEs} onChange={(event) => setSectionTitleEs(event.target.value)} /></label>
          <label>{t("coordination.panel.englishSummary")}<textarea required maxLength={2000} value={sectionBodyEn} onChange={(event) => setSectionBodyEn(event.target.value)} /></label>
          <label>{t("coordination.panel.spanishSummary")}<textarea required maxLength={2000} value={sectionBodyEs} onChange={(event) => setSectionBodyEs(event.target.value)} /></label>
          <label className="coord-checkbox"><input type="checkbox" checked={sectionPublished} onChange={(event) => setSectionPublished(event.target.checked)} />{t("coordination.panel.publishSection")}</label>
        </CoordinationForm>
        {sections.length > 0 && <CoordinationForm className="coord-inline-form" busy={busy} submitLabel={t("coordination.panel.savePage")} onSubmit={(publish) => onSaveMicrositePage({ chapterCode, sectionSlug: pageSectionSlug, slug: pageSlug, titleEn: pageTitleEn, titleEs: pageTitleEs, bodyEn: pageBodyEn, bodyEs: pageBodyEs, published: pagePublished }, publish)}>
          <h4 className="coord-form-heading">{t("coordination.panel.page")}</h4>
          <label>{t("coordination.panel.section")}<select required value={pageSectionSlug} onChange={(event) => setPageSectionSlug(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{sections.map((section) => <option key={section.slug} value={section.slug}>{section.titleEn}</option>)}</select></label>
          <label>{t("coordination.panel.pageSlug")}<input required pattern="[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]" value={pageSlug} onChange={(event) => setPageSlug(event.target.value)} /></label>
          <label>{t("coordination.panel.englishTitle")}<input required maxLength={120} value={pageTitleEn} onChange={(event) => setPageTitleEn(event.target.value)} /></label>
          <label>{t("coordination.panel.spanishTitle")}<input required maxLength={120} value={pageTitleEs} onChange={(event) => setPageTitleEs(event.target.value)} /></label>
          <label>{t("coordination.panel.englishBody")}<textarea required maxLength={10000} value={pageBodyEn} onChange={(event) => setPageBodyEn(event.target.value)} /></label>
          <label>{t("coordination.panel.spanishBody")}<textarea required maxLength={10000} value={pageBodyEs} onChange={(event) => setPageBodyEs(event.target.value)} /></label>
          <label className="coord-checkbox"><input type="checkbox" checked={pagePublished} onChange={(event) => setPagePublished(event.target.checked)} />{t("coordination.panel.publishPage")}</label>
        </CoordinationForm>}
      </details>
    </Panel>}
    {model.staff && pages.length > 0 && <Panel title={t("coordination.panel.attachmentsTitle")}><CoordinationForm className="coord-inline-form" busy={busy} disabled={!attachmentPage} submitLabel={t("coordination.panel.attachDocument")} onSubmit={(publish) => { if (!attachmentPage) return; return onAttachPublicPageDocument({ chapterCode, sectionSlug: attachmentPage.sectionSlug, pageSlug: attachmentPage.slug, documentId, label }, publish); }}><label>{t("coordination.panel.page")}<select required value={attachmentPageKey} onChange={(event) => setAttachmentPageKey(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{pages.map((page) => <option value={`${page.sectionSlug}/${page.slug}`} key={`${page.sectionSlug}/${page.slug}`}>{page.titleEn}</option>)}</select></label><label>{t("coordination.panel.publishedDocumentId")}<input required value={documentId} onChange={(event) => setDocumentId(event.target.value)} /></label><label>{t("coordination.panel.publicLabel")}<input required minLength={2} maxLength={160} value={label} onChange={(event) => setLabel(event.target.value)} /></label></CoordinationForm>{(editor.attachments || []).length > 0 && <div className="coord-list">{editor.attachments.map((attachment) => <article className="coord-list__row" key={attachment.id}><strong>{attachment.label}</strong><span>{attachment.sectionSlug}/{attachment.pageSlug}</span></article>)}</div>}</Panel>}
    {model.staff && canTakeOver && pages.length > 0 && <Panel title={t("coordination.panel.takeoverTitle")}><CoordinationForm className="coord-inline-form" busy={busy} disabled={!handoffPage} submitLabel={t("coordination.panel.takeOverPage")} onSubmit={(publish) => { if (!handoffPage) return; return onTakeOverPublicPage({ chapterCode, sectionSlug: handoffPage.sectionSlug, pageSlug: handoffPage.slug, reason }, publish); }}><label>{t("coordination.panel.page")}<select required value={handoffPageKey} onChange={(event) => setHandoffPageKey(event.target.value)}><option value="">{t("coordination.panel.choose")}</option>{pages.map((page) => <option value={`${page.sectionSlug}/${page.slug}`} key={`${page.sectionSlug}/${page.slug}`}>{page.titleEn}</option>)}</select></label><label>{t("coordination.panel.auditedReason")}<textarea required minLength={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label></CoordinationForm></Panel>}
  </div>;
}

// Every tab carries the same explicit request control until the projection is
// loaded, and the loaded data then survives every tab switch without asking
// again. TAB_EXTENSION_FIELDS above is the honest per-tab map of what the
// projection renders: missions badges + recentActivity, network directory,
// coalitions invitations, operations mergeJobs (not mergeMatches — no surface
// reads it), mobilize mobilizationProgress, and chapter nothing. Once it has
// answered, a tab with nothing of its own says so instead of going blank.
export function CoordinationWorkflowPanels({
  tab,
  actor,
  model,
  extensions = EMPTY_COORDINATION_EXTENSIONS,
  onShowDirectoryExtensions = null,
  onRetryScope = null,
  busy,
  pagingMessages,
  actions,
}) {
  const { t } = useLang();
  if (!COORDINATION_TABS.some((item) => item.id === tab)) return null;
  const extensionsReady = extensions.state === "ready";
  // `empty` is the backend answering with nothing, which is an answer: it must
  // not re-offer the request control, and it must not go silent either.
  const extensionsAnswered = extensionsReady || extensions.state === "empty";
  const merged = { ...model, ...coordinationExtensionFields(extensions) };
  // Whether the request control is on screen: only then may the profile panel
  // point at it. A refusal or an unconfirmed load removes it, and its own panel
  // already says what to do, so the profile panel stays out of the way.
  const extensionsFailure = extensionsAnswered ? null : directoryFailure(extensions.state);
  const extensionsRequestable = !extensionsAnswered && Boolean(onShowDirectoryExtensions)
    && (!extensionsFailure || extensionsFailure.retry);
  // An answered load always leaves the line: it is the acknowledgement AND the
  // focus anchor for the transition that removes the request control, so the two
  // successful outcomes no longer drop a keyboard or screen-reader operator on
  // <body>. Which sentence it carries depends on whether this tab renders any of
  // the projection's own fields.
  const gate = extensionsAnswered
    ? <DirectoryExtensionsAcknowledged
      state={extensions.state}
      rendered={extensionsReady && extensionsRenderedOnTab(tab, extensions)}
      stale={Boolean(extensions.stale)}
    />
    : <DirectoryExtensionsRequest
      state={extensions.state}
      busy={busy}
      onShow={onShowDirectoryExtensions}
      onRetryScope={onRetryScope}
      sessionScope={normalizeCoordinationActor(actor).sessionScope}
    />;
  if (tab === "missions") return <div className="coord-workflow-stack">{gate}{(merged.badges || []).length > 0 && <Panel title={t("coordination.panel.missionBadges")}><div className="coord-list">{merged.badges.map((badge, index) => <article className="coord-list__row" key={`${badge.missionId}-${badge.alias}-${badge.badge}-${index}`}><strong>{badge.alias}</strong><span>{badge.badge}</span></article>)}</div></Panel>}{(merged.recentActivity || []).length > 0 && <Panel title={t("coordination.panel.missionActivity")}><div className="coord-list">{merged.recentActivity.slice(0, 12).map((item, index) => <article className="coord-list__row" key={`${item.recordId}-${item.createdAt}-${index}`}><strong>{item.type.replaceAll("_", " ")}</strong><span>{item.pointsDelta ? t("coordination.panel.missionPoints", { count: item.pointsDelta }) : item.toStatus || t("coordination.panel.missionRecorded")}</span></article>)}</div></Panel>}</div>;
  if (tab === "network") return <NetworkPanel actor={actor} model={merged} gate={gate} extensionsReady={extensionsReady} extensionsAnswered={extensionsAnswered} extensionsRequestable={extensionsRequestable} busy={busy} pagingMessages={pagingMessages} {...actions} />;
  if (tab === "coalitions") return <CoalitionPanel actor={actor} model={merged} gate={gate} busy={busy} {...actions} />;
  if (tab === "operations") return <OperationsPanel actor={actor} model={merged} gate={gate} busy={busy} {...actions} />;
  // Keying on chapter identity + editor state + saved profile stamp remounts
  // the panel when staff switch missing chapters or after a create save flips
  // the editor to ready, so typed copy cannot follow a different chapter id.
  if (tab === "chapter") {
    const editorState = (merged.micrositeEditor || {}).state || "idle";
    const chapterIdentity = merged.micrositeEditor?.chapterCode || actor.chapterId || "none";
    const profileStamp = editorState === "ready" && merged.micrositeEditor.profile?.updatedAt
      ? `-${merged.micrositeEditor.profile.updatedAt}` : "";
    return <ChapterPanel key={`chapter-${chapterIdentity}-${editorState}${profileStamp}`} actor={actor} model={merged} gate={gate} busy={busy} {...actions} />;
  }
  if (tab === "mobilize") return <div className="coord-workflow-stack">{gate}{(merged.mobilizationProgress || []).length > 0 && <Panel title={t("coordination.panel.mobilizationTitle")}><div className="coord-list">{merged.mobilizationProgress.map((campaign) => <article className="coord-list__row" key={campaign.campaignId}><strong>{campaign.title}</strong><span>{t("coordination.panel.mobilizationCounts", { reached: campaign.reached, committed: campaign.committed, attended: campaign.attended })}</span></article>)}</div></Panel>}</div>;
  // Unreachable: the COORDINATION_TABS guard at the top already rejected any id
  // that is not one of the six branches above. It is spelled out so adding a tab
  // to the contract without a panel renders nothing rather than silently falling
  // into the mobilize surface with another tab's records.
  return null;
}
