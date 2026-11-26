import { isQaOfficerRole } from "./contract.js";

export function qaFailure(code, message) {
  return { ok: false, code, message };
}

export function qaOk(value) {
  return { ok: true, value };
}

export function isActiveOrganizationMember(actor) {
  return Boolean(
    actor?.userId
    && actor.mfaSatisfied === true
    && actor.organizationId
    && actor.organizationStatus === "active"
    && actor.membershipStatus === "active"
    && actor.chapterId,
  );
}

export function officerRolesFor(actor) {
  const orgRoles = Array.isArray(actor?.organizationRoles) ? actor.organizationRoles : [];
  const chapterRoles = Array.isArray(actor?.chapterRoles) ? actor.chapterRoles : [];
  return [...new Set([...orgRoles, ...chapterRoles].filter(isQaOfficerRole))];
}

export function hasOfficerGrant(actor) {
  return officerRolesFor(actor).length > 0;
}

function hasOrganizationOfficerRole(actor) {
  const orgRoles = Array.isArray(actor?.organizationRoles) ? actor.organizationRoles : [];
  return orgRoles.some(isQaOfficerRole);
}

export function canAskQaQuestion(actor) {
  return isActiveOrganizationMember(actor);
}

export function canSearchQaHistory(actor) {
  return isActiveOrganizationMember(actor);
}

export function canVoteOnQa(actor) {
  return isActiveOrganizationMember(actor);
}

export function canFollowUpOnQa(actor) {
  return isActiveOrganizationMember(actor);
}

export function canOfficialReplyOnQa(actor, question) {
  if (!isActiveOrganizationMember(actor) || !hasOfficerGrant(actor)) return false;
  if (!question) return true;
  if (question.organizationId !== actor.organizationId) return false;
  if (hasOrganizationOfficerRole(actor)) return true;
  return question.chapterId === actor.chapterId;
}

export function canSeeOfficerQaQueue(actor) {
  return isActiveOrganizationMember(actor) && hasOfficerGrant(actor);
}

export function canAcceptQaAnswer(actor, question) {
  if (!isActiveOrganizationMember(actor) || !question) return false;
  if (question.organizationId !== actor.organizationId) return false;
  if ((question.authoredByMe === true || question.authorId === actor.userId) && question.chapterId === actor.chapterId) return true;
  return canOfficialReplyOnQa(actor, question);
}

// A reply projected by the server carries no organization or chapter of its
// own, so the parent question supplies that scope. A record that does carry its
// own scope is always judged on that scope, and a scope that cannot be resolved
// at all stays denied.
function resolveQaRecordScope(record, parent) {
  return {
    organizationId: record.organizationId ?? parent?.organizationId ?? null,
    chapterId: record.chapterId ?? parent?.chapterId ?? null,
  };
}

export function canModerateQa(actor, record, parent) {
  if (!isActiveOrganizationMember(actor) || !record) return false;
  const scope = resolveQaRecordScope(record, parent);
  if (!scope.organizationId || scope.organizationId !== actor.organizationId) return false;
  if (record.authoredByMe === true || record.authorId === actor.userId) {
    return !scope.chapterId || scope.chapterId === actor.chapterId;
  }
  return canOfficialReplyOnQa(actor, scope);
}

export function canSeeQaRecord(actor, record) {
  if (!isActiveOrganizationMember(actor) || !record) return false;
  if (record.organizationId !== actor.organizationId) return false;
  if (record.deletedAt) return false;
  if (hasOrganizationOfficerRole(actor)) return true;
  return record.chapterId === actor.chapterId;
}

export function requireActiveQaMember(actor) {
  if (!actor?.userId) return qaFailure("unauthenticated", "Sign in is required.");
  if (actor.mfaSatisfied !== true) return qaFailure("mfa_required", "Staff two-step is required.");
  if (!actor.organizationId || actor.organizationStatus !== "active") {
    return qaFailure("organization_required", "An active organization is required.");
  }
  if (actor.membershipStatus !== "active") {
    return qaFailure("membership_revoked", "Your access to this organization is not active.");
  }
  if (!actor.chapterId) return qaFailure("chapter_required", "A selected campaign is required.");
  return qaOk(actor);
}
