import { ORGANIZATION_ROLES } from "../tenancy/organizationScope.js";
import { calendarFreeBusyFailure } from "./errors.js";

export const CALENDAR_FREEBUSY_CAPABILITIES = Object.freeze(["read", "request", "manage"]);

export const CALENDAR_FREEBUSY_REQUEST_ROLES = Object.freeze(["steward"]);

export const CALENDAR_FREEBUSY_MANAGE_ROLES = Object.freeze(["admin", "vp"]);

export const CALENDAR_FREEBUSY_AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "provider",
  "action",
  "status",
]);

function hasActiveMembership(actor) {
  return Boolean(actor)
    && actor.membershipStatus === "active"
    && typeof actor.selectedOrganizationId === "string"
    && actor.selectedOrganizationId.length > 0;
}

function hasRole(actor, allowed) {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  return roles.some((role) => allowed.includes(role) && ORGANIZATION_ROLES.includes(role));
}

export function authorizeCalendarFreeBusy({ actor, organizationId, capability }) {
  if (!CALENDAR_FREEBUSY_CAPABILITIES.includes(capability)) {
    return calendarFreeBusyFailure("unauthorized", { capability });
  }
  if (!actor || typeof actor !== "object") {
    return calendarFreeBusyFailure("missing_actor");
  }
  if (!actor.selectedOrganizationId || !organizationId) {
    return calendarFreeBusyFailure("empty_organization");
  }
  if (organizationId !== actor.selectedOrganizationId) {
    return calendarFreeBusyFailure("wrong_organization");
  }
  if (!hasActiveMembership(actor)) {
    return calendarFreeBusyFailure("unauthorized");
  }
  if (capability === "manage" && !hasRole(actor, CALENDAR_FREEBUSY_MANAGE_ROLES)) {
    return calendarFreeBusyFailure("unauthorized");
  }
  if (capability === "request" && !hasRole(actor, CALENDAR_FREEBUSY_REQUEST_ROLES)
      && !hasRole(actor, CALENDAR_FREEBUSY_MANAGE_ROLES)) {
    return calendarFreeBusyFailure("unauthorized");
  }
  return { ok: true, organizationId, capability };
}
