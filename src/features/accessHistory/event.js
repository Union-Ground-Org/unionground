export const ACCESS_ACTIONS = Object.freeze([
  "viewed_profile",
  "viewed_case",
  "updated_profile",
  "updated_case",
  "granted_role",
  "revoked_role",
]);

export const ACCESS_ENTITY_TYPES = Object.freeze(["member", "case", "role_grant"]);

// record_member_access_event accepts only this narrower write vocabulary; the
// role-grant values above are synthesised by list_my_access_history for reads.
export const RECORDABLE_ACCESS_ACTIONS = Object.freeze([
  "viewed_profile",
  "viewed_case",
  "updated_profile",
  "updated_case",
]);

export const RECORDABLE_ACCESS_ENTITY_TYPES = Object.freeze(["member", "case"]);

export function isRecordableAccessWrite(record) {
  return RECORDABLE_ACCESS_ACTIONS.includes(record?.action)
    && RECORDABLE_ACCESS_ENTITY_TYPES.includes(record?.entityType);
}

function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || hasControlChars(trimmed)) return null;
  return trimmed;
}

export function normalizeAccessEvent(record) {
  if (!record || typeof record !== "object") return null;
  const organizationId = boundedText(record.organizationId, 80);
  const subjectUserId = boundedText(record.subjectUserId, 80);
  const actorUserId = boundedText(record.actorUserId, 80) || "staff";
  const action = ACCESS_ACTIONS.includes(record.action) ? record.action : null;
  const entityType = ACCESS_ENTITY_TYPES.includes(record.entityType) ? record.entityType : null;
  const occurredAt = boundedText(record.occurredAt, 40);
  if (!organizationId || !subjectUserId || !action || !entityType || !occurredAt) {
    return null;
  }
  if (actorUserId !== "staff" && subjectUserId === actorUserId) return null;

  const actorRole = boundedText(record.actorRole, 32) || "staff";
  const actorLabel = boundedText(record.actorLabel, 80) || actorRole;
  if (actorLabel.includes(String.fromCharCode(64))) return null;

  return {
    id: boundedText(record.id, 80),
    organizationId,
    subjectUserId,
    actorUserId,
    actorRole,
    actorLabel,
    action,
    entityType,
    entityId: record.entityId == null || record.entityId === "" ? null : boundedText(String(record.entityId), 80),
    occurredAt,
    // 20261008061000: the feed says when the caller made a role change
    // themselves, without ever returning another user's id.
    actorIsSelf: record.actorIsSelf === true,
  };
}
