import { ORGANIZATION_ROLES } from "../tenancy/organizationScope.js";

export const INTEGRATION_MANAGER_ROLES = Object.freeze(["admin", "vp"]);

export function createActor(input = {}) {
  const {
  userId,
  selectedOrganizationId,
  chapterId = null,
  roles = [],
  organizationRoles,
  chapterRoles = [],
  selectedHat = null,
  membershipStatus = "active",
  mfaSatisfied = false,
  } = input;
  const uniqueRoles = [...new Set(roles)].filter((role) => ORGANIZATION_ROLES.includes(role));
  // Legacy pure-domain callers that omit the field retain their historical
  // organization-wide role input. An explicit empty list remains empty, so
  // chapter-only callers cannot elevate through `roles`.
  const organizationRoleInput = Array.isArray(organizationRoles) ? organizationRoles : roles;
  const uniqueOrganizationRoles = [...new Set(organizationRoleInput)].filter((role) => ORGANIZATION_ROLES.includes(role));
  const uniqueChapterRoles = [...new Set(chapterRoles)].filter((role) => ORGANIZATION_ROLES.includes(role));
  return Object.freeze({
    userId: userId || null,
    selectedOrganizationId: selectedOrganizationId || null,
    chapterId: chapterId || null,
    roles: Object.freeze(uniqueRoles),
    organizationRoles: Object.freeze(uniqueOrganizationRoles),
    chapterRoles: Object.freeze(uniqueChapterRoles),
    selectedHat: selectedHat || null,
    membershipStatus,
    mfaSatisfied: Boolean(mfaSatisfied),
  });
}

export function canManageIntegrations(actor) {
  if (!actor?.userId || !actor.selectedOrganizationId) return false;
  if (actor.membershipStatus !== "active") return false;
  if (!actor.mfaSatisfied) return false;
  if (actor.selectedHat && !INTEGRATION_MANAGER_ROLES.includes(actor.selectedHat)) return false;
  return (actor.organizationRoles || []).some((role) => INTEGRATION_MANAGER_ROLES.includes(role));
}

export function authorizeOrganizationWrite(actor, requestedOrganizationId) {
  if (!canManageIntegrations(actor)) {
    return { ok: false, reason: "unauthorized" };
  }
  if (requestedOrganizationId && requestedOrganizationId !== actor.selectedOrganizationId) {
    return { ok: false, reason: "cross_organization_denied" };
  }
  return { ok: true, organizationId: actor.selectedOrganizationId };
}

export function boundedAuditEvent({
  organizationId,
  actorId,
  action,
  entityType,
  entityId = null,
  metadata = {},
  occurredAt,
}) {
  const allowlisted = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (typeof value === "string" && value.length <= 120) allowlisted[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") allowlisted[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 64)) {
      allowlisted[key] = value.slice(0, 12);
    }
  }
  return Object.freeze({
    organizationId,
    actorId,
    action,
    entityType,
    entityId,
    metadata: Object.freeze(allowlisted),
    occurredAt,
  });
}
