const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTOMATION_AUTHOR_ROLES = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

export const AUTOMATION_APPROVER_ROLES = Object.freeze(["admin", "vp"]);

const denied = (reason, organizationId = null) => Object.freeze({
  connected: false,
  canAuthor: false,
  canApprove: false,
  canOperate: false,
  reason,
  organizationId,
});

export function automationAccess(session = {}) {
  const organizationId = typeof session.selectedOrganizationId === "string" && UUID.test(session.selectedOrganizationId)
    ? session.selectedOrganizationId
    : null;
  const active = session.authenticated === true
    && organizationId !== null
    && session.membershipStatus === "active"
    && session.organizationStatus === "active";

  if (!active) return denied("session_inactive");
  if (session.mfaSatisfied !== true) return denied("mfa_required", organizationId);

  const selectedHat = session.selectedHat ?? null;
  const role = selectedHat === null || session.role === selectedHat ? session.role : null;
  if (!AUTOMATION_AUTHOR_ROLES.includes(role)) return denied("role_denied", organizationId);

  const approver = AUTOMATION_APPROVER_ROLES.includes(role);
  return Object.freeze({
    connected: true,
    canAuthor: true,
    canApprove: approver,
    canOperate: approver,
    reason: null,
    organizationId,
  });
}
