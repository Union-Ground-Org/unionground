// CR-106 immutable audit envelope. Later lanes emit through this contract.
// Writes stay organization-scoped, append-only, and metadata-bounded.
// Do not put service-role secrets, generated types, or memberApi calls here.

export const AUDIT_METADATA_MAX_BYTES = 2048;

export const AUDIT_DOMAINS = Object.freeze([
  "administration",
  "casework",
  "messages",
  "data_access",
  "community_events",
  "security",
  "membership",
  "communications",
  "knowledge",
  "operations",
  "exports",
  "rewards",
]);

export const AUDIT_ACTIONS = Object.freeze([
  "create",
  "update",
  "delete",
  "read",
  "export",
  "grant",
  "revoke",
  "send",
  "settings_change",
  "login",
  "acknowledge",
  "retry_requested",
]);

export const AUDIT_ENTITY_TYPES = Object.freeze([
  "organization",
  "chapter",
  "membership",
  "role_grant",
  "member",
  "case",
  "message",
  "event",
  "campaign",
  "broadcast",
  "invitation",
  "export",
  "document",
  "reward",
  "job_run",
  "security_policy",
  "audit_event",
  "automation_definition",
]);

// The five audit sinks that CR-106 named but never read. Each is an existing
// append-only table; nothing here creates a new writer.
export const AUDIT_SINK_SOURCES = Object.freeze([
  "coordinator_case_audit",
  "member_invitation_audit",
  "organization_automation_definition_reviews",
  "member_case_assignment_audit",
  "casework_audit_events",
]);

// Every source the organization audit surface can read, ledger first.
export const AUDIT_SOURCES = Object.freeze([
  "organization_audit_ledger",
  ...AUDIT_SINK_SOURCES,
]);

export function isAuditSource(value) {
  return AUDIT_SOURCES.includes(value);
}

export function isAuditSinkSource(value) {
  return AUDIT_SINK_SOURCES.includes(value);
}

export const AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "chapterId",
  "slug",
  "name",
  "role",
  "userId",
  "status",
  "requireStaffMfa",
  "entityType",
  "entityId",
  "fromStatus",
  "toStatus",
  "fromRole",
  "toRole",
  "action",
  "eventType",
  "domain",
  "jobName",
  "runId",
  "remediation",
  "outcome",
  "count",
  "fieldsChanged",
  "reasonCode",
  "exportType",
  "cadence",
]);

export const AUDIT_PROTECTED_METADATA_KEYS = Object.freeze([
  "email",
  "personalEmail",
  "phone",
  "address",
  "ip",
  "ipAddress",
  "body",
  "message",
  "notes",
  "content",
  "fileName",
  "title",
  "old",
  "new",
  "before",
  "after",
  "row",
  "details",
]);

export const AUDIT_EVENT_TYPES = Object.freeze({
  administration: Object.freeze([
    "organization.bootstrapped",
    "chapter.created",
    "chapter.updated",
    "invitation.created",
    "settings.changed",
    "label.overridden",
    "invitation.sent",
    "invitation.delivery_failed",
    "invitation.resent",
    "invitation.revoked",
    "invitation.claimed",
    "invitation.accepted",
    "invitation.expired",
    "invitation.reinvite_requested",
    "invitation.reinvite_accepted",
    "invitation.role_cleared",
    "automation_definition.submitted",
    "automation_definition.approved",
    "automation_definition.changes_requested",
  ]),
  casework: Object.freeze([
    "case.created",
    "case.status_changed",
    "case.step_advanced",
    "case.assigned",
    "case.restricted",
    "case.exported",
    "case.updated",
    "case.note_added",
    "case.contact_logged",
    "case.outcome_recorded",
    "case.reassigned",
    "case.unassigned",
    "case.strength_scored",
    "case.deadline_created",
    "case.deadline_requested",
    "case.deadline_decided",
    "case.checklist_created",
    "case.checklist_item_changed",
    "case.access_granted",
    "case.access_revoked",
    "case.alert_created",
    "case.alert_acknowledged",
    "case.alert_escalated",
    "case.behavior_logged",
    "case.behavior_addendum_added",
    "case.retaliation_submitted",
    "case.retaliation_withdrawn",
    "case.pattern_detected",
    "case.pattern_reviewed",
    "case.draft_saved",
    "case.bulk_updated",
    "case.entity_linked",
    "case.reminder_changed",
    "case.bargaining_changed",
    "case.cases_exported",
    "case.macro_saved",
    "case.macro_applied",
    "case.note_mentioned",
    "case.procedure_starter_loaded",
    "case.renamed",
  ]),
  messages: Object.freeze([
    "message.sent",
    "message.removed",
    "message.restored",
  ]),
  data_access: Object.freeze([
    "member.viewed",
    "case.viewed",
    "export.requested",
    "export.downloaded",
  ]),
  community_events: Object.freeze([
    "event.created",
    "event.updated",
    "event.cancelled",
    "event.restored",
    "event.deleted",
  ]),
  security: Object.freeze([
    "mfa.reset",
    "mfa.policy_changed",
    "signin.recovered",
    "signin.recovery_failed",
    "session.revoked",
  ]),
  membership: Object.freeze([
    "membership.granted",
    "membership.revoked",
    "role.granted",
    "role.revoked",
  ]),
  communications: Object.freeze([
    "broadcast.published",
    "campaign.created",
    "campaign.updated",
    "campaign.published",
    "campaign.closed",
    "email.intake_reviewed",
  ]),
  knowledge: Object.freeze([
    "document.uploaded",
    "document.downloaded",
  ]),
  operations: Object.freeze([
    "job.run_acknowledged",
    "job.retry_requested",
  ]),
  exports: Object.freeze([
    "export.generated",
    "export.expired",
  ]),
  rewards: Object.freeze([
    "reward.claimed",
    "reward.granted",
    "reward.revoked",
    "reward.fulfilled",
  ]),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isAuditDomain(value) {
  return AUDIT_DOMAINS.includes(value);
}

export function isAuditAction(value) {
  return AUDIT_ACTIONS.includes(value);
}

export function isAuditEntityType(value) {
  return AUDIT_ENTITY_TYPES.includes(value);
}

export function isAuditEventType(domain, eventType) {
  return Boolean(isAuditDomain(domain) && AUDIT_EVENT_TYPES[domain]?.includes(eventType));
}

export function looksLikeRowImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["old", "new", "before", "after", "row"].some((key) => Object.hasOwn(value, key));
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

function assertPrimitiveMetadataValue(key, value) {
  if (value == null) return;
  if (key === "fieldsChanged") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 64)) {
      throw new Error("audit metadata fieldsChanged must be short field names");
    }
    if (value.length > 24) throw new Error("audit metadata fieldsChanged is too large");
    return;
  }
  if (key === "count") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      throw new Error("audit metadata count is out of bounds");
    }
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value !== "string" || value.length > 128) {
    throw new Error(`audit metadata ${key} must be a short string`);
  }
}

export function sanitizeAuditMetadata(metadata = {}) {
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("audit metadata must be an object");
  }
  if (looksLikeRowImage(metadata)) {
    throw new Error("audit metadata must not carry row images");
  }

  const incomingKeys = Object.keys(metadata);
  const protectedHit = incomingKeys.find((key) => AUDIT_PROTECTED_METADATA_KEYS.includes(key));
  if (protectedHit) {
    throw new Error(`audit metadata rejects protected key ${protectedHit}`);
  }

  const unknown = incomingKeys.filter((key) => !AUDIT_METADATA_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`audit metadata rejects unknown key ${unknown[0]}`);
  }

  const sanitized = {};
  for (const key of AUDIT_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key)) continue;
    const value = metadata[key];
    assertPrimitiveMetadataValue(key, value);
    sanitized[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }

  if (utf8ByteLength(JSON.stringify(sanitized)) > AUDIT_METADATA_MAX_BYTES) {
    throw new Error("audit metadata exceeds the 2048-byte bound");
  }

  return Object.freeze(sanitized);
}

export function createAuditEvent(input) {
  if (!input || typeof input !== "object") throw new Error("audit event is required");
  if (!isUuid(input.organizationId)) throw new Error("audit event requires an organization id");
  if (!isAuditDomain(input.domain)) throw new Error("audit event domain is not in the catalog");
  if (!isAuditEventType(input.domain, input.eventType)) {
    throw new Error("audit event type is not in the catalog");
  }
  if (!isAuditAction(input.action)) throw new Error("audit event action is not in the catalog");
  if (input.actorUserId != null && !isUuid(input.actorUserId)) {
    throw new Error("audit actor must be a uuid or null");
  }
  if (!isAuditEntityType(input.entityType)) throw new Error("audit entity type is not in the catalog");
  if (input.entityId != null && (typeof input.entityId !== "string" || input.entityId.length > 128)) {
    throw new Error("audit entity id must be a short authorized link");
  }
  if (!isUuid(input.idempotencyKey)) throw new Error("audit event requires an idempotency key");

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("audit event occurredAt must be an ISO timestamp");
  }

  const metadata = sanitizeAuditMetadata(input.metadata);
  if (metadata.organizationId && metadata.organizationId !== input.organizationId) {
    throw new Error("audit metadata organization id must match the envelope");
  }

  return Object.freeze({
    id: input.id ?? null,
    organizationId: input.organizationId,
    domain: input.domain,
    eventType: input.eventType,
    action: input.action,
    actorUserId: input.actorUserId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    occurredAt,
    idempotencyKey: input.idempotencyKey,
    metadata,
    source: input.source ?? "organization_audit_ledger",
  });
}

export function assertAuditImmutable(event) {
  if (!event || typeof event !== "object") throw new Error("audit event is required");
  return new Proxy(event, {
    set() {
      throw new Error("audit events are append-only");
    },
    deleteProperty() {
      throw new Error("audit events are append-only");
    },
    defineProperty() {
      throw new Error("audit events are append-only");
    },
  });
}

export function catalogCoverage() {
  return AUDIT_DOMAINS.map((domain) => ({
    domain,
    eventTypes: AUDIT_EVENT_TYPES[domain],
  }));
}
