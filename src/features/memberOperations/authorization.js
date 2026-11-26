import {
  EMPTY_MEMBER_OPERATIONS_WORKSPACE,
  OPERATIONAL_PROFILE_FIELDS,
} from "./contract.js";

const PROFILE_KEYS = new Set(OPERATIONAL_PROFILE_FIELDS);
const CAMPAIGN_STATES = new Set(["draft", "active", "paused", "archived"]);
const ENROLLMENT_STATES = new Set(["active", "paused", "completed", "cancelled"]);
const IMPORT_KINDS = new Set(["member", "grievance"]);
const IMPORT_STATES = new Set(["uploaded", "validated", "committed", "failed", "discarded"]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function boundedText(value, maximum = 4000) {
  return String(value ?? "").slice(0, maximum);
}

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function normalizeMemberOperationsActor(actor = {}) {
  const roles = [...new Set(array(actor.organizationRoles || actor.roles))]
    .filter((role) => role === "admin");
  return Object.freeze({
    userId: actor.userId || actor.id || null,
    selectedOrganizationId: actor.selectedOrganizationId || actor.organizationId || null,
    selectedHat: actor.selectedHat || "member",
    membershipStatus: actor.membershipStatus || null,
    organizationRoles: Object.freeze(roles),
    mfaSatisfied: Boolean(actor.mfaSatisfied),
  });
}

export function canManageMemberOperations(actor) {
  const current = normalizeMemberOperationsActor(actor);
  return Boolean(
    current.userId
      && current.selectedOrganizationId
      && current.membershipStatus === "active"
      && current.selectedHat === "admin"
      && current.organizationRoles.includes("admin")
      && current.mfaSatisfied,
  );
}

function safeDirectoryItem(row) {
  if (!row?.userId || !row?.fullName) return null;
  const profile = Object.fromEntries(Object.entries(row.profile || {})
    .filter(([key]) => PROFILE_KEYS.has(key))
    .map(([key, value]) => [key, boundedText(value, key === "administrativeNotes" ? 4000 : 320)]));
  return {
    userId: row.userId,
    fullName: boundedText(row.fullName, 200),
    initials: boundedText(row.initials, 8),
    chapterId: row.chapterId || null,
    chapterName: boundedText(row.chapterName, 200),
    roles: array(row.roles).filter((role) => ["steward", "coordinator", "advisor", "admin", "vp"].includes(role)),
    version: Math.max(0, count(row.version)),
    profile,
    updatedAt: row.updatedAt || null,
    updatedByName: boundedText(row.updatedByName, 200),
  };
}

function safeCampaignStep(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    position: count(row.position),
    delayDays: Math.min(365, count(row.delayDays)),
    locale: row.locale === "es" ? "es" : "en",
    subject: boundedText(row.subject, 200),
    body: boundedText(row.body, 10000),
    active: row.active !== false,
  };
}

function safeCampaign(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    name: boundedText(row.name, 160),
    state: CAMPAIGN_STATES.has(row.state) ? row.state : "draft",
    steps: array(row.steps).map(safeCampaignStep).filter(Boolean),
    enrollments: array(row.enrollments).filter((item) => item?.id).map((item) => ({
      id: item.id,
      memberUserId: item.memberUserId || null,
      memberName: boundedText(item.memberName, 200),
      state: ENROLLMENT_STATES.has(item.state) ? item.state : "active",
      nextStepPosition: count(item.nextStepPosition),
      nextDueAt: item.nextDueAt || null,
      deliveries: array(item.deliveries).filter((delivery) => delivery?.id).map((delivery) => ({
        id: delivery.id,
        state: ["queued", "leased", "sent", "failed", "suppressed"].includes(delivery.state) ? delivery.state : "queued",
        attemptCount: Math.min(20, count(delivery.attemptCount)),
        createdAt: delivery.createdAt || null,
        sentAt: delivery.sentAt || null,
        errorCode: boundedText(delivery.errorCode, 80),
      })),
    })),
    enrollmentNextCursor: row.enrollmentNextCursor || null,
  };
}

function safeImport(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    kind: IMPORT_KINDS.has(row.kind) ? row.kind : "member",
    state: IMPORT_STATES.has(row.state) ? row.state : "uploaded",
    filename: boundedText(row.filename, 240),
    rowCount: Math.min(500, count(row.rowCount)),
    validCount: Math.min(500, count(row.validCount)),
    errorCount: Math.min(500, count(row.errorCount)),
    mapping: row.mapping && typeof row.mapping === "object" && !Array.isArray(row.mapping) ? row.mapping : {},
    errors: array(row.errors).slice(0, 100).map((error) => ({
      rowNumber: count(error.rowNumber),
      field: boundedText(error.field, 80),
      code: boundedText(error.code, 80),
      message: boundedText(error.message, 240),
    })),
    createdAt: row.createdAt || null,
    committedAt: row.committedAt || null,
  };
}

export function normalizeMemberOperationsWorkspace(snapshot, actor) {
  const current = normalizeMemberOperationsActor(actor);
  if (!snapshot || snapshot.state === "empty" || !current.selectedOrganizationId) {
    return { ...EMPTY_MEMBER_OPERATIONS_WORKSPACE };
  }
  if (!canManageMemberOperations(current) || snapshot.organizationId !== current.selectedOrganizationId) {
    return { ...EMPTY_MEMBER_OPERATIONS_WORKSPACE, state: "unauthorized" };
  }
  return {
    state: snapshot.state === "ready" ? "ready" : "error",
    organizationId: snapshot.organizationId,
    directory: {
      items: array(snapshot.directory?.items).map(safeDirectoryItem).filter(Boolean),
      nextCursor: snapshot.directory?.nextCursor || null,
    },
    campaigns: array(snapshot.campaigns).map(safeCampaign).filter(Boolean),
    imports: array(snapshot.imports).map(safeImport).filter(Boolean),
    importsNextCursor: snapshot.importsNextCursor || null,
    deliveryConfigured: Boolean(snapshot.deliveryConfigured),
  };
}
