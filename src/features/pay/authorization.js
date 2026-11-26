import { ORGANIZATION_ROLES } from "../tenancy/organizationScope.js";
import { payFailure } from "./errors.js";

export const PAY_CAPABILITIES = Object.freeze(["read_catalog", "calculate", "compare", "write_catalog"]);

export const PAY_WRITE_ROLES = Object.freeze(["advisor", "admin", "vp"]);

export const PAY_AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "grade",
  "stepNumber",
  "effectiveOn",
  "action",
]);

function hasActiveMembership(actor) {
  return Boolean(actor)
    && actor.membershipStatus === "active"
    && typeof actor.selectedOrganizationId === "string"
    && actor.selectedOrganizationId.length > 0;
}

function hasStaffWriteGrant(actor) {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  return roles.some((role) => PAY_WRITE_ROLES.includes(role) && ORGANIZATION_ROLES.includes(role));
}

export function authorizePay({ actor, organizationId, capability }) {
  if (!PAY_CAPABILITIES.includes(capability)) {
    return payFailure("unauthorized", { capability });
  }
  if (!actor || typeof actor !== "object") {
    return payFailure("missing_actor");
  }
  if (!actor.selectedOrganizationId) {
    return payFailure("empty_organization");
  }
  if (!organizationId) {
    return payFailure("empty_organization");
  }
  if (organizationId !== actor.selectedOrganizationId) {
    return payFailure("wrong_organization");
  }
  if (!hasActiveMembership(actor)) {
    return payFailure("membership_inactive");
  }
  if (capability === "write_catalog" && !hasStaffWriteGrant(actor)) {
    return payFailure("unauthorized", { capability });
  }
  return { ok: true, organizationId, capability };
}
