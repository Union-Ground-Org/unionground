// Frozen operations RPCs and payload shaping. This module names the
// integration surface without calling it. Browser code must never receive a
// service-role key or write audit rows through a table grant.

export const OPERATIONS_RPCS = Object.freeze({
  listAudit: "list_organization_audit_ledger",
  recordAudit: "record_organization_audit_event",
  listJobHealth: "list_organization_job_health",
  acknowledgeJob: "acknowledge_organization_job_run",
  requestJobRetry: "request_organization_job_retry",
  // REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: the
  // display names of the ledger's actors, for an organization administrator.
  listActorNames: "list_organization_audit_actor_names",
});

export const OPERATIONS_TABLES = Object.freeze([
  "organization_audit_ledger",
  "organization_job_runs",
  "organization_job_acknowledgements",
]);

export const EXISTING_AUDIT_SOURCES = Object.freeze([
  "member_admin_audit",
  "organization_audit_events",
]);

// The five sinks that had no reader before
// 20260917090000_dormant_audit_sinks_read_rpcs.sql. Each entry is the paged
// SECURITY DEFINER reader for exactly one existing append-only table; none of
// them writes, and none of them takes an organization argument.
export const AUDIT_SINK_RPCS = Object.freeze({
  coordinator_case_audit: "list_coordinator_case_audit",
  member_invitation_audit: "list_member_invitation_audit",
  organization_automation_definition_reviews: "list_organization_automation_definition_reviews",
  member_case_assignment_audit: "list_member_case_assignment_audit",
  casework_audit_events: "list_casework_audit_events",
});

export const AUDIT_SINK_TABLES = Object.freeze(Object.keys(AUDIT_SINK_RPCS));

export function auditSinkRpc(source) {
  return Object.hasOwn(AUDIT_SINK_RPCS, source) ? AUDIT_SINK_RPCS[source] : null;
}

export function isOperationsRpc(name) {
  return Object.values(OPERATIONS_RPCS).includes(name)
    || Object.values(AUDIT_SINK_RPCS).includes(name);
}

export function clientMayCallRpc(name) {
  return name === OPERATIONS_RPCS.listAudit
    || name === OPERATIONS_RPCS.listActorNames
    || name === OPERATIONS_RPCS.listJobHealth
    || name === OPERATIONS_RPCS.acknowledgeJob
    || name === OPERATIONS_RPCS.requestJobRetry
    // Sink readers are reads only; recordAudit stays off the browser surface.
    || Object.values(AUDIT_SINK_RPCS).includes(name);
}

export function clientMayCallRecordAudit() {
  return false;
}

export function shapeAuditListRequest(session, filters = {}) {
  const before = filters.before && typeof filters.before === "object"
    ? filters.before
    : { occurredAt: filters.before, id: filters.beforeId };
  return Object.freeze({
    p_limit: clampLimit(filters.limit, 50),
    p_before: before.occurredAt ?? null,
    p_before_id: before.id ?? null,
    p_domain: filters.domain ?? null,
    p_action: filters.action ?? null,
    organizationId: session.selectedOrganizationId,
  });
}

// The sink readers share one keyset page shape. `organizationId` rides along
// for the caller's own scope assertions; it is not sent to the database, which
// derives the organization from the session itself.
export function shapeAuditSinkRequest(session, source, filters = {}) {
  const before = filters.before && typeof filters.before === "object"
    ? filters.before
    : { occurredAt: filters.before ?? null, id: filters.beforeId ?? null };
  const cursorComplete = before.occurredAt != null && before.id != null;
  return Object.freeze({
    p_limit: clampLimit(filters.limit, 50),
    p_before: cursorComplete ? before.occurredAt : null,
    p_before_id: cursorComplete ? before.id : null,
    p_kind: filters.kind ?? null,
    p_since: filters.since ?? null,
    p_until: filters.until ?? null,
    ...(filters.caseId != null ? { p_case_id: filters.caseId } : {}),
    source,
    organizationId: session.selectedOrganizationId,
  });
}

export function shapeJobHealthRequest(session) {
  return Object.freeze({
    organizationId: session.selectedOrganizationId,
  });
}

export function shapeJobRemediationRequest(session, command) {
  return Object.freeze({
    p_job_name: command.jobName,
    p_run_id: command.runId,
    organizationId: session.selectedOrganizationId,
    executesJob: false,
  });
}

function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 200));
}
