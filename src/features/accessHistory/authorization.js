import { ORGANIZATION_ROLES } from "../tenancy/organizationScope.js";
import { accessFailure } from "./errors.js";

export const ACCESS_CAPABILITIES = Object.freeze(["read_own", "record"]);

export const ACCESS_RECORD_ROLES = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

function hasActiveMembership(actor) {
  return Boolean(actor)
    && actor.membershipStatus === "active"
    && typeof actor.selectedOrganizationId === "string"
    && actor.selectedOrganizationId.length > 0
    && typeof actor.userId === "string"
    && actor.userId.length > 0;
}

function hasStaffRecordGrant(actor) {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  return roles.some((role) => ACCESS_RECORD_ROLES.includes(role) && ORGANIZATION_ROLES.includes(role));
}

export function authorizeAccessHistory({ actor, organizationId, capability, subjectUserId = null }) {
  if (!ACCESS_CAPABILITIES.includes(capability)) {
    return accessFailure("unauthorized", { capability });
  }
  if (!actor || typeof actor !== "object") return accessFailure("missing_actor");
  if (!actor.selectedOrganizationId || !organizationId) return accessFailure("empty_organization");
  if (organizationId !== actor.selectedOrganizationId) return accessFailure("wrong_organization");
  if (!hasActiveMembership(actor)) return accessFailure("membership_inactive");

  if (capability === "read_own") {
    if (subjectUserId && subjectUserId !== actor.userId) {
      return accessFailure("unauthorized", { capability });
    }
    return { ok: true, organizationId, capability, subjectUserId: actor.userId };
  }

  if (!hasStaffRecordGrant(actor)) return accessFailure("unauthorized", { capability });
  if (!subjectUserId || subjectUserId === actor.userId) {
    return accessFailure("invalid_input", { field: "subjectUserId" });
  }
  return { ok: true, organizationId, capability, subjectUserId };
}
