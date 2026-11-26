// Organization-scoped audit authorization. The selected tenant is the only
// authority; a caller-supplied organization id is never a wildcard.

import { AUDIT_SOURCES, isAuditSinkSource, isUuid } from "./auditEnvelope.js";
import { auditSinkIsCaseScoped, isAuditSinkKind } from "./auditProjection.js";

export const AUDIT_READER_ROLES = Object.freeze(["admin"]);
const AUDIT_WRITER_KINDS = Object.freeze(["definer", "service_bootstrap"]);

function sameOrganization(left, right) {
  return isUuid(left) && isUuid(right) && left === right;
}

function sessionIsActive(session = {}) {
  return session.authenticated === true
    && session.mfaSatisfied === true
    && session.membershipStatus === "active"
    && session.organizationStatus === "active"
    && isUuid(session.selectedOrganizationId);
}

export function canReadOrganizationAudit(session = {}, event = {}) {
  if (!sessionIsActive(session)) return false;
  if (!AUDIT_READER_ROLES.includes(session.role)) return false;
  if (!isUuid(event.organizationId)) return false;
  return sameOrganization(session.selectedOrganizationId, event.organizationId);
}

export function canWriteOrganizationAudit(session = {}, event = {}) {
  if (!AUDIT_WRITER_KINDS.includes(session.actorKind)) return false;
  if (!isUuid(event.organizationId)) return false;
  if (session.actorKind === "service_bootstrap") {
    return session.bootstrapOrganizationId === event.organizationId;
  }
  return sessionIsActive(session)
    && sameOrganization(session.selectedOrganizationId, event.organizationId);
}

export function canClientInsertAudit() {
  return false;
}

export function authorizeAuditQuery(session = {}, requestedOrganizationId) {
  if (!sessionIsActive(session)) return { ok: false, reason: "session_inactive" };
  if (!AUDIT_READER_ROLES.includes(session.role)) return { ok: false, reason: "role_denied" };
  if (requestedOrganizationId != null && requestedOrganizationId !== session.selectedOrganizationId) {
    return { ok: false, reason: "organization_mismatch" };
  }
  return { ok: true, organizationId: session.selectedOrganizationId };
}

export function filterAuditEventsForViewer(session, events = []) {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => canReadOrganizationAudit(session, event));
}


// ---------------------------------------------------------------------------
// Per-source read authority for the five dormant sinks.
//
// The browser gate is deliberately no wider than the database gate the RPCs
// enforce, and it is never the authority: the definer functions re-derive the
// organization from the session and re-apply the tables' own predicates. This
// exists so the panel does not offer a source the caller will only be refused,
// and so an unknown source or kind never reaches the wire.
// ---------------------------------------------------------------------------

export const AUDIT_SOURCE_READER_ROLES = Object.freeze({
  organization_audit_ledger: Object.freeze(["admin"]),
  coordinator_case_audit: Object.freeze(["coordinator", "advisor", "admin", "vp"]),
  member_invitation_audit: Object.freeze(["admin"]),
  organization_automation_definition_reviews: Object.freeze(["admin", "vp"]),
  member_case_assignment_audit: Object.freeze(["coordinator", "advisor", "admin", "vp"]),
  casework_audit_events: Object.freeze(["coordinator", "advisor", "admin", "vp"]),
});

function isIsoInstant(value) {
  return typeof value === "string" && value.length >= 10 && !Number.isNaN(Date.parse(value));
}

export function auditSourcesForViewer(session = {}) {
  if (!sessionIsActive(session)) return [];
  return AUDIT_SOURCES.filter((source) => AUDIT_SOURCE_READER_ROLES[source].includes(session.role));
}

export function canReadAuditSource(session = {}, source) {
  return auditSourcesForViewer(session).includes(source);
}

// Validates one sink page request. Returns the organization the caller is
// actually scoped to; the caller never supplies it.
export function authorizeAuditSinkQuery(session = {}, source, filters = {}) {
  if (!isAuditSinkSource(source)) return { ok: false, reason: "unknown_source" };
  if (!sessionIsActive(session)) return { ok: false, reason: "session_inactive" };
  if (!canReadAuditSource(session, source)) return { ok: false, reason: "role_denied" };
  if (filters.kind != null && !isAuditSinkKind(source, filters.kind)) {
    return { ok: false, reason: "unknown_kind" };
  }
  if (filters.since != null && !isIsoInstant(filters.since)) return { ok: false, reason: "invalid_date_range" };
  if (filters.until != null && !isIsoInstant(filters.until)) return { ok: false, reason: "invalid_date_range" };
  if (filters.since != null && filters.until != null && Date.parse(filters.since) > Date.parse(filters.until)) {
    return { ok: false, reason: "invalid_date_range" };
  }
  if (filters.caseId != null && (!auditSinkIsCaseScoped(source) || !isUuid(filters.caseId))) {
    return { ok: false, reason: "case_scope_unavailable" };
  }
  return { ok: true, organizationId: session.selectedOrganizationId, source };
}
