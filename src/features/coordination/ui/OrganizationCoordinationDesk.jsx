import { useRoutedTab, RoutedTabLink, useWorkspace } from "../../../components/WorkspacePages.jsx";
import { useMemo, useState } from "react";
import { useLang } from "../../../lib/LanguageContext.jsx";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { EmptyState, StateBlock } from "../../../components/Primitives.jsx";
import { PageHeader } from "../../../components/PageHeader.jsx";
import { zonedDateTimeInputToIso } from "../../../lib/localDateTime.js";
import {
  canManageCoordination,
  canPerformCoordinationIntent,
  networkLinksForCapability,
  NETWORK_CHILD_CAPABILITY,
  recordsForTab,
  visibleCoordinationTabs,
} from "../authorization.js";
import { COORDINATION_KINDS, COORDINATION_STAFF_HATS, EMPTY_COORDINATION_EXTENSIONS } from "../contract.js";
import { CoordinationWorkflowPanels } from "./CoordinationWorkflowPanels.jsx";
import { CoordinationForm } from "./CoordinationForm.jsx";
import { StaffAuthoringHint } from "../../../components/StaffAuthoringHint.jsx";
import "./organizationCoordination.css";

// UX-UG-COORDINATION-DESK-BODY-ENGLISH-ONLY-20260920: kind badges, record
// statuses and tab names read the catalogue; an unknown value falls back to
// the raw token rather than a missing-key string.
function catalogueLabel(t, key, fallback) {
  const label = t(key);
  return label === key ? fallback : label;
}

function kindLabel(t, kind) {
  return catalogueLabel(t, `coordination.kind.${kind}`, kind);
}

function recordStatusLabel(t, status) {
  return catalogueLabel(t, `coordination.recordStatus.${status}`, String(status || "").replaceAll("_", " "));
}

function tabLabelFor(t, tab) {
  return catalogueLabel(t, `coordination.tab.${tab.id}`, tab.label);
}

function CoordinationState({ title, body, action = null, embedded = false, announce = false }) {
  const workspace = useWorkspace();
  const Heading = workspace && !embedded ? "h1" : "h2";
  return (
    <EmptyState>
      <div className="coord-state-copy" role={announce ? "alert" : undefined}>
        <Heading>{title}</Heading>
        <p>{body}</p>
        {action}
      </div>
    </EmptyState>
  );
}

function RecordCard({ actor, record, staff, busy, onJoin, onTransition, onRespond, onRunExport }) {
  const { t } = useLang();
  // The export RPC narrows to coordinator/admin/vp even though canManageCoordination
  // admits every staff hat, so this one control reads the intent table instead of
  // the desk-wide `staff` flag the other card actions use.
  const canRunExport = canPerformCoordinationIntent(actor, "runExport");
  const invitation = staff
    && record.status === "requested"
    && record.partnerOrganizationId === actor.selectedOrganizationId;
  const governedByCoalitionVote = record.kind === "coalition_work_item";
  const owned = record.organizationId === actor.selectedOrganizationId;
  return (
    <article className="coord-card">
      <div className="coord-card__head">
        <span className="coord-badge">{kindLabel(t, record.kind)}</span>
        <span className="coord-status">{recordStatusLabel(t, record.status)}</span>
      </div>
      <h3>{record.title}</h3>
      {record.summary && <p>{record.summary}</p>}
      {/* A coalition work item deliberately offers no unilateral control: the
          card below suppresses Activate and Complete for this kind. Say so on
          the card, so the empty action row reads as a governance rule and not
          as a missing permission or a broken record. */}
      {governedByCoalitionVote && ["draft", "paused"].includes(record.status) && (
        <p className="coord-muted">{t("coordination.coalitionVoteGoverned")}</p>
      )}
      <div className="coord-card__actions">
        {["mission", "committee", "network_conversation", "coalition_campaign"].includes(record.kind) && ["active", "invited"].includes(record.status) && (
          <BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onJoin(record)}>
            {t("coordination.cardJoin")}
          </BusyButton>
        )}
        {record.kind === "network_export_schedule" && canRunExport && record.status === "active" && (
          <BusyButton type="button" className="coord-button" pending={busy} onClick={() => onRunExport(record)}>
            {t("coordination.cardRunExport")}
          </BusyButton>
        )}
        {record.kind === "mission_objective" && record.status === "active" && record.completedByCaller && (
          <button type="button" className="coord-button" disabled>
            {t("coordination.objectiveCompleted")}
          </button>
        )}
        {record.kind === "mission_objective" && record.status === "active" && !record.completedByCaller && (
          <BusyButton type="button" className="coord-button" pending={busy} onClick={() => onTransition(record, "complete_objective", { points: Number(record.config?.points || 10) })}>
            {t("coordination.completeObjective")}
          </BusyButton>
        )}
        {staff && owned && !governedByCoalitionVote && ["draft", "paused"].includes(record.status) && (
          <BusyButton type="button" className="coord-button" pending={busy} onClick={() => onTransition(record, record.kind === "microsite_page" ? "publish" : "activate")}>{record.kind === "microsite_page" ? t("coordination.cardPublish") : t("coordination.cardActivate")}</BusyButton>
        )}
        {staff && owned && !governedByCoalitionVote && record.kind !== "mission_objective" && record.status === "active" && (
          <BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onTransition(record, "complete")}>{t("coordination.cardComplete")}</BusyButton>
        )}
        {invitation && (
          <>
            <BusyButton type="button" className="coord-button" pending={busy} onClick={() => onRespond(record, true)}>{t("coordination.cardAccept")}</BusyButton>
            <BusyButton type="button" className="coord-button coord-button--secondary" pending={busy} onClick={() => onRespond(record, false)}>{t("coordination.cardDecline")}</BusyButton>
          </>
        )}
      </div>
    </article>
  );
}

function timeValueToMinutes(value) {
  const [hours, minutes] = String(value || "0:00").split(":").map((part) => parseInt(part, 10) || 0);
  return hours * 60 + minutes;
}

function coverageEndMinuteFromForm(timeValue, endsEndOfDay) {
  if (endsEndOfDay) return 1440;
  const minutes = timeValueToMinutes(timeValue);
  // type="time" cannot express 24:00; midnight on the end field is end-of-day.
  return minutes === 0 ? 1440 : minutes;
}

// REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001: the old agency-exports
// datasets. They are offered only while the organization switch is on (the
// server refuses them otherwise), and the directory only to admin/vp hats,
// matching the server's role check.
const EXPORT_DATASETS = Object.freeze([
  "coordination_records", "members_directory", "events", "resources", "knowledge_articles", "broadcast_log",
]);

function exportDatasetsFor(actor, datasetExportsEnabled) {
  if (!datasetExportsEnabled) return ["coordination_records"];
  const directory = ["admin", "vp"].includes(actor?.selectedHat) && (actor?.organizationRoles || []).includes(actor.selectedHat);
  return EXPORT_DATASETS.filter((dataset) => dataset !== "members_directory" || directory);
}

function Creator({ tab, actor, records, networkGrants = null, busy, onCreate, datasetExportsEnabled = false }) {
  const { t } = useLang();
  const kinds = (visibleCoordinationTabs(actor).find((item) => item.id === tab)?.kinds || [])
    .filter((value) => value !== "microsite_page");
  const [kind, setKind] = useState(kinds[0] || "mission");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [partner, setPartner] = useState("");
  const [chapter, setChapter] = useState(actor.chapterId || "");
  const [parent, setParent] = useState("");
  const [handshakeId, setHandshakeId] = useState("");
  const [stewardUserId, setStewardUserId] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [coverageStartTime, setCoverageStartTime] = useState("09:00");
  const [coverageEndTime, setCoverageEndTime] = useState("17:00");
  const [coverageTimezone, setCoverageTimezone] = useState("America/New_York");
  const [coverageEndsEndOfDay, setCoverageEndsEndOfDay] = useState(false);
  const [overrideStartsAt, setOverrideStartsAt] = useState("");
  const [overrideEndsAt, setOverrideEndsAt] = useState("");
  const [exportCadence, setExportCadence] = useState("weekly");
  const [exportFormat, setExportFormat] = useState("csv");
  const [exportNextRunAt, setExportNextRunAt] = useState("");
  const [exportDataset, setExportDataset] = useState("coordination_records");
  const [exportDelivery, setExportDelivery] = useState("internal_download");
  const datasetOptions = exportDatasetsFor(actor, datasetExportsEnabled);
  const chosenDataset = datasetOptions.includes(exportDataset) ? exportDataset : "coordination_records";
  const [zoneError, setZoneError] = useState("");
  // Coverage windows, overrides and export first runs all read their times in
  // this one named zone, never the browser's.
  const zoned = ["coverage_schedule", "coverage_override", "network_export_schedule"].includes(kind);
  const needsPartner = ["network_link", "coalition", "merger_plan"].includes(kind);
  const needsChapter = ["handshake_workspace_item", "coverage_schedule", "coverage_override", "committee"].includes(kind);
  const parentKind = {
    mission_objective: "mission",
    network_conversation: "network_link",
    network_request: "network_link",
    coalition_campaign: "coalition",
    coalition_work_item: "coalition_campaign",
    mobilization_cohort: "mobilization_campaign",
  }[kind] || null;
  // A network child is the one parent choice the server tests twice: the link
  // must still be `active`, and the two organizations must hold the grant that
  // kind of work needs. Offering a parent that fails either one only produced a
  // refusal after the operator had filled the whole form in.
  const parentOptions = parentKind === "network_link"
    ? networkLinksForCapability(records, NETWORK_CHILD_CAPABILITY[kind], networkGrants)
    : records.filter((record) => record.kind === parentKind);
  // Selecting a parent and then changing the workflow can strand a choice the
  // new kind does not admit, so the selection is derived rather than trusted:
  // an option that is no longer offered is not submitted either.
  const selectedParent = parentOptions.some((record) => record.id === parent) ? parent : "";

  return (
    <CoordinationForm className="coord-form" busy={busy}
      submitLabel={t("coordination.creatorCreate")} busyLabel={t("coordination.creatorSaving")}
      disabled={!COORDINATION_KINDS.includes(kind)}
      onSaved={() => { setTitle(""); setSummary(""); }}
      onSubmit={(publish) => {
        const coverageStartMinute = timeValueToMinutes(coverageStartTime);
        const coverageEndMinute = coverageEndMinuteFromForm(coverageEndTime, coverageEndsEndOfDay);
        const zone = coverageTimezone.trim();
        const zonedIso = (value) => zonedDateTimeInputToIso(value, zone);
        if ((kind === "coverage_override" && (!zonedIso(overrideStartsAt) || !zonedIso(overrideEndsAt)))
          || (kind === "network_export_schedule" && !zonedIso(exportNextRunAt))) {
          setZoneError(t("coordination.creatorZoneError"));
          return;
        }
        setZoneError("");
        const config = kind === "handshake_workspace_item" ? { handshakeId }
          : kind === "mission" ? { targetPoints: 100 }
            : kind === "mission_objective" ? { points: 10 }
            : kind === "coverage_schedule" ? {
              stewardUserId,
              dayOfWeek: Number(dayOfWeek),
              startMinute: coverageStartMinute,
              endMinute: coverageEndMinute,
              timezone: zone,
            }
              : kind === "coverage_override" ? {
                stewardUserId,
                startsAt: zonedIso(overrideStartsAt),
                endsAt: zonedIso(overrideEndsAt),
                available: true,
              }
                : kind === "network_export_schedule" ? {
                  cadence: exportCadence,
                  format: exportFormat,
                  deliveryMode: exportDelivery,
                  nextRunAt: zonedIso(exportNextRunAt),
                  ...(chosenDataset === "coordination_records" ? {} : { dataset: chosenDataset }),
                }
              : {};
        return onCreate({
          kind, title, summary,
          visibility: ["mission", "mission_objective", "committee"].includes(kind)
            ? "members"
            : ["network_conversation", "coalition", "coalition_campaign", "coalition_work_item"].includes(kind)
              ? "participants"
              : "staff",
          partnerOrganizationId: partner || null,
          chapterId: chapter || null,
          parentId: selectedParent || null,
          config,
        }, publish);
      }}>
      <h3>{t("coordination.creatorTitle")}</h3>
      <label>{t("coordination.creatorWorkflow")}
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          {kinds.map((value) => <option value={value} key={value}>{kindLabel(t, value)}</option>)}
        </select>
      </label>
      <label>{t("coordination.creatorTitleField")}
        <input required minLength={2} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>{t("coordination.creatorDetails")}
        <textarea maxLength={4000} rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>
      {needsPartner && <label>{t("coordination.creatorPartner")}
        <input required inputMode="text" value={partner} onChange={(event) => setPartner(event.target.value)} />
      </label>}
      {needsChapter && <label>{t("coordination.creatorChapter")}
        <input required value={chapter} onChange={(event) => setChapter(event.target.value)} />
      </label>}
      {kind === "handshake_workspace_item" && <label>{t("coordination.creatorHandshake")}
        <input required value={handshakeId} onChange={(event) => setHandshakeId(event.target.value)} />
      </label>}
      {["coverage_schedule", "coverage_override"].includes(kind) && <label>{t("coordination.creatorSteward")}
        <input required value={stewardUserId} onChange={(event) => setStewardUserId(event.target.value)} />
      </label>}
      {kind === "coverage_schedule" && <div className="coord-form__split">
        <label>{t("coordination.creatorDay")}<input required type="number" min="0" max="6" value={dayOfWeek} onChange={(event) => setDayOfWeek(event.target.value)} /></label>
        <label>{t("coordination.creatorStartTime")}<input required type="time" step="60" value={coverageStartTime} onChange={(event) => setCoverageStartTime(event.target.value)} /></label>
        <label>{t("coordination.creatorEndTime")}<input required type="time" step="60" value={coverageEndTime} disabled={coverageEndsEndOfDay} onChange={(event) => setCoverageEndTime(event.target.value)} /></label>
      </div>}
      {zoned && <>
        <label>{kind === "coverage_schedule" ? t("coordination.creatorZoneStored") : t("coordination.creatorZoneEntered")}
          {/* Free text on purpose: any IANA name is legal and the server
              validates against pg_timezone_names, so the field cannot drift
              from what Postgres accepts. Mirrors StewardAppointmentsPanel. */}
          <input required value={coverageTimezone} placeholder="America/New_York" onChange={(event) => setCoverageTimezone(event.target.value)} />
        </label>
        <p className="coord-form__note">{t(kind === "coverage_schedule" ? "coordination.creatorZoneStoredNote" : "coordination.creatorZoneEnteredNote", { zone: coverageTimezone.trim() || t("coordination.creatorZoneUnnamed") })}</p>
        {zoneError && <p className="coord-form__note" role="alert">{zoneError}</p>}
      </>}
      {kind === "coverage_schedule" && <>
        <label className="coord-form__endofday">
          <input type="checkbox" checked={coverageEndsEndOfDay} onChange={(event) => setCoverageEndsEndOfDay(event.target.checked)} />
          {t("coordination.creatorEndOfDay")}
        </label>
      </>}
      {kind === "coverage_override" && <div className="coord-form__split">
        <label>{t("coordination.creatorStarts")}<input required type="datetime-local" value={overrideStartsAt} onChange={(event) => setOverrideStartsAt(event.target.value)} /></label>
        <label>{t("coordination.creatorEnds")}<input required type="datetime-local" value={overrideEndsAt} onChange={(event) => setOverrideEndsAt(event.target.value)} /></label>
      </div>}
      {kind === "network_export_schedule" && <div className="coord-form__split">
        <label>{t("coordination.creatorCadence")}<select value={exportCadence} onChange={(event) => setExportCadence(event.target.value)}><option value="daily">{t("coordination.creatorCadenceDaily")}</option><option value="weekly">{t("coordination.creatorCadenceWeekly")}</option><option value="monthly">{t("coordination.creatorCadenceMonthly")}</option></select></label>
        <label>{t("coordination.creatorFormat")}<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}><option value="csv">CSV</option><option value="json">JSON</option></select></label>
        <label>{t("coordination.creatorFirstRun")}<input required type="datetime-local" value={exportNextRunAt} onChange={(event) => setExportNextRunAt(event.target.value)} /></label>
        <label>{t("exportsRestore.dataset")}<select value={chosenDataset} onChange={(event) => setExportDataset(event.target.value)}>{datasetOptions.map((dataset) => <option key={dataset} value={dataset}>{t(`exportsRestore.dataset.${dataset}`)}</option>)}</select></label>
        <label>{t("exportsRestore.delivery")}<select value={exportDelivery} onChange={(event) => setExportDelivery(event.target.value)}><option value="internal_download">{t("exportsRestore.delivery.internal_download")}</option><option value="email_unset">{t("exportsRestore.delivery.email_unset")}</option></select></label>
      </div>}
      {kind === "network_export_schedule" && !datasetExportsEnabled && <p className="coord-form__note">{t("exportsRestore.datasetsOff")}</p>}
      {kind === "network_export_schedule" && <p className="coord-form__note">{t("exportsRestore.deliveryNote")}</p>}
      {parentKind === "network_link" && parentOptions.length === 0 ? (
        <p className="coord-muted">{t("coordination.creatorNoNetworkParent")}</p>
      ) : parentKind && (
        <label>{t("coordination.creatorParent")}
          <select required value={selectedParent} onChange={(event) => setParent(event.target.value)}>
            <option value="">{t("coordination.creatorChooseParent")}</option>
            {parentOptions.map((record) => <option value={record.id} key={record.id}>{record.title}</option>)}
          </select>
        </label>
      )}
    </CoordinationForm>
  );
}

function MessageComposer({ conversations, busy, onMessage }) {
  const { t } = useLang();
  const [conversationId, setConversationId] = useState("");
  const [body, setBody] = useState("");
  if (!conversations.length) return null;
  return (
    <CoordinationForm className="coord-form coord-form--compact" busy={busy}
      submitLabel={t("coordination.messageSend")} onSaved={() => setBody("")}
      onSubmit={(publish) => onMessage(conversationId, body, publish)}>
      <h3>{t("coordination.messageTitle")}</h3>
      <label>{t("coordination.messageConversation")}
        <select required value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
          <option value="">{t("coordination.messageChooseConversation")}</option>
          {conversations.map((record) => <option value={record.id} key={record.id}>{record.title}</option>)}
        </select>
      </label>
      <label>{t("coordination.messageBody")}
        <textarea required maxLength={4000} rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
    </CoordinationForm>
  );
}

function OutreachComposer({ campaigns, busy, onOutreach }) {
  const { t } = useLang();
  const [campaignId, setCampaignId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [disposition, setDisposition] = useState("attempted");
  const [note, setNote] = useState("");
  if (!campaigns.length) return null;
  return (
    <CoordinationForm className="coord-form coord-form--compact" busy={busy}
      submitLabel={t("coordination.outreachRecord")} onSaved={() => { setTargetUserId(""); setNote(""); }}
      onSubmit={(publish) => onOutreach({ campaignId, targetUserId, disposition, note }, publish)}>
      <h3>{t("coordination.outreachTitle")}</h3>
      <label>{t("coordination.outreachCampaign")}<select required value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
        <option value="">{t("coordination.outreachChooseCampaign")}</option>
        {campaigns.map((record) => <option value={record.id} key={record.id}>{record.title}</option>)}
      </select></label>
      <label>{t("coordination.outreachMember")}<input required value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} /></label>
      <label>{t("coordination.outreachDisposition")}<select value={disposition} onChange={(event) => setDisposition(event.target.value)}>
        {['attempted','reached','follow_up','committed','declined','attended'].map((value) => <option key={value} value={value}>{t(`coordination.outreachDisposition.${value}`)}</option>)}
      </select></label>
      <label>{t("coordination.outreachNote")}<textarea maxLength={1000} rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    </CoordinationForm>
  );
}

export function OrganizationCoordinationDesk({
  actor,
  model,
  extensions = EMPTY_COORDINATION_EXTENSIONS,
  onShowDirectoryExtensions = null,
  onRetryScope = null,
  status,
  busy = false,
  paging = false,
  pagingMessages = false,
  notice = "",
  stale = false,
  onRetry,
  onLoadMore,
  onLoadMoreMessages,
  onCreate,
  onJoin,
  onTransition,
  onRespond,
  onMessage,
  onRunExport,
  onDownloadExport,
  onOutreach,
  onSaveProfile,
  onSetPermission,
  onResource,
  onRespondResource,
  onOpenSharedDocument,
  onInviteOrganization,
  onRespondParticipant,
  onAssignParticipant,
  onProposeCoalitionDecision,
  onVoteCoalitionDecision,
  onReviewMergeMatch,
  onExecuteMerge,
  onSaveChapterProfile,
  onSaveMicrositeSection,
  onSaveMicrositePage,
  onAttachPublicPageDocument,
  onTakeOverPublicPage,
  onRecommendCoverage,
  datasetExportsEnabled = false,
}) {
  const { t } = useLang();
  const tabs = visibleCoordinationTabs(actor);
  const degraded = model?.degradedProjections || [];
  const [tab, setTab] = useRoutedTab("coordination", "missions");
  const currentTab = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id || "missions";
  const records = recordsForTab(model, currentTab);
  const staff = canManageCoordination(actor);
  const conversations = (model?.records || []).filter((record) => ["network_conversation", "coalition_campaign"].includes(record.kind) && record.status === "active");
  const campaigns = (model?.records || []).filter((record) => record.kind === "mobilization_campaign" && ["active", "paused"].includes(record.status));
  // The grant rows live on the deferred projection only — the mount snapshot
  // carries none — so anything but a ready load is UNKNOWN, not "no grants",
  // and the creator keeps offering every active link rather than claiming a
  // partner withheld a capability nobody has asked the server about.
  const networkGrants = extensions?.state === "ready" ? (extensions.permissions || []) : null;
  const tabLabel = useMemo(() => {
    const current = tabs.find((item) => item.id === currentTab);
    return current ? tabLabelFor(t, current) : t("coordination.tabFallback");
  }, [currentTab, tabs, t]);
  const handleTabKeyDown = (event, index) => {
    let nextIndex = null;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (index + 1) % tabs.length;
    if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(tabs[nextIndex].id);
    event.currentTarget.parentElement?.children[nextIndex]?.focus();
  };

  const staffDestination = COORDINATION_STAFF_HATS.includes(actor?.selectedHat);
  const memberDestination = actor?.selectedHat === "member";
  const namedDestination = staffDestination || memberDestination;
  let statePanel = null;
  if (status === "loading") {
    statePanel = <div className="coord-state" role="status">{t("coordination.deskLoading")}</div>;
  } else if (["unavailable", "error"].includes(status)) {
    statePanel = <CoordinationState embedded={namedDestination} announce title={t("coordination.stateUnavailableTitle")} body={t("coordination.stateUnavailableBody")} action={onRetry ? <button type="button" className="coord-button" onClick={onRetry}>{t("coordination.stateRetry")}</button> : null} />;
  } else if (status === "mfa_required") {
    statePanel = <CoordinationState embedded={namedDestination} title={t("coordination.stateMfaTitle")} body={t("coordination.stateMfaBody")} />;
  } else if (status === "unauthorized") {
    statePanel = <CoordinationState embedded={namedDestination} title={t("coordination.stateUnauthorizedTitle")} body={t("coordination.stateUnauthorizedBody")} />;
  } else if (status === "empty" || !model?.organizationId) {
    statePanel = memberDestination
      ? <StateBlock title={t("coordination.stateEmptyTitle")} body={t("coordination.stateEmptyBody")} />
      : <CoordinationState embedded={namedDestination} title={t("coordination.stateEmptyTitle")} body={t("coordination.stateEmptyBody")} />;
  }
  if (statePanel && !namedDestination) return statePanel;

  const stateClass = memberDestination ? "member-empty-page" : undefined;
  return (
    <section className={statePanel ? stateClass : "coord-desk"} aria-labelledby="coordination-title">
      {memberDestination ? (
        <PageHeader
          title={t("nav.network")}
          titleId="coordination-title"
          className={statePanel ? undefined : "coord-header"}
          eyebrow={statePanel ? undefined : t("coordination.deskTitle")}
          purpose={statePanel ? undefined : t("coordination.deskIntro")}
          action={statePanel ? null : <span className="coord-scope">{t("coordination.deskScopeMember")}</span>}
        />
      ) : (
        <header className={statePanel ? "phead" : "coord-header"}>
          <div>
            {!statePanel && <p className="coord-eyebrow">{t(staffDestination ? "coordination.deskTitle" : "coordination.deskEyebrow")}</p>}
            <h1 id="coordination-title">{t(staffDestination ? "nav.coordination" : "coordination.deskTitle")}</h1>
            {!statePanel && <p>{t("coordination.deskIntro")}</p>}
          </div>
          {!statePanel && <span className="coord-scope">{staff ? t("coordination.deskScopeStaff") : t("coordination.deskScopeMember")}</span>}
        </header>
      )}
      {statePanel ?? <>
        {notice && <p className="coord-notice" role="status">{notice}</p>}
        {/* A staff addition that did not answer says so HERE, inside the ready
            desk, and names itself. It is deliberately not a .coord-state panel:
            the records, messages and tabs below are real and current, and the
            whole-page unavailable copy would be a false claim about them. */}
        {/* A same-scope refresh that timed out or failed keeps the last ready desk
            and says so here, with a retry, instead of replacing the whole page. */}
        {stale && <p className="coord-notice coord-notice--degraded coord-notice--stale" role="status">
          {t("coordination.deskStale")}
          {onRetry && <button type="button" className="coord-button coord-button--secondary" onClick={onRetry}>{t("coordination.deskStaleRetry")}</button>}
        </p>}
        {degraded.length > 0 && <p className="coord-notice coord-notice--degraded" role="status">
          {t("coordination.staffProjectionDegraded", { fields: degraded.map((field) => t(`coordination.staffProjection${field[0].toUpperCase()}${field.slice(1)}`)).join(", ") })}
          {onRetry && <button type="button" className="coord-button coord-button--secondary" onClick={onRetry}>{t("coordination.staffProjectionRetry")}</button>}
        </p>}
        <div className="coord-tabs" role="tablist" aria-label={t("coordination.tabsLabel")}>
          {tabs.map((item, index) => {
            const selected = currentTab === item.id;
            return <RoutedTabLink group="coordination" value={item.id} key={item.id} id={`coord-tab-${item.id}`} aria-controls={`coord-panel-${item.id}`} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} className={selected ? "is-selected" : ""} onClick={() => setTab(item.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{tabLabelFor(t, item)}</RoutedTabLink>;
          })}
        </div>
        <div className="coord-layout">
          <div id={`coord-panel-${currentTab}`} className="coord-main" role="tabpanel" aria-labelledby={`coord-tab-${currentTab}`}>
            <div className="coord-section-head"><h2>{tabLabel}</h2><span>{t(`coordination.recordCount.${records.length === 1 ? "one" : "other"}`, { count: records.length })}</span></div>
            {records.length ? <div className="coord-grid">{records.map((record) => <RecordCard key={record.id} actor={actor} record={record} staff={staff} busy={busy} onJoin={onJoin} onTransition={onTransition} onRespond={onRespond} onRunExport={onRunExport} />)}</div> : <CoordinationState embedded title={t("coordination.emptyTabTitle", { tab: tabLabel })} body={t("coordination.emptyTabBody")} action={staff ? null : <StaffAuthoringHint item="coordination" buttonClassName="coord-button coord-button--secondary" />} />}
            {model?.nextRecordsCursor && onLoadMore && <div className="coord-page-actions"><BusyButton type="button" className="coord-button coord-button--secondary" pending={paging} onClick={onLoadMore}>{paging ? t("coordination.loadingOlder") : t("coordination.loadOlder")}</BusyButton></div>}
            {currentTab === "network" && <MessageComposer conversations={conversations} busy={busy} onMessage={onMessage} />}
            {currentTab === "mobilize" && canPerformCoordinationIntent(actor, "outreach") && <OutreachComposer campaigns={campaigns} busy={busy} onOutreach={onOutreach} />}
            <CoordinationWorkflowPanels
              tab={currentTab}
              actor={actor}
              model={model}
              extensions={extensions}
              onShowDirectoryExtensions={onShowDirectoryExtensions}
              onRetryScope={onRetryScope}
              busy={busy}
              pagingMessages={pagingMessages}
              actions={{
                onSaveProfile,
                onSetPermission,
                onResource,
                onRespondResource,
                onOpenSharedDocument,
                onInviteOrganization,
                onRespondParticipant,
                onAssignParticipant,
                onProposeCoalitionDecision,
                onVoteCoalitionDecision,
                onReviewMergeMatch,
                onExecuteMerge,
                onSaveChapterProfile,
                onSaveMicrositeSection,
                onSaveMicrositePage,
                onAttachPublicPageDocument,
                onTakeOverPublicPage,
                onRecommendCoverage,
                onLoadMoreMessages,
                onDownloadExport,
              }}
            />
          </div>
          {staff && <aside className="coord-aside" aria-label={t("coordination.creatorLabel")}><Creator key={currentTab} tab={currentTab} actor={actor} records={model?.records || []} networkGrants={networkGrants} busy={busy} onCreate={onCreate} datasetExportsEnabled={datasetExportsEnabled} /></aside>}
        </div>
      </>}
    </section>
  );
}
