import { useOrganizationName } from "../lib/organizationName.js";
import { RosterInvitations } from "../components/RosterInvitations.jsx";
import { WorkspaceCardTitle, WorkspaceSection, WorkspaceOverview, useWorkspaceTitle, useWorkspace, WorkspaceListPager, workspaceListRows } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { runBusyWrite } from "../lib/busyWrite.js";
import { CalendarDays, CheckCircle2, ClipboardList, Compass, KeyRound, Lock, Search, ShieldAlert, ShieldCheck, UserPlus, X } from "lucide-react";
import { ConversationLegalHoldControls } from "../components/ConversationLegalHoldControls.jsx";
import { AutomationWorkspaceLink } from "../components/AutomationWorkspaceLink.jsx";
import { Dialog } from "../components/Dialog.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { PlaneHeader, PlaneKpi } from "../components/PlaneHeader.jsx";
import { StaffRoster } from "../components/StaffRoster.jsx";
import { ChapterAppointmentsPanel } from "../components/ChapterAppointmentsPanel.jsx";
import { EventAuthoringCard } from "../components/EventAuthoringCard.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { useDesk } from "../lib/useDesk.js";
import { rpcErrorText, rpcRefusalKey } from "../lib/rpcErrorText.js";
import { countKey, localeFor } from "../lib/i18n.js";
import { ROLE_LABEL_KEYS, PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { LeadershipClaimsPanel } from "../features/governance/LeadershipClaimsPanel.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { AdminFormTemplateEditor } from "../components/AdminFormTemplateEditor.jsx";
import { AdminCommandCenter, DeskPageLink } from "../components/AdminCommandCenter.jsx";
import { AdministrativeEvidencePanel } from "../components/AdministrativeEvidencePanel.jsx";
import { MemberOperations } from "../features/memberOperations/MemberOperations.jsx";
import { RetentionEnginePanel } from "../features/retention/RetentionEnginePanel.jsx";
import { SetupBanner } from "../features/orgSetup/SetupBanner.jsx";
import { AdminLaunchChecklistSlot } from "../features/orgSetup/AdminLaunchChecklist.jsx";
import { SetupReviewPage } from "../features/orgSetup/SetupReviewPage.jsx";
import { IssueSignalsStaffPanel } from "../features/issueIntelligence/IssueSignals.jsx";
import { invitationErrorKey } from "../lib/adminInvitationApi.js";
import { PeopleWaitingPage } from "../features/intakeQueue/PeopleWaitingPage.jsx";

// Chapter admin — real, role-gated plane: staff role management (audited
// grant/revoke through admin-gated definer RPCs), event + check-in-code
// management (the only surface that shows the static SG- code), and the live
// admin audit trail. The demo fictions (integrations, SSO/SCIM, webhooks,
// API keys, 2FA/retention toggles, pending invites) had no backing and were
// removed rather than faked.
//
// Wave 2e: restyled to the prototype's Users & dues anatomy (pg.xusers) —
// the .ph page strip, accent-left KPI tiles, and the table-row card idiom.
// The prototype's dues column, dues KPIs, bulk CSV import, "+ Add member"
// and per-row "Manage ▾" menus are absent for the same reason as the demo
// fictions above: nothing in this schema backs them. Paint moved out of
// inline style objects into the xus- classes so it can be contrast-audited;
// no behaviour, guard or wording changed with it.

// Organizer is a Union Ground hat (PRODUCT.md) and is grantable like the
// other staff hats.
const GRANTABLE = ["steward", "organizer", "coordinator", "advisor", "admin", "vp"];
const GRANT_RESULT_KEYS = {
  done: "admin.grantResultDone",
  noop: "admin.grantResultNoop",
  failed: "admin.grantResultFailed",
  removed: "admin.revokeResultDone",
  removeFailed: "admin.revokeResultFailed",
};
const COMPASS_ROLE_LABEL_KEYS = {
  member: "admin.compassRoleMember",
  steward: "admin.compassRoleSteward",
  coordinator: "admin.compassRoleCoordinator",
  advisor: "admin.compassRoleAdvisor",
  admin: "admin.compassRoleAdmin",
  vp: "admin.compassRolePresident",
};
// President ("vp") joined by owner decision, October 8, 2026
// (REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006): the accepted
// invitation makes the person President of the invitation's chapter only.
const INVITABLE_ROLES = ["", "steward", "organizer", "coordinator", "advisor", "vp"];

// The chapter an invitation goes to: the admin's pick when the database lists
// it as one this admin may invite into, otherwise the selected chapter
// (BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003).
// President is offered only for a chapter this admin administers
// (grantsAccess): create_member_invitation refuses it in a chapter they only
// preside over.
export function invitableRolesFor(invitations, pickedId) {
  const target = invitationTargetChapterId(invitations, pickedId);
  const chapters = Array.isArray(invitations?.chapters) ? invitations.chapters : [];
  const administrable = chapters.some((chapter) => chapter.id === target && chapter.grantsAccess === true);
  return administrable ? INVITABLE_ROLES : INVITABLE_ROLES.filter((role) => role !== "vp");
}

export function invitationTargetChapterId(invitations, pickedId) {
  const chapters = Array.isArray(invitations?.chapters) ? invitations.chapters : [];
  return pickedId && chapters.some((chapter) => chapter.id === pickedId)
    ? pickedId
    : invitations?.chapter?.id ?? null;
}

function memberReference(person, t) {
  const suffix = String(person?.userId || "").split("-").at(-1)?.slice(-6).toUpperCase();
  return suffix ? t("admin.memberReference", { suffix }) : "";
}

function memberIdentityContext(person, t) {
  return [
    person?.memberSince ? t("today.memberSince", { year: person.memberSince }) : null,
    person?.chapterName,
  ].filter(Boolean).join(" · ");
}

function memberActionName(person, t) {
  return [person.fullName, memberIdentityContext(person, t), memberReference(person, t)]
    .filter(Boolean)
    .join(" — ");
}

const AUDIT_CAMPAIGN_KINDS = ["ballot", "pulse"];

// Every code member_admin_audit_action_check allows has a sentence here
// (tests/admin-audit-text.test.jsx reads the constraint and fails on a code
// without one); a code added later reads as a generic change, never the slug.
// The reader returns no target name once the person's account is deleted, so
// the sentence names a removed account instead of ending on "to".
function settingLabel(detail, t) {
  const key = typeof detail?.item === "string" ? detail.item : "";
  const translated = key ? t(`settings.def.${key}.label`) : "";
  if (translated && translated !== `settings.def.${key}.label`) return translated;
  return (typeof detail?.label === "string" && detail.label.trim()) || key;
}

function auditPhrase(item, t, chapterName) {
  const roleSlug = item.detail?.role || "";
  const kind = AUDIT_CAMPAIGN_KINDS.includes(item.detail?.kind) ? item.detail.kind : "other";
  const chapterId = item.detail?.chapterId || "";
  const vars = {
    actor: item.actorName || "",
    name: item.targetName || t("admin.auditRemovedAccount"),
    chapter: chapterId ? chapterName(chapterId) || chapterId : t("admin.auditUnknownChapter"),
    campaign: t(`admin.auditCampaign.${kind}`),
    // Same label the roster chips use — "granted President", not "granted vp".
    role: ROLE_LABEL_KEYS[roleSlug] ? t(ROLE_LABEL_KEYS[roleSlug]) : roleSlug,
    title: item.detail?.title || item.detail?.eventId || "",
    item: item.detail?.item || "",
  };
  switch (item.action) {
    case "grant_role": return t("admin.actionGrant", vars);
    case "revoke_role": return t("admin.actionRevoke", vars);
    case "create_event": return t("admin.actionCreateEvent", vars);
    case "update_event": return t("admin.actionUpdateEvent", vars);
    // UB-EVT-06 verbs: calling off or removing an event is exactly what a
    // member asks the trail about afterwards, so none may fall through to the
    // raw action slug.
    case "cancel_event": return t("admin.actionCancelEvent", vars);
    case "restore_event": return t("admin.actionRestoreEvent", vars);
    case "delete_event": return t("admin.actionDeleteEvent", vars);
    // Lowering a member's account security is exactly the entry a reviewer
    // scans the trail for, so it must not fall through to the raw slug.
    // Union Ground's earlier two-phase reset audited its start separately.
    case "reset_mfa_started": return t("admin.actionResetMfaStarted", vars);
    case "reset_mfa": return t("admin.actionResetMfa", { ...vars, count: item.detail?.factorsRemoved ?? 0 });
    case "recover_signin_address": return t("admin.actionRecoverSignin", vars);
    case "recover_signin_address_failed": return t("admin.actionRecoverSigninFailed", vars);
    case "self_service_password_reset": return t("admin.actionSelfServicePasswordReset", vars);
    case "mfa_recovery_code_used": return t("admin.actionMfaRecoveryCodeUsed", vars);
    // A feature switch or limit changed or went back to its default (the
    // configuration audit), named by its translated label.
    case "organization_setting_updated": return t("admin.actionSettingUpdated", { ...vars, item: settingLabel(item.detail, t) });
    case "organization_setting_reset": return t("admin.actionSettingReset", { ...vars, item: settingLabel(item.detail, t) });
    case "set_staff_mfa_policy": {
      if (typeof item.detail?.requireMemberMfa === "boolean") {
        return t(item.detail.requireMemberMfa ? "admin.actionSetMemberMfaOn" : "admin.actionSetMemberMfaOff", vars);
      }
      return t(item.detail?.requireStaffMfa ? "admin.actionSetStaffMfaOn" : "admin.actionSetStaffMfaOff", vars);
    }
    case "set_compass_ai_enabled": return t(item.detail?.enabled ? "admin.actionCompassEnabled" : "admin.actionCompassPaused", vars);
    case "set_compass_ai_role_limit": return t("admin.actionCompassLimit", {
      ...vars,
      role: COMPASS_ROLE_LABEL_KEYS[roleSlug] ? t(COMPASS_ROLE_LABEL_KEYS[roleSlug]) : roleSlug,
      count: item.detail?.hourlyLimit ?? "",
    });
    case "attest_compass_ai_provider": return t(item.detail?.status === "revoked" ? "admin.actionCompassRevoked" : "admin.actionCompassAttested", vars);
    // Union Ground has no rewards economy, but the audit constraint still
    // allows these codes and older rows may carry them, so each keeps a
    // sentence instead of falling to the generic change.
    case "claim_reward": return t("admin.actionClaimReward", vars);
    case "grant_reward": return t("admin.actionGrantReward", vars);
    case "revoke_reward": return t("admin.actionRevokeReward", vars);
    case "fulfill_reward": return t("admin.actionFulfillReward", { ...vars, to: item.detail?.to || "" });
    // An unknown campaign reads "created a campaign", never "created campaign
    // a campaign".
    case "create_chapter": return t(chapterId ? "admin.actionCreateChapter" : "admin.actionCreateChapterUnnamed", vars);
    case "update_chapter": return t(chapterId ? "admin.actionUpdateChapter" : "admin.actionUpdateChapterUnnamed", vars);
    case "grant_chapter_membership": return t("admin.actionGrantChapterMembership", vars);
    case "revoke_chapter_membership": return t("admin.actionRevokeChapterMembership", vars);
    case "set_chapter_display_title": return t(item.detail?.title ? "admin.actionSetChapterTitle" : "admin.actionClearChapterTitle", vars);
    // Committee, access-policy and list-row actions the database records.
    case "committee_updated": return t("admin.actionCommitteeUpdated", vars);
    case "access_membership_updated": return t("admin.actionAccessMembershipUpdated", vars);
    case "access_policy_updated": return t("admin.actionAccessPolicyUpdated", vars);
    case "role_capability_updated": return t("admin.actionRoleCapabilityUpdated", vars);
    case "role_scope_updated": return t("admin.actionRoleScopeUpdated", vars);
    case "grievance_identity_visibility_updated": return t("admin.actionGrievanceIdentityUpdated", vars);
    case "case_row_topic_policy_updated": return t(item.detail?.enabled === true ? "admin.actionCaseRowTopicChapterOn" : "admin.actionCaseRowTopicChapterOff", vars);
    case "case_row_topic_updated": return t(item.detail?.shown === true ? "admin.actionCaseRowTopicCaseOn" : "admin.actionCaseRowTopicCaseOff", vars);
    case "create_campaign": return t("admin.actionCreateCampaign", vars);
    case "update_campaign_draft": return t("admin.actionUpdateCampaignDraft", vars);
    case "publish_campaign": return t("admin.actionPublishCampaign", vars);
    case "close_campaign": return t("admin.actionCloseCampaign", vars);
    case "review_email_intake": return t("admin.actionReviewEmailIntake", vars);
    case "event_checkin_lockout": return t("admin.actionEventCheckinLockout", { ...vars, count: item.detail?.wrongAttempts ?? 0 });
    default: return t("admin.actionOther", vars);
  }
}

export function auditText(item, t, chapterName = (id) => id) {
  const text = auditPhrase(item, t, chapterName);
  // "a removed account claimed…" starts a sentence; capitalize only that.
  return !item.targetName && text.startsWith(t("admin.auditRemovedAccount"))
    ? text.charAt(0).toLocaleUpperCase() + text.slice(1)
    : text;
}

function CompassGovernanceCard({ governance, api, busy, run, t }) {
  const serverLimitsKey = JSON.stringify(Object.fromEntries(
    (governance?.roleLimits || []).map((row) => [row.role, String(row.hourlyLimit)]),
  ));
  const syncedLimitsKey = useRef(serverLimitsKey);
  const [limits, setLimits] = useState(() => JSON.parse(serverLimitsKey));
  const [evidenceRef, setEvidenceRef] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [confirmZdr, setConfirmZdr] = useState(false);
  const [confirmTraining, setConfirmTraining] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");

  useEffect(() => {
    // The card first paints in the same turn that the async desk read lands.
    // Initializing from that payload keeps the following passive effect from
    // overwriting a fast admin edit before Save receives the click. Later
    // reloads still replace the draft when the authoritative values change.
    if (syncedLimitsKey.current === serverLimitsKey) return;
    syncedLimitsKey.current = serverLimitsKey;
    setLimits(JSON.parse(serverLimitsKey));
  }, [serverLimitsKey]);

  const canAttest = evidenceRef.trim().length > 0
    && expiresAt.length > 0
    && Number.isFinite(Date.parse(expiresAt))
    && confirmZdr
    && confirmTraining;

  async function saveLimit(role) {
    if (String(limits[role] ?? "").trim() === "") return;
    const hourlyLimit = Number(limits[role]);
    if (!Number.isSafeInteger(hourlyLimit) || hourlyLimit < 0 || hourlyLimit > 200) return;
    await run(() => api.setCompassAiRoleLimit(role, hourlyLimit), "admin.compassLimitSaved");
  }

  async function createAttestation(event) {
    event.preventDefault();
    if (!canAttest) return;
    const saved = await run(() => api.attestCompassAiProvider({
      evidenceRef: evidenceRef.trim(),
      expiresAt: new Date(expiresAt).toISOString(),
      confirmZeroDataRetention: true,
      confirmDisallowPromptTraining: true,
      status: "verified",
    }), "admin.compassAttested");
    if (saved) {
      setEvidenceRef("");
      setExpiresAt("");
      setConfirmZdr(false);
      setConfirmTraining(false);
    }
  }

  async function revokeAttestation(event) {
    event.preventDefault();
    if (!revokeReason.trim()) return;
    if (!window.confirm(t("admin.compassRevokeConfirm"))) return;
    const saved = await run(() => api.attestCompassAiProvider({
      evidenceRef: revokeReason.trim(),
      expiresAt: null,
      confirmZeroDataRetention: false,
      confirmDisallowPromptTraining: false,
      status: "revoked",
    }), "admin.compassRevoked");
    if (saved) setRevokeReason("");
  }

  return (
    <WorkspaceSection name="admin-compass-governance"><article id="admin-compass-governance" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><Compass size={18} /></span>
        <div className="xus-cardhead__copy">
          <h3 className="xus-cardttl">{t("admin.compassGovernanceTitle")}</h3>
          <p className="xus-cardsub">{t("admin.compassGovernanceSub")}</p>
        </div>
      </header>
      {governance === null ? (
        <div className="xus-cardbody xus-inline" role="status">
          <p className="xus-note">{t("admin.compassGovernanceUnavailable")}</p>
        </div>
      ) : (
        <>
          <div className="xus-cardbody xus-ai-status" role="status" aria-live="polite">
            <div>
              {governance.demo && <p className="xus-ai-demo">{t("admin.compassDemo")}</p>}
              <p className={`xus-ai-state ${governance.enabled ? "xus-ai-state--on" : ""}`}>
                {governance.enabled
                  ? t("admin.compassEnabled")
                  : t(governance.attestationReady ? "admin.compassPausedReady" : "admin.compassPausedUnattested")}
              </p>
              <p className="xus-note xus-note--pad">
                {t("admin.compassExactPolicy", { gateway: governance.gateway, model: governance.model })}
              </p>
            </div>
            <button
              type="button"
              className={`xus-btn ${governance.enabled ? "" : "xus-btn--go"}`}
              disabled={busy || (!governance.enabled && !governance.attestationReady)}
              onClick={() => run(
                () => api.setCompassAiEnabled(!governance.enabled),
                governance.enabled ? "admin.compassPausedNotice" : "admin.compassEnabledNotice",
              )}
            >
              {governance.enabled ? t("admin.compassPause") : t("admin.compassEnable")}
            </button>
          </div>

          <section className="xus-cardbody xus-ai-section" aria-labelledby="compass-role-limits-title">
            <div>
              <h4 id="compass-role-limits-title" className="xus-eyebrow">{t("admin.compassLimitsTitle")}</h4>
              <p className="xus-note xus-note--pad">{t("admin.compassLimitsHelp")}</p>
            </div>
            <div className="xus-ai-grid">
              {governance.roleLimits.map(({ role }) => {
                const label = t(COMPASS_ROLE_LABEL_KEYS[role]);
                return (
                  <div className="xus-ai-limit" key={role}>
                    <label className="xus-field">
                      {t("admin.compassRoleLimit", { role: label })}
                      <input
                        className="xus-input"
                        type="number"
                        min="0"
                        max="200"
                        step="1"
                        value={limits[role] ?? ""}
                        onChange={(event) => setLimits((previous) => ({ ...previous, [role]: event.target.value }))}
                      />
                    </label>
                    <button
                      type="button"
                      className="xus-btn"
                      disabled={busy || String(limits[role] ?? "").trim() === "" || !Number.isSafeInteger(Number(limits[role])) || Number(limits[role]) < 0 || Number(limits[role]) > 200}
                      onClick={() => saveLimit(role)}
                    >
                      {t("admin.compassSaveRoleLimit", { role: label })}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="xus-cardbody xus-ai-section" aria-labelledby="compass-attestation-title">
            <div>
              <h4 id="compass-attestation-title" className="xus-eyebrow">{t("admin.compassAttestationTitle")}</h4>
              <p className="xus-note xus-note--pad">{t("admin.compassAttestationHelp")}</p>
            </div>
            <form className="xus-form" onSubmit={createAttestation}>
              <label className="xus-field">{t("admin.compassEvidence")}
                <input className="xus-input" value={evidenceRef} maxLength="500" onChange={(event) => setEvidenceRef(event.target.value)} required />
              </label>
              <label className="xus-field">{t("admin.compassExpiry")}
                <input className="xus-input" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required />
              </label>
              <label className="xus-ai-check">
                <input type="checkbox" checked={confirmZdr} onChange={(event) => setConfirmZdr(event.target.checked)} />
                <span>{t("admin.compassConfirmZdr")}</span>
              </label>
              <label className="xus-ai-check">
                <input type="checkbox" checked={confirmTraining} onChange={(event) => setConfirmTraining(event.target.checked)} />
                <span>{t("admin.compassConfirmTraining")}</span>
              </label>
              <button type="submit" className="xus-btn xus-btn--go" disabled={busy || !canAttest}>{t("admin.compassAttest")}</button>
            </form>
            {governance.latestAttestation?.status === "verified" && (
              <form className="xus-form xus-ai-revoke" onSubmit={revokeAttestation}>
                <label className="xus-field">{t("admin.compassRevokeReason")}
                  <input className="xus-input" value={revokeReason} maxLength="500" onChange={(event) => setRevokeReason(event.target.value)} required />
                </label>
                <button type="submit" className="xus-btn xus-btn--danger" disabled={busy || !revokeReason.trim()}>{t("admin.compassRevoke")}</button>
              </form>
            )}
          </section>

          <section className="xus-ai-log" aria-label={t("admin.compassAttestationLog")}>
            {governance.attestations.length === 0 && <p className="xus-note">{t("admin.compassAttestationEmpty")}</p>}
            {governance.attestations.map((row) => (
              <div className="xus-arow" key={row.id}>
                <p className="xus-atext">
                  {t(row.status === "verified" ? "admin.compassAttestationVerified" : "admin.compassAttestationRevoked", {
                    actor: [row.actorName, row.attestedBy].filter(Boolean).join(" · "),
                    evidence: row.evidenceRef,
                    expiry: row.expiresLabel || t("date.notSet"),
                  })}
                </p>
                <small className="xus-atime">{row.createdLabel}</small>
              </div>
            ))}
          </section>
        </>
      )}
    </article></WorkspaceSection>
  );
}

// The demo never reaches the claim review route: it gets the same permanent
// 404 not-available answer the demo host gives (api/organization-claim-review.js).
// A password reissue failure names its own class; it is never shown as the
// address-change error (BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003).
const PASSWORD_REISSUE_ERRORS = Object.freeze({
  "reissue-unavailable": "reissue-unavailable",
  "not-permitted": "reissue-not-permitted",
  "reissue-incomplete": "reissue-incomplete",
});
const RECOVERY_ERROR_KEYS = Object.freeze({
  recovery: "admin.recoveryError",
  // The server refuses a government or employer address with its own code.
  "email-domain-blocked": "admin.emailDomainBlocked",
  "reissue-unavailable": "admin.passwordReissueBusy",
  "reissue-not-permitted": "admin.passwordReissueNotPermitted",
  "reissue-incomplete": "admin.passwordReissueIncomplete",
  "reissue-failed": "admin.passwordReissueFailed",
});

// A desk belongs to one signed-in person in one organization and chapter. A
// scope change (new session, organization, rail or chapter-card switch) mounts
// a fresh desk, so nothing read for the old scope, and no draft, confirmation
// or busy state from it, stays on screen or actionable while the new scope
// loads, after it fails, or while Try again retries it. The old desk's pending
// read is retired by useDesk's unmount guard.
export function AdminView(props) {
  const { t } = useLang();
  const member = props.data?.member;
  const scope = `${member?.id ?? ""}:${member?.organizationId ?? ""}:${member?.chapterId ?? ""}`;
  const scopeFocus = useRef(null);
  if (props.chapterTransition) return <div className="screen xus-plane">
    <div className="xus-body">
      {props.chapterTransition === "error" ? <EmptyState>
        <p role="alert">{t("admin.chapterRefreshFailed")}</p>
        <button type="button" className="xus-btn admin-panel-retry" onClick={props.onRetryChapter}>{t("app.tryAgain")}</button>
      </EmptyState> : <p className="empty-state" role="status">{t("admin.loading")}</p>}
    </div>
  </div>;
  return <AdminDesk key={scope} {...props} evidenceScope={scope} scopeFocus={scopeFocus} />;
}

const shownDesks = new Map();

function AdminDesk({ scopeFocus, evidenceScope, data, api, demo = false, sampleLive = false, railChapter = null, onNotice: publishNotice, onProfile, onAssistant, operationsHealth = null, automationControl = null, memberOperationsActor = null, memberOperationsClient = null, memberOperationsSession = null, renderConnectedEventActions = null, issueSignals = null, setupCompletionGuard }) {
  const workspace = useWorkspace();
  const pageTitle = useWorkspaceTitle(null);
  const organizationName = useOrganizationName();
  const { t, lang } = useLang();
  const intakeHeadingId = useId();
  const { desk, error, load: readDesk } = useDesk(api);
  // Focus inside a section that a scope change unmounts (a chapter switch
  // button, say) returns to that section once the new scope's desk is shown.
  const rootRef = useRef(null);
  const lastFocusedSection = useRef(null);
  const activeScope = useRef(true);
  const load = useCallback(() => activeScope.current ? readDesk() : Promise.resolve(), [readDesk]);
  const deskOwner = JSON.stringify([data.member?.id, data.member?.organizationId]);
  useEffect(() => {
    if (!setupCompletionGuard) return undefined;
    const loads = shownDesks.get(deskOwner) || new Set();
    loads.add(load);
    shownDesks.set(deskOwner, loads);
    return () => {
      loads.delete(load);
      if (loads.size === 0) shownDesks.delete(deskOwner);
    };
  }, [deskOwner, load, setupCompletionGuard]);
  const reloadSetupDesk = useCallback(() => {
    for (const reloadDesk of shownDesks.get(deskOwner) || []) void reloadDesk();
  }, [deskOwner]);
  const onNotice = useCallback((notice) => { if (activeScope.current) publishNotice(notice); }, [publishNotice]);
  useLayoutEffect(() => {
    activeScope.current = true;
    const root = rootRef.current;
    return () => {
      activeScope.current = false;
      const active = document.activeElement;
      if (!active || active === document.body || root?.contains(active)) {
        scopeFocus.current = lastFocusedSection.current;
      }
    };
  }, [scopeFocus]);
  useEffect(() => {
    if (!desk || !scopeFocus.current) return;
    const sectionId = scopeFocus.current;
    scopeFocus.current = null;
    if (!document.activeElement || document.activeElement === document.body) document.getElementById(sectionId)?.focus();
  }, [desk, scopeFocus]);
  const canManageOrganizationRoles = Array.isArray(data.member?.organizationRoles)
    && data.member.organizationRoles.includes("admin");
  const [busy, setBusy] = useState(false);
  const [visibleRows, setVisibleRows] = useState({ invitations: 6, mfa: 6, governance: 6, audit: 6, reviews: 6 });
  const revealMore = (key) => setVisibleRows((current) => ({ ...current, [key]: current[key] + 6 }));
  const [query, setQuery] = useDeviceParityState("admin.memberQuery", "");
  const [results, setResults] = useDeviceParityState("admin.memberResults", null);
  const [roleToGrant, setRoleToGrant] = useDeviceParityState("admin.roleToGrant", "steward");
  const [confirmingMfa, setConfirmingMfa] = useState(null);
  // The last grant's outcome, kept on the access card until the next grant
  // (BUG-UG-PRESIDENT-GRANT-UNCONFIRMED-AND-NOT-APPLIED-20261006): a
  // toast alone left an admin unsure whether the grant stuck. It names a
  // member, so like invitation drafts it stays out of companion parity.
  const [grantResult, setGrantResult] = useState(null);
  const [governanceDrafts, setGovernanceDrafts] = useDeviceParityState("admin.governanceDrafts", {});
  // Invitation drafts contain member identity data, so unlike disclosure and
  // filter state they deliberately stay in this document instead of being
  // mirrored into the companion-phone parity channel.
  const [invitationForm, setInvitationForm] = useState({ fullName: "", email: "", chapterId: "", initialRole: "", locale: lang, formerMember: false });
  const [invitationBusy, setInvitationBusy] = useState(null);
  const [invitationError, setInvitationError] = useState(false);
  const [invitationSuccess, setInvitationSuccess] = useState(false);
  const [confirmingInvitation, setConfirmingInvitation] = useState(null);
  // Recovery drafts are identity data and stay local to this render. They are
  // deliberately excluded from companion-device parity and browser storage.
  const [recoveryQuery, setRecoveryQuery] = useState("");
  const [recoveryResults, setRecoveryResults] = useState(null);
  const [recoveryTarget, setRecoveryTarget] = useState(null);
  const [recoveryForm, setRecoveryForm] = useState({ newEmail: "", reason: "lost_inbox", identityVerified: false });
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryConfirming, setRecoveryConfirming] = useState(false);
  const [recoveryError, setRecoveryError] = useState(null);
  const [recoverySuccess, setRecoverySuccess] = useState(null);

  // notice is an i18n key, or a function of the RPC result so no-op writes
  // (granted:false / revoked:false / updated:false) toast honestly.
  async function run(work, notice) {
    // Every admin write funnels through here, so one guard covers the event
    // create/edit submits and the grant/revoke/reset-MFA buttons alike.
    if (!activeScope.current || busy) return false;
    setBusy(true);
    try {
      const result = await work();
      if (!activeScope.current) return false;
      onNotice(t(typeof notice === "function" ? notice(result) : notice));
      load();
      return result ?? true;
    } catch (err) {
      if (activeScope.current) onNotice(rpcErrorText(t, err, "toast.saveFailed"));
      return false;
    } finally {
      if (activeScope.current) setBusy(false);
    }
  }

  async function search(event) {
    event.preventDefault();
    if (busy || query.trim().length < 2) return;
    try {
      const rows = await api.searchMembers(query);
      if (activeScope.current) setResults(rows);
    } catch (err) {
      if (activeScope.current) onNotice(rpcErrorText(t, err, "toast.saveFailed"));
    }
  }

  // The signed-in admin's own id. Used only to HIDE the reset control on their
  // own row: the endpoint and begin_mfa_reset each refuse a self-target on
  // their own, so this is presentation, not the guard.
  const selfUserId = data.member?.id || null;
  const isSelf = (person) => Boolean(selfUserId) && person?.userId === selfUserId;

  // A synchronous lock: two presses in one tick both read busy as false, so
  // the state alone would send the reset (and its notice) twice.
  const mfaResetLock = useRef(false);
  // The same synchronous lock for the invitation, recovery and hold-search
  // writes: each key admits one write until it settles.
  const busyWriteRef = useRef(new Set());
  async function resetMfa(person) {
    if (isSelf(person) || !api.resetMfa) return;
    // Reports what actually happened. A member with no factors enrolled is a
    // removed:0 result, and saying "second factor removed" there would tell an
    // admin they fixed a lockout they did not fix. Whether the member was told
    // is reported too, because when the notice did not land the admin is the
    // one who has to reach them.
    if (busy || mfaResetLock.current) return;
    mfaResetLock.current = true;
    setBusy(true);
    try {
      const result = await api.resetMfa(person.userId);
      if (!activeScope.current) return;
      onNotice(t(result?.audited === false ? "admin.mfaResetAuditGap"
        : result?.notified !== true ? "admin.mfaResetUnnotified"
          : result?.removed ? "admin.mfaResetNotified" : "admin.mfaResetNone"));
      setConfirmingMfa(null);
      load();
    } catch (error) {
      if (!activeScope.current) return;
      onNotice(t(error.code === "partial-reset" ? "admin.mfaResetPartial"
        : error.code === "not-permitted" ? "admin.mfaResetDenied" : "admin.mfaResetFailed", error));
    } finally {
      mfaResetLock.current = false;
      if (activeScope.current) setBusy(false);
    }
  }

  // Preservation orders (legal holds). Loaded separately from the desk so a
  // failed read degrades to an explicit "could not load" line on its own card.
  const [legalHolds, setLegalHolds] = useState({ rows: [], loading: Boolean(api.listLegalHolds), error: !api.listLegalHolds });
  const [holdQuery, setHoldQuery] = useState("");
  const [holdConversations, setHoldConversations] = useState(null);
  const [holdSearchBusy, setHoldSearchBusy] = useState(false);
  const [holdSearchError, setHoldSearchError] = useState(false);
  const [selectedHoldConversation, setSelectedHoldConversation] = useState(null);
  function searchHoldConversations(event, cursor = null) {
    event?.preventDefault();
    if (holdSearchBusy || !api.loadHoldConversations) return undefined;
    return runBusyWrite(busyWriteRef, "hold-search", (release) => searchHoldConversationsNow(cursor, release));
  }
  async function searchHoldConversationsNow(cursor, release) {
    setHoldSearchBusy(true);
    setHoldSearchError(false);
    try {
      const rows = await api.loadHoldConversations({ search: holdQuery.trim(), cursor });
      if (activeScope.current) setHoldConversations(rows);
    } catch { if (activeScope.current) setHoldSearchError(true); }
    finally { release(); if (activeScope.current) setHoldSearchBusy(false); }
  }
  const [confirmingHold, setConfirmingHold] = useState(null);
  const legalHoldGeneration = useRef(0);
  const loadLegalHolds = useCallback(async () => {
    if (!api.listLegalHolds) return;
    const generation = ++legalHoldGeneration.current;
    setLegalHolds((prev) => ({ ...prev, loading: true, error: false }));
    try {
      const rows = await api.listLegalHolds();
      if (generation === legalHoldGeneration.current) setLegalHolds({ rows: Array.isArray(rows) ? rows : [], loading: false, error: false });
    } catch {
      if (generation === legalHoldGeneration.current) setLegalHolds({ rows: [], loading: false, error: true });
    }
  }, [api]);
  useEffect(() => {
    loadLegalHolds();
    return () => { legalHoldGeneration.current += 1; };
  }, [loadLegalHolds]);

  async function releaseLegalHold(hold) {
    setConfirmingHold(null);
    const result = await run(
      () => api.releaseLegalHold(hold.conversationId),
      (r) => (r?.released === false ? "admin.legalHoldReleaseNoop" : "admin.legalHoldReleased"),
    );
    if (activeScope.current && result) await loadLegalHolds();
  }

  async function grant(person) {
    const role = roleToGrant;
    let failure = null;
    setGrantResult(null);
    const result = await run(
      async () => {
        try {
          return await api.grantRole(person.userId, role);
        } catch (err) {
          failure = err;
          throw err;
        }
      },
      (r) => (r?.granted === false ? "admin.grantNoop" : "admin.roleGranted"),
    );
    if (!activeScope.current) return;
    if (failure) {
      // A key, never error.message: the note outlives the toast, so raw
      // English server text would sit on a Spanish screen.
      setGrantResult({ userId: person.userId, name: memberActionName(person, t), shortName: person.fullName, role, outcome: "failed", reasonKey: rpcRefusalKey(failure, "toast.saveFailed") });
    } else if (result) {
      setGrantResult({ userId: person.userId, name: memberActionName(person, t), shortName: person.fullName, role, outcome: result.granted === false ? "noop" : "done" });
    }
    if (result && result.granted !== false) {
      // Functional update: a search submitted while the grant was in flight
      // must not be clobbered by the list captured at click time.
      setResults((prev) => prev && prev.map((row) => (row.userId === person.userId && !row.roles.includes(roleToGrant)
        ? { ...row, roles: [...row.roles, roleToGrant].sort() }
        : row)));
    }
  }

  // A removal leaves the same in-place note as a grant: a founder stepping
  // back needs to see that their Admin role is gone, or why it is not
  // (REQ-UG-FOUNDER-SOLE-ADMIN-HANDOFF-TO-OFFICERS-20261006). It also
  // replaces a "now holds" note that a removal would make false.
  async function revoke(person, role) {
    let failure = null;
    const result = await run(async () => {
      try {
        return await api.revokeRole(person.userId, role);
      } catch (err) {
        failure = err;
        throw err;
      }
    }, (r) => (r?.revoked === false ? "admin.revokeNoop" : "admin.roleRevoked"));
    if (!activeScope.current) return;
    if (failure) {
      // The last-admin floor raises a bare 22023 with no DETAIL token; here
      // the message only selects the note's catalogue copy. (run()'s toast
      // still uses rpcErrorText, as for every admin write.)
      const lastAdmin = role === "admin" && String(failure?.code ?? "") === "22023" && /last organization admin/i.test(String(failure?.message ?? ""));
      setGrantResult({ userId: person.userId, name: memberActionName(person, t), shortName: person.fullName, role, outcome: "removeFailed", reasonKey: lastAdmin ? "admin.revokeLastAdmin" : rpcRefusalKey(failure, "toast.saveFailed") });
    } else if (result && result.revoked !== false) {
      setGrantResult({ userId: person.userId, name: memberActionName(person, t), shortName: person.fullName, role, outcome: "removed" });
      // Mirror of grant(): the search rows under the note must not still
      // show the removed role.
      setResults((prev) => prev && prev.map((row) => (row.userId === person.userId
        ? { ...row, roles: row.roles.filter((held) => held !== role) }
        : row)));
    }
  }

  async function submitGovernance(event, requestId) {
    event.preventDefault();
    const draft = governanceDrafts[requestId] || { status: "fulfilled", response: "" };
    if (!draft.response.trim()) return;
    const ok = await run(
      () => api.closeGovernance(requestId, draft.status, draft.response.trim()),
      "admin.governanceSaved",
    );
    if (activeScope.current && ok) setGovernanceDrafts((current) => ({
      ...current,
      [requestId]: { status: draft.status, response: "" },
    }));
  }

  async function submitInvitation(event) {
    event.preventDefault();
    if (invitationBusy || !desk?.invitations?.chapter) return;
    const chapterId = invitationTargetChapterId(desk.invitations, invitationForm.chapterId);
    setInvitationBusy("create");
    setInvitationError(false);
    setInvitationSuccess(false);
    try {
      await api.inviteMember({
        fullName: invitationForm.fullName.trim(),
        email: invitationForm.email.trim(),
        chapterId,
        // A role the selected chapter cannot take (President where this admin
        // only presides) is never sent.
        initialRole: invitationForm.formerMember || !invitableRolesFor(desk?.invitations, invitationForm.chapterId).includes(invitationForm.initialRole)
          ? null
          : (invitationForm.initialRole || null),
        locale: invitationForm.locale,
        formerMember: invitationForm.formerMember,
      });
      if (!activeScope.current) return;
      setInvitationForm((current) => ({ ...current, fullName: "", email: "", initialRole: "", formerMember: false }));
      setInvitationSuccess(true);
      onNotice(t("admin.invitationAccepted"));
      load();
    } catch (error) {
      // Provider, duplicate, and identity state never appear in operator copy.
      // The endpoint's successful shape is already uniform; only the failure
      // class (worth retrying or not) is read, never the raw error.
      if (activeScope.current) setInvitationError(invitationErrorKey(error));
    } finally {
      if (activeScope.current) setInvitationBusy(null);
    }
  }

  function mutateInvitation(kind, invitation) {
    if (invitationBusy) return undefined;
    return runBusyWrite(busyWriteRef, "invitation", (release) => mutateInvitationNow(kind, invitation, release));
  }

  async function mutateInvitationNow(kind, invitation, release) {
    setInvitationBusy(`${kind}:${invitation.id}`);
    setInvitationError(false);
    setInvitationSuccess(false);
    setConfirmingInvitation(null);
    try {
      if (kind === "resend") await api.resendInvitation(invitation.id);
      else await api.revokeInvitation(invitation.id);
      if (!activeScope.current) return;
      setInvitationSuccess(true);
      onNotice(t(kind === "resend" ? "admin.invitationResent" : "admin.invitationRevoked"));
      load();
    } catch (error) {
      if (activeScope.current) setInvitationError(invitationErrorKey(error));
    } finally {
      release();
      if (activeScope.current) setInvitationBusy(null);
    }
  }

  async function searchRecovery(event) {
    event.preventDefault();
    if (recoveryBusy || recoveryQuery.trim().length < 2) return;
    setRecoveryError(null);
    setRecoverySuccess(null);
    try {
      const rows = await api.searchRecoveryMembers(recoveryQuery);
      if (activeScope.current) setRecoveryResults(rows);
    } catch {
      if (!activeScope.current) return;
      setRecoveryResults(null);
      setRecoveryError("recovery");
    }
  }

  function reviewRecovery(event) {
    event.preventDefault();
    if (!recoveryTarget || !recoveryForm.newEmail.trim() || !recoveryForm.identityVerified) return;
    setRecoveryError(null);
    setRecoverySuccess(null);
    setRecoveryConfirming(true);
  }

  function submitRecovery() {
    if (recoveryBusy || !recoveryTarget || !recoveryForm.identityVerified) return undefined;
    return runBusyWrite(busyWriteRef, "recovery", submitRecoveryNow);
  }

  async function submitRecoveryNow(release) {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoverySuccess(null);
    try {
      await api.recoverSigninAddress({
        userId: recoveryTarget.userId,
        newEmail: recoveryForm.newEmail.trim(),
        reason: recoveryForm.reason,
        identityVerified: true,
      });
      if (!activeScope.current) return;
      setRecoveryQuery("");
      setRecoveryResults(null);
      setRecoveryTarget(null);
      setRecoveryForm({ newEmail: "", reason: "lost_inbox", identityVerified: false });
      setRecoveryConfirming(false);
      setRecoverySuccess("address");
      onNotice(t("admin.recoveryNotice"));
      load();
    } catch (error) {
      if (!activeScope.current) return;
      setRecoveryConfirming(false);
      setRecoveryError(error?.code === "email-domain-blocked" ? "email-domain-blocked" : "recovery");
    } finally {
      release();
      if (activeScope.current) setRecoveryBusy(false);
    }
  }

  function submitPasswordReissue() {
    if (recoveryBusy || !recoveryTarget || !recoveryForm.identityVerified) return undefined;
    return runBusyWrite(busyWriteRef, "recovery", submitPasswordReissueNow);
  }

  async function submitPasswordReissueNow(release) {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoverySuccess(null);
    try {
      await api.reissuePassword({ userId: recoveryTarget.userId, identityVerified: true });
      if (!activeScope.current) return;
      setRecoverySuccess("password");
      onNotice(t("admin.passwordReissueNotice"));
      load();
    } catch (error) {
      if (activeScope.current) setRecoveryError(PASSWORD_REISSUE_ERRORS[error?.code] || "reissue-failed");
    } finally {
      release();
      if (activeScope.current) setRecoveryBusy(false);
    }
  }

  // null roster/events = the read failed or came back malformed. The panel
  // says so and offers Try again; the KPIs show a dash, never a confident 0.
  const rosterUnavailable = Boolean(desk) && !Array.isArray(desk.roster);
  const eventsUnavailable = Boolean(desk) && !Array.isArray(desk.events);
  const roster = rosterUnavailable ? [] : desk?.roster || [];
  const events = eventsUnavailable ? [] : desk?.events || [];
  // null audit = the reader RPC failed; an empty trail and an unreadable
  // trail are different facts on a compliance surface.
  const auditUnavailable = Boolean(desk) && desk.audit === null;
  const audit = Array.isArray(desk?.audit) ? desk.audit : [];
  const auditChapterName = (id) => desk?.organization?.chapters?.find((chapter) => chapter.id === id)?.name || id;
  const roleGrants = roster.reduce((sum, person) => sum + (person.roles || []).length, 0);
  // Same null sentinel as the audit: "could not read who has MFA on" must
  // never render as "nobody has MFA on".
  const mfaUnavailable = Boolean(desk) && desk.mfa === null;
  const mfaStaff = desk?.mfa?.staff || [];
  const mfaStaffOn = mfaStaff.filter((person) => person.totpVerified).length;
  // undefined is a pre-migration/demo-fixture shape and therefore unavailable,
  // never an authoritative Off. This keeps the control honest across a DB-first
  // rollout and prevents a stale client from inviting a write it cannot make.
  const mfaPolicy = desk?.mfaPolicy ?? null;
  // Unknown is not Off. The card renders an unavailable state without a
  // switch, while the server independently denies every reservation.
  const compassAiGovernance = desk?.compassAiGovernance ?? null;
  const reviewsUnavailable = Boolean(desk) && desk.leadershipReviews === null;
  const leadershipReviews = Array.isArray(desk?.leadershipReviews) ? desk.leadershipReviews : [];
  const governanceUnavailable = Boolean(desk) && desk.governance === null;
  const governance = Array.isArray(desk?.governance) ? desk.governance : [];
  const invitationsUnavailable = Boolean(desk) && desk.invitations === null;
  const invitationChapter = desk?.invitations?.chapter ?? null;
  // More than one chapter means this admin may choose where the invitee lands.
  const invitationChapters = Array.isArray(desk?.invitations?.chapters) && desk.invitations.chapters.length > 1
    ? desk.invitations.chapters
    : null;
  const invitations = desk?.invitations?.items ?? [];
  const rosterImportReady = !invitationsUnavailable && !sampleLive && invitationChapter;
  const invitableRoles = invitableRolesFor(desk?.invitations, invitationForm.chapterId);
  // Officer titles are display-only and set in the member directory once the
  // person has joined (BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003).
  // Say so only when the directory carries titles, so the form never points at
  // an editor the database cannot back yet.
  const officerTitlesAvailable = Array.isArray(desk?.memberDirectory?.items)
    && desk.memberDirectory.items.some((person) => Object.hasOwn(person ?? {}, "displayTitle"));
  const organizationScoped = desk?.organization?.scope
    ? desk.organization.scope === "organization"
    : data.member.organizationRoles?.includes("admin");
  return (
    <div ref={rootRef} className="screen xus-plane" onFocus={(event) => { lastFocusedSection.current = event.target.closest?.(".role-section-target")?.id || null; }}>
      {/* The eyebrow ScreenHeader used to carry becomes the strip's subline —
          same string, and the avatar / assistant entry points it also carried
          now live in the shared plane chrome. */}
      <PlaneHeader title={pageTitle || t("admin.title")} eyebrow={organizationScoped ? organizationName : data.member.chapterName} sub={t(organizationScoped ? "admin.eyebrowOrganization" : "admin.eyebrow")} initials={data.member.initials} onProfile={onProfile} onAssistant={onAssistant} />

      <div className="xus-body">
        {/* Removing your own Admin role ends your admin reads, so the reload
            after it fails; the confirmation takes the failure card's place
            instead of being hidden behind it (gate round 3 on #4104). */}
        {error && grantResult?.outcome === "removed" && grantResult.role === "admin" && grantResult.userId === selfUserId ? (
          <EmptyState>
            <p role="status">{t(GRANT_RESULT_KEYS.removed, { name: grantResult.name, role: t(ROLE_LABEL_KEYS.admin) })}</p>
          </EmptyState>
        ) : error && (
          <EmptyState>
            <p>{error}</p>
            <button type="button" className="xus-btn" onClick={load}>{t("app.tryAgain")}</button>
          </EmptyState>
        )}

        {!error && !desk && <p className="empty-state" role="status">{t("admin.loading")}</p>}

        <AdminLaunchChecklistSlot error={error} desk={desk} organizationAdmin={canManageOrganizationRoles} />
        <WorkspaceOverview />
        {!error && desk && (
          <>
            <WorkspaceSection name="overview"><SetupBanner organization={desk.organization} organizationId={data.member.organizationId} /><div className="pkpi-grid" role="group" aria-label={t("admin.title")}>
              <PlaneKpi label={t("admin.kpiSeats")} value={rosterUnavailable ? "—" : roster.length} tone="green" />
              <PlaneKpi label={t("admin.kpiRoles")} value={rosterUnavailable ? "—" : roleGrants} tone="green" />
              <PlaneKpi label={t("admin.kpiEvents")} value={eventsUnavailable ? "—" : events.length} tone="gold" />
              <PlaneKpi label={t("admin.kpiAudit")} value={auditUnavailable ? "—" : audit.length} tone="gold" />
            </div></WorkspaceSection>
            {issueSignals && <WorkspaceSection name="overview"><IssueSignalsStaffPanel issueSignals={issueSignals} hat="admin" /></WorkspaceSection>}

            <WorkspaceSection name={["admin-member-directory","admin-organization","admin-chapter-handshake","admin-handshake-documents","admin-chapter-memberships","admin-configuration","admin-labels","admin-failed-logins","admin-lifecycle"]}><AdminCommandCenter
              directory={desk.memberDirectory ?? null}
              organization={desk.organization ?? null}
              chapterLifecycle={desk.chapterLifecycle ?? null}
              railChapter={railChapter}
              configuration={desk.configuration ?? null}
              failedLoginInbox={desk.failedLoginInbox ?? null}
              showRetention={canManageOrganizationRoles}
              api={api}
              reload={load}
              onNotice={onNotice}
            /></WorkspaceSection>

            <WorkspaceSection name="admin-setup-review"><SetupReviewPage api={api} data={data} organization={desk.organization} demo={demo} onNotice={setupCompletionGuard ? publishNotice : onNotice} reload={setupCompletionGuard ? reloadSetupDesk : load} issueSignals={issueSignals} organizationGuard={setupCompletionGuard} /></WorkspaceSection>

            <WorkspaceSection name="admin-people-waiting">
              {demo || sampleLive ? (
                <article id="admin-people-waiting" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1" aria-labelledby={intakeHeadingId}>
                  <div className="xus-cardbody">
                    <WorkspaceCardTitle outline className="xus-cardttl" id={intakeHeadingId}>{t("admin.peopleWaitingTitle")}</WorkspaceCardTitle>
                    <p role="status">{t("admin.demoPeopleWaiting")}</p>
                    <DeskPageLink path="/m/admin">{t("admin.backToAdmin")}</DeskPageLink>
                  </div>
                </article>
              ) : api.requestIntakeReview && (
                <PeopleWaitingPage requestReview={api.requestIntakeReview} requestTopicSend={api.requestTopicSend} />
              )}
            </WorkspaceSection>

            <WorkspaceSection name="admin-evidence-operations"><AdministrativeEvidencePanel api={api} scopeKey={evidenceScope} /></WorkspaceSection>

            <WorkspaceSection name="admin-automation-control">{automationControl ?? <AutomationWorkspaceLink />}</WorkspaceSection>

            {!demo && memberOperationsActor && memberOperationsClient && (
              <WorkspaceSection name="admin-member-operations"><MemberOperations actor={memberOperationsActor} client={memberOperationsClient} session={memberOperationsSession} onNotice={onNotice} /></WorkspaceSection>
            )}
            {/* The retention RPC is organization-admin only; a chapter-only admin would see its refusal as an outage. */}
            {canManageOrganizationRoles && <WorkspaceSection name="admin-retention-engine"><RetentionEnginePanel
              engine={desk.retentionEngine ?? null}
              unavailableReason={desk.retentionEngineUnavailable ?? null}
              api={api}
              reload={load}
              onNotice={onNotice}
            /></WorkspaceSection>}

            <WorkspaceSection name="admin-invitations"><article id="admin-invitations" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><UserPlus size={18} /></span>
                <div className="xus-cardhead__copy">
                  <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.inviteTitle")}</WorkspaceCardTitle>
                  <p className="xus-cardsub">{t("admin.inviteSub")}</p>
                </div>
              </header>
              {invitationsUnavailable && (
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.invitationsUnavailable")}</p>
                  <button type="button" className="xus-btn" onClick={load}>{t("app.tryAgain")}</button>
                </div>
              )}
              {!invitationsUnavailable && invitationChapter && (
                <>
                  {/* SAMPLE's invitation and password-reissue handlers refuse
                      with 404 so they never mint production mail; say so
                      instead of offering a form that can only fail. */}
                  {sampleLive ? (
                    <div className="xus-cardbody">
                      <p className="xus-note">{t("admin.invitationsSampleUnavailable")}</p>
                    </div>
                  ) : (
                  <div className="xus-cardbody">
                    <form className="xus-form" onSubmit={submitInvitation}>
                      <div className="xus-formgrid">
                        <label className="xus-field">{t("admin.inviteName")}
                          <input className="xus-input" autoComplete="name" value={invitationForm.fullName} onChange={(event) => setInvitationForm((current) => ({ ...current, fullName: event.target.value }))} minLength={invitationForm.formerMember ? 0 : 2} maxLength={120} required={!invitationForm.formerMember} disabled={invitationForm.formerMember} />
                        </label>
                        <label className="xus-field">{t("admin.inviteEmail")}
                          <input className="xus-input" type="email" inputMode="email" autoComplete="email" value={invitationForm.email} onChange={(event) => setInvitationForm((current) => ({ ...current, email: event.target.value }))} maxLength={254} required />
                        </label>
                        <label className="xus-field">{t("admin.inviteChapter")}
                          {invitationChapters ? (
                            <select className="xus-input" value={invitationTargetChapterId(desk.invitations, invitationForm.chapterId)} onChange={(event) => { const chapterId = event.target.value; setInvitationForm((current) => ({ ...current, chapterId, initialRole: invitableRolesFor(desk.invitations, chapterId).includes(current.initialRole) ? current.initialRole : "" })); }}>
                              {invitationChapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
                            </select>
                          ) : (
                            <input className="xus-input" value={invitationChapter.name} disabled />
                          )}
                        </label>
                        <label className="xus-field">{t("admin.inviteRole")}
                          <select className="xus-input" value={invitationForm.formerMember ? "" : invitationForm.initialRole} disabled={invitationForm.formerMember} onChange={(event) => setInvitationForm((current) => ({ ...current, initialRole: event.target.value }))}>
                            {invitableRoles.map((role) => <option key={role || "member"} value={role}>{role ? t(ROLE_LABEL_KEYS[role]) : t("admin.inviteMemberRole")}</option>)}
                          </select>
                        </label>
                        <label className="xus-field">{t("admin.inviteLanguage")}
                          <select className="xus-input" value={invitationForm.locale} onChange={(event) => setInvitationForm((current) => ({ ...current, locale: event.target.value }))}>
                            <option value="en">English</option>
                            <option value="es">Español</option>
                          </select>
                        </label>
                      </div>
                      <label className="xus-ai-check">
                        <input type="checkbox" checked={invitationForm.formerMember} onChange={(event) => setInvitationForm((current) => ({ ...current, formerMember: event.target.checked, ...(event.target.checked ? { fullName: "", initialRole: "" } : {}) }))} />
                        <span>{t("admin.inviteFormerMember")}</span>
                      </label>
                      {invitationForm.formerMember && <p className="xus-note">{t("admin.inviteFormerMemberHelp")}</p>}
                      {!invitationForm.formerMember && invitationForm.initialRole === "vp" && invitableRoles.includes("vp") && <p className="xus-note">{t("admin.invitePresidentScope")}</p>}
                      {officerTitlesAvailable && <p className="xus-note">{t("admin.inviteOfficerTitles")}</p>}
                      <p className="xus-note">{t("admin.inviteSafety")}</p>
                      {invitationError && <p role="alert" className="xus-note xus-note--error">{t(invitationError)}</p>}
                      {invitationSuccess && <p role="status" className="xus-note xus-note--success">{t("admin.invitationAccepted")}</p>}
                      <div className="xus-btnrow">
                        <button type="submit" className="xus-btn xus-btn--go" disabled={Boolean(invitationBusy)}>{invitationBusy === "create" ? t("admin.invitationSending") : t("admin.invitationSend")}</button>
                      </div>
                    </form>
                  </div>
                  )}
                  {invitations.length === 0 && <div className="xus-cardbody xus-cardbody--divided"><p className="xus-note">{t("admin.invitationsEmpty")}</p></div>}
                  {workspaceListRows(invitations, visibleRows.invitations, Boolean(workspace)).map((invitation) => {
                    const canAct = ["pending", "delivery_failed", "expired"].includes(invitation.status);
                    const rowBusy = invitationBusy?.endsWith(`:${invitation.id}`);
                    return (
                      <div key={invitation.id} className="xus-row">
                        <span className="xus-av" aria-hidden="true">{invitation.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
                        <div className="xus-rowmain">
                          <strong className="xus-name">{invitation.fullName}</strong>
                          <small className="xus-meta">{invitation.normalizedEmail}</small>
                          <small className="xus-meta">{t(`admin.invitationStatus.${invitation.status}`)} · {t("admin.invitationExpires", { date: invitation.expiresLabel })}</small>
                          <span className="xus-chiprow">
                            <span className={`xus-chip ${invitation.status === "accepted" ? "xus-chip--on" : "xus-chip--off"}`}>{t(`admin.invitationStatus.${invitation.status}`)}</span>
                            {invitation.kind === "reactivation" && <span className="xus-chip xus-chip--note">{t("admin.invitationKindReactivation")}</span>}
                            {invitationChapters && invitation.chapterName && <span className="xus-chip xus-chip--note">{invitation.chapterName}</span>}
                            <span className="xus-chip xus-chip--note">{invitation.initialRole ? t(ROLE_LABEL_KEYS[invitation.initialRole]) : t("admin.inviteMemberRole")}</span>
                            <span className="xus-chip xus-chip--note">{t(invitation.locale === "es" ? "auth.langSpanish" : "auth.langEnglish")}</span>
                          </span>
                        </div>
                        {canAct && !sampleLive && (
                          <span className="xus-rowact">
                            <button type="button" className="xus-btn" disabled={Boolean(invitationBusy)} onClick={() => mutateInvitation("resend", invitation)}>{rowBusy && invitationBusy.startsWith("resend") ? t("admin.invitationSending") : t("admin.invitationResend")}</button>
                            <button type="button" className="xus-btn" disabled={Boolean(invitationBusy)} onClick={() => setConfirmingInvitation(invitation.id)}>{t("admin.invitationRevoke")}</button>
                          </span>
                        )}
                        {confirmingInvitation === invitation.id && (
                          <div role="group" aria-label={t("admin.invitationRevokeConfirm", { name: invitation.fullName })} className="xus-confirm">
                            <p className="xus-note">{t("admin.invitationRevokeConfirm", { name: invitation.fullName })}</p>
                            <div className="xus-btnrow">
                              <button type="button" className="xus-btn xus-btn--danger" disabled={Boolean(invitationBusy)} onClick={() => mutateInvitation("revoke", invitation)}>{t("admin.invitationRevokeYes")}</button>
                              <button type="button" className="xus-btn" disabled={Boolean(invitationBusy)} onClick={() => setConfirmingInvitation(null)}>{t("admin.cancel")}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <WorkspaceListPager count={invitations.length} end={visibleRows.invitations} onChange={(end) => setVisibleRows(current => ({ ...current, invitations: end }))}>{invitations.length > visibleRows.invitations && <button type="button" className="xus-btn xus-show-more" onClick={() => revealMore("invitations")}>{t("coordinator.showMore", { count: invitations.length - visibleRows.invitations })}</button>}</WorkspaceListPager>
                </>
              )}
            </article></WorkspaceSection>

            <WorkspaceSection name="admin-roster-import">
              {(rosterImportReady || workspace?.section === "admin-roster-import") && (
                <article id="admin-roster-import" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex={-1}>
                  {rosterImportReady ? (
                    <RosterInvitations api={api} chapters={invitationChapters || [invitationChapter]} reload={load} invitations={invitations} />
                  ) : (
                    <div className="xus-cardbody">
                      <WorkspaceCardTitle outline>{t("roster.importTitle")}</WorkspaceCardTitle>
                      <p role="status">{t(invitationsUnavailable ? "admin.invitationsUnavailable"
                        : sampleLive ? "admin.invitationsSampleUnavailable" : "admin.invitationsEmpty")}</p>
                    </div>
                  )}
                </article>
              )}
            </WorkspaceSection>

            <WorkspaceSection name="admin-signin-recovery"><article id="admin-signin-recovery" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><KeyRound size={18} /></span>
                <div className="xus-cardhead__copy">
                  <WorkspaceCardTitle outline className="xus-cardttl">{t("admin.recoveryTitle")}</WorkspaceCardTitle>
                  <p className="xus-cardsub">{t("admin.recoverySub")}</p>
                </div>
              </header>
              <div className="xus-cardbody">
                <p className="xus-note">{t("admin.recoverySafety")}</p>
                {!sampleLive && <p className="xus-note">{t("admin.passwordReissueHatNotice")}</p>}
                {!recoveryTarget && (
                  <form className="xus-searchrow xus-recovery-search" onSubmit={searchRecovery}>
                    <input
                      className="xus-input xus-search"
                      type="search"
                      value={recoveryQuery}
                      onChange={(event) => setRecoveryQuery(event.target.value)}
                      placeholder={t("admin.recoverySearchLabel")}
                      aria-label={t("admin.recoverySearchLabel")}
                      minLength={2}
                    />
                    <button type="submit" className="xus-btn xus-btn--go" disabled={recoveryBusy || recoveryQuery.trim().length < 2}>
                      {t("admin.recoverySearchButton")}
                    </button>
                  </form>
                )}
                {recoveryResults !== null && recoveryResults.length === 0 && !recoveryTarget && (
                  <p className="xus-note xus-note--pad">{t("admin.recoverySearchEmpty")}</p>
                )}
                {recoveryError && <p role="alert" className="xus-note xus-note--error xus-note--pad">{t(RECOVERY_ERROR_KEYS[recoveryError] || "admin.recoveryError")}</p>}
                {recoverySuccess && <p role="status" className="xus-note xus-note--success xus-note--pad">{t(recoverySuccess === "password" ? "admin.passwordReissueNotice" : "admin.recoverySuccess")}</p>}
              </div>
              {!recoveryTarget && (recoveryResults || []).map((person) => (
                <div key={person.userId} className="xus-row">
                  <span className="xus-av">{person.initials}</span>
                  <div className="xus-rowmain">
                    <strong className="xus-name">{person.fullName}</strong>
                    <small className="xus-meta">
                      {memberIdentityContext(person, t)}
                    </small>
                    <small className="xus-meta">{memberReference(person, t)}</small>
                  </div>
                  <button
                    type="button"
                    className="xus-btn"
                    aria-label={t("admin.recoveryChoose", { name: memberActionName(person, t) })}
                    onClick={() => { setRecoveryTarget(person); setRecoveryResults(null); setRecoveryError(null); setRecoverySuccess(null); }}
                  >
                    {t("admin.recoveryChooseButton")}
                  </button>
                </div>
              ))}
              {recoveryTarget && (
                <div className="xus-cardbody xus-cardbody--divided">
                  <div className="xus-recovery-target">
                    <span className="xus-av">{recoveryTarget.initials}</span>
                    <div className="xus-rowmain">
                      <strong className="xus-name">{recoveryTarget.fullName}</strong>
                      <small className="xus-meta">
                        {memberIdentityContext(recoveryTarget, t)}
                      </small>
                      <small className="xus-meta">{memberReference(recoveryTarget, t)}</small>
                    </div>
                    <button type="button" className="xus-btn" disabled={recoveryBusy} onClick={() => { setRecoveryTarget(null); setRecoveryConfirming(false); setRecoveryForm({ newEmail: "", reason: "lost_inbox", identityVerified: false }); }}>
                      {t("admin.cancel")}
                    </button>
                  </div>
                  <form className="xus-form xus-recovery-form" onSubmit={reviewRecovery}>
                    <div className="xus-formgrid">
                      <label className="xus-field">{t("admin.recoveryNewEmail")}
                        <input className="xus-input" type="email" inputMode="email" autoComplete="off" maxLength={254} required value={recoveryForm.newEmail} onChange={(event) => { setRecoveryConfirming(false); setRecoveryForm((current) => ({ ...current, newEmail: event.target.value })); }} />
                      </label>
                      <label className="xus-field">{t("admin.recoveryReason")}
                        <select className="xus-input" value={recoveryForm.reason} onChange={(event) => { setRecoveryConfirming(false); setRecoveryForm((current) => ({ ...current, reason: event.target.value })); }}>
                          <option value="lost_inbox">{t("admin.recoveryReasonLost")}</option>
                          <option value="address_retired">{t("admin.recoveryReasonRetired")}</option>
                        </select>
                      </label>
                    </div>
                    <label className="xus-checkline">
                      <input type="checkbox" checked={recoveryForm.identityVerified} onChange={(event) => { setRecoveryConfirming(false); setRecoveryForm((current) => ({ ...current, identityVerified: event.target.checked })); }} />
                      <span>{t("admin.recoveryVerified")}</span>
                    </label>
                    <button type="submit" className="xus-btn xus-btn--go" aria-label={t("admin.recoveryReviewFor", { name: memberActionName(recoveryTarget, t) })} disabled={recoveryBusy || !recoveryForm.newEmail.trim() || !recoveryForm.identityVerified}>
                      {t("admin.recoveryReview")}
                    </button>
                    {sampleLive ? (
                      <p className="xus-note">{t("admin.passwordReissueSampleUnavailable")}</p>
                    ) : (
                      <>
                        <button type="button" className="xus-btn" aria-label={t("admin.passwordReissueFor", { name: memberActionName(recoveryTarget, t) })} disabled={recoveryBusy || !recoveryForm.identityVerified} onClick={submitPasswordReissue}>
                          {recoveryBusy ? t("admin.passwordReissuePending") : t("admin.passwordReissue")}
                        </button>
                        <p className="xus-note">{t("admin.passwordReissueHelp")}</p>
                      </>
                    )}
                  </form>
                  {recoveryConfirming && (
                    <div role="group" aria-label={t("admin.recoveryConfirm", { name: memberActionName(recoveryTarget, t) })} className="xus-confirm xus-recovery-confirm">
                      <p className="xus-note">{t("admin.recoveryConfirmDetail", { name: memberActionName(recoveryTarget, t), address: recoveryForm.newEmail.trim() })}</p>
                      <div className="xus-btnrow">
                        <button type="button" className="xus-btn xus-btn--danger" aria-label={t("admin.recoveryGoFor", { name: memberActionName(recoveryTarget, t) })} disabled={recoveryBusy} onClick={submitRecovery}>
                          {recoveryBusy ? t("admin.recoveryPending") : t("admin.recoveryGo")}
                        </button>
                        <button type="button" className="xus-btn" disabled={recoveryBusy} onClick={() => setRecoveryConfirming(false)}>{t("admin.cancel")}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </article></WorkspaceSection>

            <WorkspaceSection name="admin-access"><section id="admin-access" className="xus-sec role-section-target" tabIndex="-1">
              <header className="xus-sechead">
                <WorkspaceCardTitle outline className="xus-eyebrow">{t("admin.rolesTitle")}</WorkspaceCardTitle>
                <p className="xus-secsub">{t("admin.rolesSub")}</p>
              </header>
              {!canManageOrganizationRoles && <p className="xus-note xus-note--pad">{t("admin.rolesRestricted")}</p>}
              {/* An unread roster renders no rows and so no remove buttons:
                  nothing here may act on a roster the desk could not read. */}
              {rosterUnavailable && (
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.rosterUnavailable")}</p>
                  <button type="button" className="xus-btn admin-panel-retry" onClick={load}>{t("app.tryAgain")}</button>
                </div>
              )}
              {!rosterUnavailable && <StaffRoster
                roster={roster}
                renderRoleChip={(role, label, person) => (
                  <span key={role} className="reward-chip reward-chip--tier" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {label}
                    {canManageOrganizationRoles && (
                      <button
                        type="button"
                        className="xus-role-remove"
                        aria-label={t("admin.removeFor", { role: label, name: person.fullName })}
                        disabled={busy}
                        onClick={() => revoke(person, role)}
                      ><X size={16} aria-hidden="true" /></button>
                    )}
                  </span>
                )}
              />}

              <article className={`${PLANE_CARD_CLASS} xus-card`}>
                <header className="xus-cardhead">
                  <span className="xus-glyph" aria-hidden="true"><Search size={18} /></span>
                  <div className="xus-cardhead__copy">
                    <h3 className="xus-cardttl">{t("admin.promoteTitle")}</h3>
                  </div>
                </header>
                <div className="xus-cardbody">
                  <form onSubmit={search} className="xus-searchrow">
                    <input
                      className="xus-input xus-search"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("admin.searchPlaceholder")}
                      aria-label={t("admin.searchPlaceholder")}
                      minLength={2}
                    />
                    <button type="submit" className="xus-btn xus-btn--go" disabled={busy || query.trim().length < 2}>{t("admin.searchButton")}</button>
                  </form>
                  {canManageOrganizationRoles && (
                    <label className="xus-field xus-field--role">
                      {t("admin.roleToGrant")}
                      <select className="xus-input" value={roleToGrant} onChange={(event) => setRoleToGrant(event.target.value)} aria-label={t("admin.roleToGrant")}>
                        {GRANTABLE.map((role) => <option key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</option>)}
                      </select>
                    </label>
                  )}
                  {grantResult && (
                    <div role={grantResult.outcome.endsWith("ailed") ? "alert" : "status"} className="xus-note xus-note--pad">
                      <p>{t(GRANT_RESULT_KEYS[grantResult.outcome], {
                        name: grantResult.name,
                        role: t(ROLE_LABEL_KEYS[grantResult.role]),
                        reason: grantResult.reasonKey ? t(grantResult.reasonKey) : "",
                      })}</p>
                      {/* Mirrors loadMemberApp: with the staff two-step policy on,
                          a grantee without an authenticator app loads with no
                          staff roles at all, so the next-load promise is made
                          only when it holds. The roster lists role holders only,
                          so a first grant is absent until the post-grant reload,
                          and an unread roster or policy is unknown: then the
                          note says what decides it instead of promising. */}
                      {(grantResult.outcome === "done" || grantResult.outcome === "noop") && (() => {
                        const vars = { name: grantResult.shortName ?? grantResult.name, role: t(ROLE_LABEL_KEYS[grantResult.role]) };
                        const row = desk?.mfa ? mfaStaff.find((item) => item.userId === grantResult.userId) : null;
                        const standing = mfaPolicy && !mfaPolicy.requireStaffMfa ? "visible"
                          : mfaPolicy?.requireStaffMfa && row ? (row.totpVerified ? "visible" : "paused")
                            : "unknown";
                        if (standing === "paused") return <p>{t("admin.grantResultMfa", vars)}</p>;
                        if (grantResult.outcome !== "done") return null;
                        return <p>{t(standing === "visible" ? "admin.grantResultVisible" : "admin.grantResultMfaUnknown", vars)}</p>;
                      })()}
                    </div>
                  )}
                  {results !== null && results.length === 0 && <p className="xus-note xus-note--pad">{t("admin.searchEmpty")}</p>}
                </div>
                {(results || []).map((person) => (
                  <div key={person.userId} className="xus-row">
                    <span className="xus-av">{person.initials}</span>
                    <div className="xus-rowmain">
                      <strong className="xus-name">{person.fullName}</strong>
                      {/* Tenure, chapter, and a short stable ID suffix let an admin
                          distinguish duplicate names without exposing the
                          member's full opaque identifier. */}
                      <small className="xus-meta">
                        {memberIdentityContext(person, t)}
                      </small>
                      <small className="xus-meta">{memberReference(person, t)}</small>
                      <span className="xus-chiprow">
                        {(person.roles || []).map((role) => (
                          <span key={role} className="reward-chip reward-chip--tier">{ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role}</span>
                        ))}
                      </span>
                    </div>
                    <span className="xus-rowact">
                      {canManageOrganizationRoles && (
                        <button type="button" className="xus-btn xus-btn--go" aria-label={t("admin.grantFor", { role: t(ROLE_LABEL_KEYS[roleToGrant]), name: memberActionName(person, t) })} disabled={busy || (person.roles || []).includes(roleToGrant)} onClick={() => grant(person)}>
                          {t("admin.grant")}
                        </button>
                      )}
                      {/* The way back in for a member who enrolled TOTP and lost the
                          device: GoTrue refuses to unenrol a verified factor from
                          the aal1 session they are stuck at, and a fresh magic link
                          lands them at aal1 too. Confirmed because it genuinely
                          lowers that member's account security. */}
                      {isSelf(person) ? (
                        <span className="xus-chip xus-chip--note">{t("admin.resetMfaSelf")}</span>
                      ) : (
                        <button
                          type="button"
                          className="xus-btn"
                          aria-label={t("admin.resetMfaFor", { name: memberActionName(person, t) })}
                          disabled={busy || confirmingMfa?.userId === person.userId}
                          onClick={() => setConfirmingMfa(person)}
                        >
                          {t("admin.resetMfa")}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </article>
            </section></WorkspaceSection>

            <WorkspaceSection name="admin-mfa"><article id="admin-mfa" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><ShieldCheck size={18} /></span>
                <div className="xus-cardhead__copy">
                  <WorkspaceCardTitle as="h3" outline className="xus-cardttl">{t("admin.mfaTitle")}</WorkspaceCardTitle>
                  <p className="xus-cardsub">{t("admin.mfaSub")}</p>
                </div>
              </header>
              {mfaUnavailable && (
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.mfaUnavailable")}</p>
                  <button type="button" className="xus-btn" onClick={load}>{t("app.tryAgain")}</button>
                </div>
              )}
              {/* The org policy (UB-IDN-03). Rendered above the roster because
                  it is the control the roster exists to inform: the roster says
                  who is unprotected, this says whether that costs them anything.
                  Kept OUTSIDE the mfaUnavailable branch — the two reads are
                  independent RPCs, and losing the roster is no reason to hide a
                  security control that loaded fine. */}
              {mfaPolicy === null ? (
                <div className="xus-cardbody">
                  <p className="xus-note">{t("admin.mfaPolicyUnavailable")}</p>
                </div>
              ) : (
                <div className="xus-cardbody">
                  <p className="xus-eyebrow">{t("admin.mfaPolicyTitle")}</p>
                  <p className="xus-note">
                    {mfaPolicy.requireStaffMfa ? t("admin.mfaPolicyOn") : t("admin.mfaPolicyOff")}
                  </p>
                  <p className="xus-note">{t(mfaPolicy.requireStaffMfa ? "admin.mfaPolicySource" : "admin.mfaPolicyRecommendation")}</p>
                  {/* Said BEFORE the press, with the real number. Turning this on
                      suspends every hat held by a staffer who has not enrolled,
                      and an admin who learns that from the fallout learns it from
                      the people it happened to. */}
                  {!mfaPolicy.requireStaffMfa && mfaPolicy.staffTotal > mfaPolicy.staffEnrolled && (
                    <p className="xus-note xus-note--pad">
                      {t("admin.mfaPolicyImpact", { count: mfaPolicy.staffTotal - mfaPolicy.staffEnrolled, total: mfaPolicy.staffTotal })}
                    </p>
                  )}
                  {/* "Staff must set up" beside staff reading Off needs the count
                      of who has not yet. */}
                  {mfaPolicy.requireStaffMfa && mfaPolicy.staffTotal > mfaPolicy.staffEnrolled && (
                    <p className="xus-note xus-note--pad">
                      {t(mfaPolicy.staffTotal === 1 ? "admin.mfaPolicyWaitingOnly" : countKey("admin.mfaPolicyWaiting", mfaPolicy.staffTotal - mfaPolicy.staffEnrolled), { count: mfaPolicy.staffTotal - mfaPolicy.staffEnrolled, total: mfaPolicy.staffTotal })}
                    </p>
                  )}
                  {/* The server refuses this exact case; disabling the button
                      says so before the press rather than after the error. */}
                  {!mfaPolicy.requireStaffMfa && !mfaPolicy.callerEnrolled && (
                    <p className="xus-note xus-note--pad">{t("admin.mfaPolicySelfFirst")}</p>
                  )}
                  {!mfaPolicy.requireStaffMfa && <div className="xus-btnrow">
                    <button
                      type="button"
                      className="xus-btn xus-btn--go"
                      disabled={busy || !mfaPolicy.callerEnrolled}
                      onClick={() => run(() => api.setStaffMfaPolicy(true), "admin.mfaPolicyEnabled")}
                    >
                      {t("admin.mfaPolicyEnable")}
                    </button>
                  </div>}
                  <p className="xus-note">{t(mfaPolicy.requireMemberMfa ? "admin.mfaMembersOn" : "admin.mfaMembersOff")}</p>
                  <p className="xus-note">{t("admin.mfaMembersImpact")}</p>
                  {api.setMemberMfaPolicy && <div className="xus-btnrow">
                    <BusyButton type="button" className="xus-btn" pending={busy} disabled={!mfaPolicy.callerEnrolled}
                      onClick={() => run(() => api.setMemberMfaPolicy(!mfaPolicy.requireMemberMfa), "admin.mfaMembersSaved")}>
                      {t(mfaPolicy.requireMemberMfa ? "admin.mfaMembersDisable" : "admin.mfaMembersEnable")}
                    </BusyButton>
                  </div>}
                </div>
              )}
              {!mfaUnavailable && (
                <>
                  <div className="xus-cardbody">
                    <p className="xus-note">
                      {t("admin.mfaSummary", { on: mfaStaffOn, total: mfaStaff.length })} · {t(countKey("admin.mfaOrg", desk.mfa?.enrolledMembers ?? 0), { count: desk.mfa?.enrolledMembers ?? 0 })}
                    </p>
                    {/* Only an authenticator app counts here (UB-IDN-03): the
                        challenge screen verifies TOTP and the assurance
                        predicate is scoped to match, so a phone code or security
                        key registered against the account is not a second factor
                        for Union Ground. Said on the admin surface too, because
                        this is where somebody decides to require it. */}
                    <p className="xus-note xus-note--pad">{t("mfa.appOnly")}</p>
                    {mfaStaff.length === 0 && <p className="xus-note xus-note--pad">{t("admin.mfaEmpty")}</p>}
                  </div>
                  {workspaceListRows(mfaStaff, visibleRows.mfa, Boolean(workspace)).map((person) => (
                    <div key={person.userId} className="xus-row">
                      <span className="xus-av">{person.initials}</span>
                      <div className="xus-rowmain">
                        <strong className="xus-name">{person.fullName}</strong>
                        <small className="xus-meta">
                          {(person.roles || []).map((role) => (ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role)).join(" · ")}
                        </small>
                      </div>
                      <span className="xus-rowact">
                        <span className={`xus-chip ${person.totpVerified ? "xus-chip--on" : "xus-chip--off"}`}>
                          <span className="xus-chip__ic" aria-hidden="true">{person.totpVerified ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}</span>
                          <span>{person.totpVerified ? `${t("admin.mfaOn")}${person.verifiedLabel ? ` · ${person.verifiedLabel}` : ""}` : t("admin.mfaOff")}</span>
                        </span>
                        {/* A verified factor this client cannot challenge protects
                            nothing here (the assurance predicate is TOTP-only) —
                            the admin should see it rather than assume it counts. */}
                        {Number(person.otherFactors) > 0 && (
                          <span className="xus-chip xus-chip--note">{person.otherFactors === 1 ? t("admin.mfaOtherOne") : t("admin.mfaOther", { count: person.otherFactors })}</span>
                        )}
                        {/* Same audited reset as the member search, offered where
                            an admin actually looks when a staffer is locked out.
                            Never on the admin's own row: an admin is reset by
                            another admin (begin_mfa_reset refuses self). */}
                        {isSelf(person) ? (
                          <span className="xus-chip xus-chip--note">{t("admin.resetMfaSelf")}</span>
                        ) : (
                          <button
                            type="button"
                            className="xus-btn"
                            aria-label={t("admin.resetMfaFor", { name: memberActionName(person, t) })}
                            disabled={busy || confirmingMfa?.userId === person.userId}
                            onClick={() => setConfirmingMfa(person)}
                          >
                            {t("admin.resetMemberMfa")}
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  <WorkspaceListPager count={mfaStaff.length} end={visibleRows.mfa} onChange={(end) => setVisibleRows(current => ({ ...current, mfa: end }))}>{mfaStaff.length > visibleRows.mfa && <button type="button" className="xus-btn xus-show-more" onClick={() => revealMore("mfa")}>{t("coordinator.showMore", { count: mfaStaff.length - visibleRows.mfa })}</button>}</WorkspaceListPager>
                </>
              )}
            </article></WorkspaceSection>

            {/* Preservation orders live on the organization-ledger page: every
                place/release is a `message.legal_hold_*` ledger event, and the
                ledger card beneath is where an admin reads them back. */}
            <WorkspaceSection name="admin-organization-audit"><article id="admin-legal-holds" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><Lock size={18} /></span>
                <div className="xus-cardhead__copy">
                  <h3 className="xus-cardttl">{t("admin.legalHoldsTitle")}</h3>
                  <p className="xus-cardsub">{t("admin.legalHoldsSub")}</p>
                </div>
              </header>
              {api.loadHoldConversations && <div className="xus-cardbody">
                <form className="xus-searchrow" onSubmit={searchHoldConversations}>
                  <label className="xus-field">{t("admin.legalHoldSearch")}
                    <input className="xus-input" value={holdQuery} onChange={(event) => { setHoldQuery(event.target.value); setHoldConversations(null); }} />
                  </label>
                  <button type="submit" className="xus-btn" disabled={holdSearchBusy}>{t("admin.legalHoldFind")}</button>
                </form>
                {holdSearchError && <p role="alert">{t("admin.legalHoldsUnavailable")}</p>}
                {holdSearchBusy && <p role="status">{t("app.loading")}</p>}
                {!holdSearchError && holdConversations?.rows.length === 0 && <p>{t("steward.noMatches")}</p>}
                {!holdSearchError && holdConversations?.rows.map((conversation) => <div className="xus-row" key={conversation.id}>
                  <div className="xus-rowmain"><strong>{conversation.memberName}</strong><small className="xus-meta">{conversation.title}</small></div>
                  <button type="button" className="xus-btn" onClick={() => setSelectedHoldConversation(conversation)}>{t("admin.legalHoldManage")}</button>
                </div>)}
                {holdConversations?.nextCursor && <button className="xus-btn" type="button" disabled={holdSearchBusy} onClick={() => searchHoldConversations(null, holdConversations.nextCursor)}>{t("admin.legalHoldNext")}</button>}
              </div>}
              {legalHolds.loading && <p className="xus-note" role="status">{t("app.loading")}</p>}
              {legalHolds.error && (
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.legalHoldsUnavailable")}</p>
                  {api.listLegalHolds && <button type="button" className="xus-btn" onClick={loadLegalHolds}>{t("app.tryAgain")}</button>}
                </div>
              )}
              {!legalHolds.error && !legalHolds.loading && legalHolds.rows.length === 0 && (
                <div className="xus-cardbody">
                  <p className="xus-note">{t("admin.legalHoldsEmpty")}</p>
                </div>
              )}
              {!legalHolds.error && legalHolds.rows.map((hold) => (
                <div key={hold.conversationId} className="xus-row">
                  <span className="xus-av">{hold.memberInitials}</span>
                  <div className="xus-rowmain">
                    <strong className="xus-name">{(hold.memberName || t("admin.legalHoldUnnamed"))}</strong>
                    <small className="xus-meta">{hold.conversationTitle}</small>
                    <small className="xus-meta">
                      {t("admin.legalHoldSince", {
                        reason: t(`steward.legalHoldReason.${hold.reasonCode}`),
                        date: hold.placedAt ? new Date(hold.placedAt).toLocaleDateString(localeFor(lang)) : "",
                      })}
                    </small>
                  </div>
                  <span className="xus-rowact">
                    {api.releaseLegalHold && (
                      <button
                        type="button"
                        className="xus-btn"
                        aria-label={t("admin.legalHoldReleaseFor", { name: (hold.memberName || t("admin.legalHoldUnnamed")) })}
                        disabled={busy || confirmingHold === hold.conversationId}
                        onClick={() => setConfirmingHold(hold.conversationId)}
                      >
                        {t("admin.legalHoldRelease")}
                      </button>
                    )}
                  </span>
                  {confirmingHold === hold.conversationId && (
                    <div role="group" aria-label={t("admin.legalHoldReleaseFor", { name: (hold.memberName || t("admin.legalHoldUnnamed")) })} className="xus-confirm">
                      <p className="xus-note">{t("admin.legalHoldReleaseConfirm", { name: (hold.memberName || t("admin.legalHoldUnnamed")) })}</p>
                      <div className="xus-btnrow">
                        <button type="button" className="xus-btn xus-btn--danger" aria-label={t("admin.legalHoldReleaseGoFor", { name: (hold.memberName || t("admin.legalHoldUnnamed")) })} disabled={busy} onClick={() => releaseLegalHold(hold)}>
                          {t("admin.legalHoldReleaseGo")}
                        </button>
                        <button type="button" className="xus-btn" disabled={busy} onClick={() => setConfirmingHold(null)}>
                          {t("admin.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </article></WorkspaceSection>

            <WorkspaceSection name="admin-compass-governance"><CompassGovernanceCard
              governance={compassAiGovernance}
              api={api}
              busy={busy}
              run={run}
              t={t}
            /></WorkspaceSection>

            {/* An unread event list gets no authoring card: edit, cancel and
                delete act on rows the desk could not read. */}
            <WorkspaceSection name="admin-events">{eventsUnavailable ? (
              <article id="admin-events" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
                <header className="xus-cardhead">
                  <span className="xus-glyph" aria-hidden="true"><CalendarDays size={18} /></span>
                  <div className="xus-cardhead__copy">
                    <WorkspaceCardTitle outline as="h3" className="xus-cardttl">{t("admin.eventsTitle")}</WorkspaceCardTitle>
                  </div>
                </header>
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.eventsUnavailable")}</p>
                  <button type="button" className="xus-btn admin-panel-retry" onClick={load}>{t("app.tryAgain")}</button>
                </div>
              </article>
            ) : <EventAuthoringCard renderConnectedActions={renderConnectedEventActions} events={events} api={api} onNotice={onNotice} reload={load} chapterName={data.member.chapterName} />}</WorkspaceSection>

            <WorkspaceSection name="admin-form-templates"><AdminFormTemplateEditor api={api} demo={demo} /></WorkspaceSection>

            <WorkspaceSection name="admin-governance"><article id="admin-governance" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead"><span className="xus-glyph" aria-hidden="true"><ShieldCheck size={18} /></span><div className="xus-cardhead__copy"><h3 className="xus-cardttl">{t("admin.governanceTitle")}</h3><p className="xus-cardsub">{t("admin.governanceSub")}</p></div></header>
              {governanceUnavailable && <div className="xus-cardbody"><p className="xus-note">{t("admin.governanceUnavailable")}</p></div>}
              {!governanceUnavailable && governance.length === 0 && <div className="xus-cardbody"><p className="xus-note">{t("admin.governanceEmpty")}</p></div>}
              {workspaceListRows(governance, visibleRows.governance, Boolean(workspace)).map((item) => {
                const draft = governanceDrafts[item.id] || { status: "fulfilled", response: "" };
                return <div className="xus-cardbody" key={item.id}>
                  <strong>{item.requesterName} · {t(`admin.governanceType.${item.requestType}`)}</strong>
                  <p className="xus-note">{item.details}</p>
                  <small>{item.createdLabel} · {t(`admin.governanceStatus.${item.status}`)}</small>
                  {item.response && <blockquote>{item.response}</blockquote>}
                  <form className="xus-form" onSubmit={(event) => submitGovernance(event, item.id)}>
                    <label className="xus-field">{t("admin.governanceStatus")}<select className="xus-input" value={draft.status} onChange={(event) => setGovernanceDrafts((current) => ({ ...current, [item.id]: { ...draft, status: event.target.value } }))}><option value="reviewing">{t("admin.governanceStatus.reviewing")}</option><option value="fulfilled">{t("admin.governanceStatus.fulfilled")}</option><option value="denied">{t("admin.governanceStatus.denied")}</option></select></label>
                    <label className="xus-field">{t("admin.governanceResponse")}<textarea className="xus-input xus-input--area" maxLength={10000} required value={draft.response} onChange={(event) => setGovernanceDrafts((current) => ({ ...current, [item.id]: { ...draft, response: event.target.value } }))} /></label>
                    <button className="xus-btn xus-btn--go" type="submit" disabled={busy || !draft.response.trim()}>{t("admin.governanceSave")}</button>
                  </form>
                </div>;
              })}
              <WorkspaceListPager count={governance.length} end={visibleRows.governance} onChange={(end) => setVisibleRows(current => ({ ...current, governance: end }))}>{governance.length > visibleRows.governance && <button type="button" className="xus-btn xus-show-more" onClick={() => revealMore("governance")}>{t("coordinator.showMore", { count: governance.length - visibleRows.governance })}</button>}</WorkspaceListPager>
            </article>
            {!demo && <LeadershipClaimsPanel api={api} onNotice={onNotice} />}</WorkspaceSection>

            <WorkspaceSection name="admin-audit"><article id="admin-audit" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><ClipboardList size={18} /></span>
                <div className="xus-cardhead__copy">
                  <WorkspaceCardTitle as="h3" outline className="xus-cardttl">{t("admin.auditTitle")}</WorkspaceCardTitle>
                  <p className="xus-cardsub">{t("admin.auditSub")}</p>
                </div>
              </header>
              {auditUnavailable && (
                <div className="xus-cardbody xus-inline">
                  <p className="xus-note">{t("admin.auditUnavailable")}</p>
                  <button type="button" className="xus-btn" onClick={load}>{t("app.tryAgain")}</button>
                </div>
              )}
              {!auditUnavailable && audit.length === 0 && (
                <div className="xus-cardbody">
                  <p className="xus-note">{t("admin.auditEmpty")}</p>
                </div>
              )}
              {workspaceListRows(audit, visibleRows.audit, Boolean(workspace)).map((item) => (
                <div key={item.id} className="xus-arow">
                  <p className="xus-atext" title={t("admin.auditActionCode", { code: item.action })} data-audit-action={item.action}>{auditText(item, t, auditChapterName)}</p>
                  <small className="xus-atime">{item.createdLabel}</small>
                </div>
              ))}
              <WorkspaceListPager count={audit.length} end={visibleRows.audit} onChange={(end) => setVisibleRows(current => ({ ...current, audit: end }))}>{audit.length > visibleRows.audit && <button type="button" className="xus-btn xus-show-more" onClick={() => revealMore("audit")}>{t("coordinator.showMore", { count: audit.length - visibleRows.audit })}</button>}</WorkspaceListPager>
            </article></WorkspaceSection>

            <WorkspaceSection name={["admin-organization-audit","admin-job-health"]}>{operationsHealth}</WorkspaceSection>

            <WorkspaceSection name="admin-leadership-reviews"><article id="admin-leadership-reviews" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
              <header className="xus-cardhead">
                <span className="xus-glyph" aria-hidden="true"><CheckCircle2 size={18} /></span>
                <div className="xus-cardhead__copy">
                  <WorkspaceCardTitle as="h3" outline className="xus-cardttl">{t("admin.leadershipReviewsTitle")}</WorkspaceCardTitle>
                  <p className="xus-cardsub">{t("admin.leadershipReviewsSub")}</p>
                </div>
              </header>
              {reviewsUnavailable && <div className="xus-cardbody"><p className="xus-note">{t("admin.leadershipReviewsUnavailable")}</p></div>}
              {!reviewsUnavailable && leadershipReviews.length === 0 && <div className="xus-cardbody"><p className="xus-note">{t("admin.leadershipReviewsEmpty")}</p></div>}
              {workspaceListRows(leadershipReviews, visibleRows.reviews, Boolean(workspace)).map((item) => (
                <div key={item.caseId} className="xus-arow">
                  <p className="xus-atext">{item.caseReference} · {item.caseTitle} — {t("admin.leadershipReviewBy", { name: item.reviewerName })}</p>
                  <small className="xus-atime">{item.reviewedLabel}</small>
                </div>
              ))}
              <WorkspaceListPager count={leadershipReviews.length} end={visibleRows.reviews} onChange={(end) => setVisibleRows(current => ({ ...current, reviews: end }))}>{leadershipReviews.length > visibleRows.reviews && <button type="button" className="xus-btn xus-show-more" onClick={() => revealMore("reviews")}>{t("coordinator.showMore", { count: leadershipReviews.length - visibleRows.reviews })}</button>}</WorkspaceListPager>
            </article></WorkspaceSection>
            <WorkspaceSection name="admin-appointments"><ChapterAppointmentsPanel api={api} onNotice={onNotice} /></WorkspaceSection>
          </>
        )}
      </div>
      {selectedHoldConversation && <Dialog title={selectedHoldConversation.memberName} onClose={() => setSelectedHoldConversation(null)}>
        <ConversationLegalHoldControls key={selectedHoldConversation.id} conversationId={selectedHoldConversation.id} api={api} onNotice={onNotice} onChange={loadLegalHolds} />
      </Dialog>}
      {confirmingMfa && !isSelf(confirmingMfa) && (
        <Dialog title={t("admin.resetMemberMfa")} onClose={() => setConfirmingMfa(null)} beforeClose={() => !busy}>
          <p>{t("admin.resetMfaConfirm", { name: memberActionName(confirmingMfa, t) })}</p>
          <div className="xus-btnrow">
            <button type="button" className="xus-btn xus-btn--danger" disabled={busy}
              aria-label={t("admin.resetMfaGoFor", { name: memberActionName(confirmingMfa, t) })}
              onClick={() => resetMfa(confirmingMfa)}>{t("admin.resetMfaGo")}</button>
            <button type="button" className="xus-btn" disabled={busy} onClick={() => setConfirmingMfa(null)}>{t("admin.cancel")}</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
