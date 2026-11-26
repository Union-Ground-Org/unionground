function sortedRoleNames(group) {
  return [...new Set(Array.isArray(group) ? group : [])].map(String).sort();
}

/**
 * Stable authorization identity for workspace load effects.
 *
 * Same class as the inline DuesView actorKey from
 * BUG-UG-DUES-VIEW-LOAD-EFFECT-ACTOR-IDENTITY-REFETCH-20260908. That view
 * is left unchanged; new surfaces should key loads on this helper instead of
 * actor object identity.
 */
export function featureActorIdentityKey(actor) {
  // Mirror the normalizers' precedence (normalizeMemberOperationsActor):
  // the selected organization wins over the ambient one, and an explicit
  // organizationRoles list is authoritative over the flattened roles list,
  // so a scope switch or a grant/revocation that leaves the other alias
  // unchanged still produces a new key.
  const organizationRoles = Array.isArray(actor?.organizationRoles)
    ? sortedRoleNames(actor.organizationRoles)
    : sortedRoleNames(actor?.roles);
  return JSON.stringify([
    actor?.userId || actor?.id || null,
    actor?.selectedOrganizationId || actor?.organizationId || null,
    actor?.chapterId || null,
    actor?.selectedHat || null,
    organizationRoles,
    sortedRoleNames(actor?.chapterRoles),
    actor?.membershipStatus || null,
    actor?.requireStaffMfa === true,
    actor?.hasSecondFactor === true,
    actor?.mfaSatisfied === true,
  ]);
}
