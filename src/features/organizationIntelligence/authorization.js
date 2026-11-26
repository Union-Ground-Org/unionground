import {
  COLLECTIVE_ACTION_EXPORT_HATS,
  COLLECTIVE_ACTION_MANAGER_HATS,
  ORGANIZATION_INTELLIGENCE_STAFF_HATS,
  ORGANIZATION_INTELLIGENCE_WRITE_HATS,
} from "./contract.js";

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

export function normalizeOrganizationIntelligenceActor(actor = {}) {
  const organizationId = actor.organizationId || actor.selectedOrganizationId || null;
  const selectedHat = actor.selectedHat || "member";
  return Object.freeze({
    userId: actor.userId || null,
    organizationId,
    chapterId: actor.chapterId || null,
    selectedHat,
    organizationRoles: Object.freeze(unique(actor.organizationRoles || actor.roles)),
    membershipStatus: actor.membershipStatus || (organizationId ? "active" : "inactive"),
    mfaSatisfied: actor.mfaSatisfied === true,
  });
}

function activeMember(actor) {
  return Boolean(actor.userId && actor.organizationId && actor.membershipStatus === "active");
}

function selectedGrantedHat(actor, allowedHats) {
  return allowedHats.includes(actor.selectedHat)
    && actor.organizationRoles.includes(actor.selectedHat);
}

function authorizeOrganization(actor, snapshotOrganizationId) {
  if (!actor.organizationId) return { ok: false, state: "empty", reason: "no_organization", actor };
  if (!activeMember(actor)) return { ok: false, state: "unauthorized", reason: "inactive_membership", actor };
  if (snapshotOrganizationId && snapshotOrganizationId !== actor.organizationId) {
    return { ok: false, state: "unauthorized", reason: "cross_organization", actor };
  }
  return { ok: true, state: "ready", reason: null, actor };
}

export function authorizeOrganizationIntelligence(actor, snapshotOrganizationId = null) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  const organization = authorizeOrganization(normalized, snapshotOrganizationId);
  if (!organization.ok) return organization;
  if (!selectedGrantedHat(normalized, ORGANIZATION_INTELLIGENCE_STAFF_HATS)) {
    return { ok: false, state: "unauthorized", reason: "staff_grant_required", actor: normalized };
  }
  return organization;
}

export function canWriteOrganizationIntelligence(actor) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  return activeMember(normalized)
    && normalized.mfaSatisfied
    && selectedGrantedHat(normalized, ORGANIZATION_INTELLIGENCE_WRITE_HATS);
}

export function authorizeCollectiveActions(actor, snapshotOrganizationId = null) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  return authorizeOrganization(normalized, snapshotOrganizationId);
}

export function canManageCollectiveActions(actor) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  return activeMember(normalized)
    && normalized.mfaSatisfied
    && selectedGrantedHat(normalized, COLLECTIVE_ACTION_MANAGER_HATS);
}

// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: the goal
// breakdown is for an organization administrator wearing the Admin hat
// (get_digital_action_goal_breakdown admits only an organization-wide admin
// grant), narrower than the participant export.
export function canViewCollectiveActionGoalBreakdown(actor) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  return activeMember(normalized) && normalized.mfaSatisfied && selectedGrantedHat(normalized, ["admin"]);
}

export function canExportCollectiveActionParticipants(actor) {
  const normalized = normalizeOrganizationIntelligenceActor(actor);
  return activeMember(normalized)
    && normalized.mfaSatisfied
    && selectedGrantedHat(normalized, COLLECTIVE_ACTION_EXPORT_HATS);
}
