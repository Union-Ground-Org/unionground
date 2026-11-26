// Frozen MI1 organization-scope contract for later feature and integration
// lanes. This module is documentation-as-code: it names the database surface
// without calling it. Do not put service-role secrets, generated types, or
// memberApi writes here.

export const ORGANIZATION_BOOTSTRAP_RPC = "bootstrap_first_organization";

export const ORGANIZATION_ROLE_RPC = "set_member_organization_role";

export const ORGANIZATION_STATUSES = Object.freeze(["active", "suspended", "archived"]);

export const ORGANIZATION_MEMBERSHIP_STATUSES = Object.freeze(["active", "revoked"]);

export const ORGANIZATION_ROLES = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

export const BROADCAST_AUDIENCE_SCOPES = Object.freeze(["chapter", "organization"]);

export const CHAPTER_RECORD_MEMBER_TYPES = Object.freeze(["minutes", "decision", "milestone"]);

export const CHAPTER_RECORD_STAFF_TYPES = Object.freeze(["member_contact", "management_contact"]);

export const ORGANIZATION_AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "chapterId",
  "slug",
  "name",
  "role",
  "userId",
  "status",
  "requireStaffMfa",
]);

export function isOrganizationRole(role) {
  return ORGANIZATION_ROLES.includes(role);
}

export function isBroadcastAudienceScope(scope) {
  return BROADCAST_AUDIENCE_SCOPES.includes(scope);
}
