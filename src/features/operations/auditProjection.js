// Projects the two current audit tables into the CR-106 envelope.
// Existing rows stay attributable; protected leftovers are dropped, not copied.

import {
  AUDIT_SINK_SOURCES,
  createAuditEvent,
  isAuditSinkSource,
  isUuid,
  looksLikeRowImage,
} from "./auditEnvelope.js";

export const MEMBER_ADMIN_AUDIT_PROJECTION = Object.freeze({
  grant_role: { domain: "membership", eventType: "role.granted", action: "grant", entityType: "role_grant" },
  revoke_role: { domain: "membership", eventType: "role.revoked", action: "revoke", entityType: "role_grant" },
  create_event: { domain: "community_events", eventType: "event.created", action: "create", entityType: "event" },
  update_event: { domain: "community_events", eventType: "event.updated", action: "update", entityType: "event" },
  cancel_event: { domain: "community_events", eventType: "event.cancelled", action: "update", entityType: "event" },
  restore_event: { domain: "community_events", eventType: "event.restored", action: "update", entityType: "event" },
  delete_event: { domain: "community_events", eventType: "event.deleted", action: "delete", entityType: "event" },
  reset_mfa: { domain: "security", eventType: "mfa.reset", action: "settings_change", entityType: "security_policy" },
  claim_reward: { domain: "rewards", eventType: "reward.claimed", action: "create", entityType: "reward" },
  grant_reward: { domain: "rewards", eventType: "reward.granted", action: "grant", entityType: "reward" },
  revoke_reward: { domain: "rewards", eventType: "reward.revoked", action: "revoke", entityType: "reward" },
  fulfill_reward: { domain: "rewards", eventType: "reward.fulfilled", action: "update", entityType: "reward" },
  set_staff_mfa_policy: { domain: "security", eventType: "mfa.policy_changed", action: "settings_change", entityType: "security_policy" },
  set_compass_ai_enabled: { domain: "administration", eventType: "settings.changed", action: "settings_change", entityType: "organization" },
  set_compass_ai_role_limit: { domain: "administration", eventType: "settings.changed", action: "settings_change", entityType: "organization" },
  attest_compass_ai_provider: { domain: "administration", eventType: "settings.changed", action: "settings_change", entityType: "organization" },
  create_campaign: { domain: "communications", eventType: "campaign.created", action: "create", entityType: "campaign" },
  update_campaign_draft: { domain: "communications", eventType: "campaign.updated", action: "update", entityType: "campaign" },
  publish_campaign: { domain: "communications", eventType: "campaign.published", action: "send", entityType: "campaign" },
  close_campaign: { domain: "communications", eventType: "campaign.closed", action: "update", entityType: "campaign" },
  recover_signin_address: { domain: "security", eventType: "signin.recovered", action: "update", entityType: "member" },
  recover_signin_address_failed: { domain: "security", eventType: "signin.recovery_failed", action: "update", entityType: "member" },
  self_service_password_reset: { domain: "security", eventType: "signin.recovered", action: "update", entityType: "member" },
  review_email_intake: { domain: "communications", eventType: "email.intake_reviewed", action: "update", entityType: "message" },
  create_chapter: { domain: "administration", eventType: "chapter.created", action: "create", entityType: "chapter" },
  update_chapter: { domain: "administration", eventType: "chapter.updated", action: "update", entityType: "chapter" },
  grant_chapter_membership: { domain: "membership", eventType: "membership.granted", action: "grant", entityType: "membership" },
  revoke_chapter_membership: { domain: "membership", eventType: "membership.revoked", action: "revoke", entityType: "membership" },
});

export const ORGANIZATION_AUDIT_EVENT_PROJECTION = Object.freeze({
  first_organization_bootstrap: {
    domain: "administration",
    eventType: "organization.bootstrapped",
    action: "create",
    entityType: "organization",
  },
  organization_membership_granted: {
    domain: "membership",
    eventType: "membership.granted",
    action: "grant",
    entityType: "membership",
  },
  organization_membership_revoked: {
    domain: "membership",
    eventType: "membership.revoked",
    action: "revoke",
    entityType: "membership",
  },
  organization_role_granted: {
    domain: "membership",
    eventType: "role.granted",
    action: "grant",
    entityType: "role_grant",
  },
  organization_role_revoked: {
    domain: "membership",
    eventType: "role.revoked",
    action: "revoke",
    entityType: "role_grant",
  },
  staff_mfa_policy_changed: {
    domain: "security",
    eventType: "mfa.policy_changed",
    action: "settings_change",
    entityType: "security_policy",
  },
});

function pickSafeMetadata(detail = {}, organizationId) {
  if (looksLikeRowImage(detail)) return { organizationId };
  const metadata = { organizationId };
  if (isUuid(detail.userId)) metadata.userId = detail.userId;
  if (typeof detail.role === "string") metadata.role = detail.role;
  if (typeof detail.status === "string") metadata.status = detail.status;
  if (typeof detail.chapterId === "string") metadata.chapterId = detail.chapterId;
  if (typeof detail.eventId === "string") metadata.entityId = detail.eventId;
  if (typeof detail.item === "string") metadata.reasonCode = detail.item.slice(0, 64);
  return metadata;
}
function safeIdempotencyKey(value, fallbackSeed) {
  if (isUuid(value)) return value;
  const hex = String(fallbackSeed || "0").replace(/[^0-9a-f]/gi, "").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function projectMemberAdminAuditRow(row) {
  if (!row || !isUuid(row.organizationId)) return null;
  const mapped = MEMBER_ADMIN_AUDIT_PROJECTION[row.action];
  if (!mapped) return null;
  const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
  return createAuditEvent({
    id: row.id ?? null,
    organizationId: row.organizationId,
    domain: mapped.domain,
    eventType: mapped.eventType,
    action: mapped.action,
    actorUserId: isUuid(row.actor) ? row.actor : null,
    entityType: mapped.entityType,
    entityId: typeof detail.eventId === "string" ? detail.eventId : (isUuid(row.targetUser) ? row.targetUser : null),
    occurredAt: row.createdAt,
    idempotencyKey: safeIdempotencyKey(row.idempotencyKey, row.id || row.action),
    metadata: pickSafeMetadata({ ...detail, userId: row.targetUser }, row.organizationId),
    source: "member_admin_audit",
  });
}

export function projectOrganizationAuditEventRow(row) {
  if (!row || !isUuid(row.organizationId)) return null;
  const mapped = ORGANIZATION_AUDIT_EVENT_PROJECTION[row.eventType];
  if (!mapped) return null;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return createAuditEvent({
    id: row.id ?? null,
    organizationId: row.organizationId,
    domain: mapped.domain,
    eventType: mapped.eventType,
    action: mapped.action,
    actorUserId: isUuid(row.actorUserId) ? row.actorUserId : null,
    entityType: mapped.entityType,
    entityId: typeof metadata.userId === "string" ? metadata.userId : row.organizationId,
    occurredAt: row.createdAt,
    idempotencyKey: safeIdempotencyKey(row.idempotencyKey, row.id || row.eventType),
    metadata: {
      organizationId: row.organizationId,
      ...(typeof metadata.chapterId === "string" ? { chapterId: metadata.chapterId } : {}),
      ...(typeof metadata.role === "string" ? { role: metadata.role } : {}),
      ...(typeof metadata.userId === "string" ? { userId: metadata.userId } : {}),
      ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
      ...(typeof metadata.requireStaffMfa === "boolean" ? { requireStaffMfa: metadata.requireStaffMfa } : {}),
    },
    source: "organization_audit_events",
  });
}

export function projectUnifiedAudit(sources = {}, selectedOrganizationId) {
  if (!isUuid(selectedOrganizationId)) return [];
  const adminRows = Array.isArray(sources.memberAdminAudit) ? sources.memberAdminAudit : [];
  const orgRows = Array.isArray(sources.organizationAuditEvents) ? sources.organizationAuditEvents : [];
  const events = [
    ...adminRows.map(projectMemberAdminAuditRow),
    ...orgRows.map(projectOrganizationAuditEventRow),
  ].filter((event) => event && event.organizationId === selectedOrganizationId);

  return events.sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (byTime !== 0) return byTime;
    return String(right.id || "").localeCompare(String(left.id || ""));
  });
}


// ---------------------------------------------------------------------------
// The five dormant audit sinks.
//
// Each projector reads the paged RPC row shape from
// 20260917090000_dormant_audit_sinks_read_rpcs.sql, which carries authorized
// record links only: no before/after row image, reason, note, actor name, or
// bounded jsonb detail ever reaches the browser, so there is nothing here to
// re-redact. An unknown kind is dropped rather than rendered as a raw token.
// ---------------------------------------------------------------------------

export const COORDINATOR_CASE_AUDIT_PROJECTION = Object.freeze({
  case_updated: { domain: "casework", eventType: "case.updated", action: "update" },
  note_added: { domain: "casework", eventType: "case.note_added", action: "create" },
  contact_logged: { domain: "casework", eventType: "case.contact_logged", action: "create" },
  outcome_recorded: { domain: "casework", eventType: "case.outcome_recorded", action: "update" },
});

export const MEMBER_INVITATION_AUDIT_PROJECTION = Object.freeze({
  invite_requested: { domain: "administration", eventType: "invitation.created", action: "create" },
  invite_sent: { domain: "administration", eventType: "invitation.sent", action: "send" },
  invite_delivery_failed: { domain: "administration", eventType: "invitation.delivery_failed", action: "send" },
  invite_resent: { domain: "administration", eventType: "invitation.resent", action: "send" },
  invite_revoked: { domain: "administration", eventType: "invitation.revoked", action: "revoke" },
  invite_claimed: { domain: "administration", eventType: "invitation.claimed", action: "update" },
  invite_accepted: { domain: "administration", eventType: "invitation.accepted", action: "update" },
  invite_expired: { domain: "administration", eventType: "invitation.expired", action: "update" },
  // REQ-UG-ORG-ADMIN-REINVITE-FORMER-MEMBER-20260926: the organization
  // admin's re-invitation of a former member and its acceptance.
  reinvite_requested: { domain: "administration", eventType: "invitation.reinvite_requested", action: "create" },
  reinvite_accepted: { domain: "administration", eventType: "invitation.reinvite_accepted", action: "update" },
  // REQ-UG-STEWARDS-REQUIRE-A-UNIT-20261109: the migration's reset of
  // an unfinished steward invitation that named no unit to a plain member.
  invite_role_cleared: { domain: "administration", eventType: "invitation.role_cleared", action: "update" },
});

export const AUTOMATION_DEFINITION_REVIEW_PROJECTION = Object.freeze({
  submitted: { domain: "administration", eventType: "automation_definition.submitted", action: "update" },
  approved: { domain: "administration", eventType: "automation_definition.approved", action: "update" },
  changes_requested: { domain: "administration", eventType: "automation_definition.changes_requested", action: "update" },
});

export const MEMBER_CASE_ASSIGNMENT_AUDIT_PROJECTION = Object.freeze({
  assigned: { domain: "casework", eventType: "case.assigned", action: "update" },
  reassigned: { domain: "casework", eventType: "case.reassigned", action: "update" },
  unassigned: { domain: "casework", eventType: "case.unassigned", action: "update" },
});

export const CASEWORK_AUDIT_EVENT_PROJECTION = Object.freeze({
  strength_scored: { domain: "casework", eventType: "case.strength_scored", action: "update" },
  // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920:
  // deadline_created is the creation of the deadline itself; the two
  // deadline_* kinds below remain the extension lifecycle.
  deadline_created: { domain: "casework", eventType: "case.deadline_created", action: "create" },
  deadline_requested: { domain: "casework", eventType: "case.deadline_requested", action: "create" },
  deadline_decided: { domain: "casework", eventType: "case.deadline_decided", action: "update" },
  checklist_created: { domain: "casework", eventType: "case.checklist_created", action: "create" },
  checklist_item_changed: { domain: "casework", eventType: "case.checklist_item_changed", action: "update" },
  step_advanced: { domain: "casework", eventType: "case.step_advanced", action: "update" },
  restriction_changed: { domain: "casework", eventType: "case.restricted", action: "update" },
  access_granted: { domain: "casework", eventType: "case.access_granted", action: "grant" },
  access_revoked: { domain: "casework", eventType: "case.access_revoked", action: "revoke" },
  alert_created: { domain: "casework", eventType: "case.alert_created", action: "create" },
  alert_acknowledged: { domain: "casework", eventType: "case.alert_acknowledged", action: "acknowledge" },
  alert_escalated: { domain: "casework", eventType: "case.alert_escalated", action: "update" },
  behavior_logged: { domain: "casework", eventType: "case.behavior_logged", action: "create" },
  behavior_addendum_added: { domain: "casework", eventType: "case.behavior_addendum_added", action: "create" },
  retaliation_submitted: { domain: "casework", eventType: "case.retaliation_submitted", action: "create" },
  retaliation_withdrawn: { domain: "casework", eventType: "case.retaliation_withdrawn", action: "update" },
  pattern_detected: { domain: "casework", eventType: "case.pattern_detected", action: "create" },
  pattern_reviewed: { domain: "casework", eventType: "case.pattern_reviewed", action: "update" },
  draft_saved: { domain: "casework", eventType: "case.draft_saved", action: "update" },
  bulk_updated: { domain: "casework", eventType: "case.bulk_updated", action: "update" },
  entity_linked: { domain: "casework", eventType: "case.entity_linked", action: "update" },
  reminder_changed: { domain: "casework", eventType: "case.reminder_changed", action: "update" },
  bargaining_changed: { domain: "casework", eventType: "case.bargaining_changed", action: "update" },
  // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917. The desk CSV
  // export receipt. It is the one casework kind whose action is a read of many
  // cases rather than a change to one, so it projects as `export`; the row it
  // comes from is not case-scoped (an export spans a selection or a filtered
  // slice), which is why it carries no case id.
  cases_exported: { domain: "casework", eventType: "case.cases_exported", action: "export" },
  macro_saved: { domain: "casework", eventType: "case.macro_saved", action: "create" },
  macro_applied: { domain: "casework", eventType: "case.macro_applied", action: "update" },
  note_added: { domain: "casework", eventType: "case.note_added", action: "create" },
  note_mentioned: { domain: "casework", eventType: "case.note_mentioned", action: "create" },
  case_assigned: { domain: "casework", eventType: "case.assigned", action: "update" },
  // REQ-UG-GRIEVANCE-PROCEDURE-STARTER-TEMPLATE-20261001: an admin loaded
  // the starter grievance procedure into the organization.
  procedure_starter_loaded: { domain: "casework", eventType: "case.procedure_starter_loaded", action: "create" },
  // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006:
  // staff renamed a case (closed reason code and lengths only).
  case_renamed: { domain: "casework", eventType: "case.renamed", action: "update" },
});

const SINK_PROJECTIONS = Object.freeze({
  coordinator_case_audit: Object.freeze({
    kinds: COORDINATOR_CASE_AUDIT_PROJECTION,
    entityType: "case",
    caseScoped: true,
  }),
  member_invitation_audit: Object.freeze({
    kinds: MEMBER_INVITATION_AUDIT_PROJECTION,
    entityType: "invitation",
    caseScoped: false,
  }),
  organization_automation_definition_reviews: Object.freeze({
    kinds: AUTOMATION_DEFINITION_REVIEW_PROJECTION,
    entityType: "automation_definition",
    caseScoped: false,
  }),
  member_case_assignment_audit: Object.freeze({
    kinds: MEMBER_CASE_ASSIGNMENT_AUDIT_PROJECTION,
    entityType: "case",
    caseScoped: true,
  }),
  casework_audit_events: Object.freeze({
    kinds: CASEWORK_AUDIT_EVENT_PROJECTION,
    entityType: "case",
    caseScoped: true,
  }),
});

// source -> the kinds its RPC accepts, in the same order the migration lists
// them. The panel's kind filter is built from this, so an option the database
// would refuse with 22023 can never be offered.
export const AUDIT_SINK_KINDS = Object.freeze(Object.fromEntries(
  AUDIT_SINK_SOURCES.map((source) => [source, Object.freeze(Object.keys(SINK_PROJECTIONS[source].kinds))]),
));

export function isAuditSinkKind(source, kind) {
  return Boolean(isAuditSinkSource(source) && AUDIT_SINK_KINDS[source].includes(kind));
}

export function auditSinkIsCaseScoped(source) {
  return Boolean(isAuditSinkSource(source) && SINK_PROJECTIONS[source].caseScoped);
}

export function projectAuditSinkRow(source, row) {
  if (!isAuditSinkSource(source) || !row || typeof row !== "object") return null;
  if (!isUuid(row.organizationId)) return null;
  const sink = SINK_PROJECTIONS[source];
  const mapped = sink.kinds[row.kind];
  if (!mapped) return null;
  const entityId = typeof row.entityId === "string" && row.entityId.length <= 128 ? row.entityId : null;
  return createAuditEvent({
    id: row.id ?? null,
    organizationId: row.organizationId,
    domain: mapped.domain,
    eventType: mapped.eventType,
    action: mapped.action,
    actorUserId: isUuid(row.actorUserId) ? row.actorUserId : null,
    entityType: sink.entityType,
    entityId,
    occurredAt: row.createdAt,
    idempotencyKey: safeIdempotencyKey(null, `${source}${row.id ?? row.kind}`),
    metadata: {
      organizationId: row.organizationId,
      ...(typeof row.chapterId === "string" ? { chapterId: row.chapterId } : {}),
      ...(isUuid(row.memberUserId) ? { userId: row.memberUserId } : {}),
    },
    source,
  });
}

export function projectAuditSinkRows(source, rows, selectedOrganizationId) {
  if (!isUuid(selectedOrganizationId) || !Array.isArray(rows)) return [];
  return rows
    .map((row) => projectAuditSinkRow(source, row))
    .filter((event) => event && event.organizationId === selectedOrganizationId);
}
