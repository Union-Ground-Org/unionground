// Job-health visibility and remediations follow the same selected-tenant
// admin gate as the unified audit reader.

import { isUuid } from "./auditEnvelope.js";
import { AUDIT_READER_ROLES } from "./auditAuthorization.js";
import { getProductJob } from "./jobRegistry.js";

function sessionIsActiveAdmin(session = {}) {
  return session.authenticated === true
    && session.mfaSatisfied === true
    && session.membershipStatus === "active"
    && session.organizationStatus === "active"
    && isUuid(session.selectedOrganizationId)
    && AUDIT_READER_ROLES.includes(session.role);
}

export function canReadJobHealth(session = {}) {
  return sessionIsActiveAdmin(session);
}

export function authorizeJobQuery(session = {}, requestedOrganizationId) {
  if (!sessionIsActiveAdmin(session)) {
    return { ok: false, reason: session.role && session.authenticated ? "role_denied" : "session_inactive" };
  }
  if (requestedOrganizationId != null && requestedOrganizationId !== session.selectedOrganizationId) {
    return { ok: false, reason: "organization_mismatch" };
  }
  return { ok: true, organizationId: session.selectedOrganizationId };
}

export function authorizeJobRemediation(session = {}, command = {}) {
  const query = authorizeJobQuery(session, command.organizationId);
  if (!query.ok) return query;
  if (!getProductJob(command.jobName)) return { ok: false, reason: "unknown_job" };
  if (typeof command.runId !== "string" || !command.runId) return { ok: false, reason: "run_required" };
  if (!["acknowledge", "request_retry"].includes(command.remediation)) {
    return { ok: false, reason: "unknown_remediation" };
  }
  return {
    ok: true,
    organizationId: session.selectedOrganizationId,
    executesJob: false,
  };
}

export function filterJobRunsForViewer(session, runs = []) {
  if (!canReadJobHealth(session) || !Array.isArray(runs)) return [];
  return runs.filter((run) => {
    if (!run) return false;
    if (run.organizationId && run.organizationId !== session.selectedOrganizationId) return false;
    return true;
  });
}
