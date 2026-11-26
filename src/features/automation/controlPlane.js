import { AUTOMATION_TRIGGER_METADATA, LEGACY_AUTOMATION_CAPABILITIES, automationThreshold, normalizeAutomationCapabilities, validateAutomationDefinitionSpec } from "./capabilities.js";
import { automationAccess } from "./access.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTOMATION_OPERATOR_ROLES = Object.freeze(["admin", "vp"]);
export const AUTOMATION_TRIGGERS = Object.freeze(AUTOMATION_TRIGGER_METADATA.map((row) => row.id));
export const AUTOMATION_CADENCES = Object.freeze(["hourly", "daily", "weekly"]);
export const AUTOMATION_PRIORITIES = Object.freeze(["low", "medium", "high"]);
export const AUTOMATION_DEFINITION_STATUSES = Object.freeze(["draft", "active", "paused", "archived"]);
export const AUTOMATION_RUN_STATUSES = Object.freeze([
  "previewed", "in_progress", "no_op", "succeeded", "partial", "failed",
  "rolled_back", "rollback_partial",
]);
const AUTOMATION_REVIEW_STATUSES = Object.freeze(["draft", "submitted", "changes_requested", "approved"]);
// Restored old-app default recipes (lib/crm/automation-recipes.ts
// AUTOMATION_RECIPE_DEFAULTS). Each organization gets one definition per key
// while features.automation.default_recipes is on.
const AUTOMATION_DEFAULT_RECIPE_KEYS = Object.freeze([
  "overdue_task_escalation", "deadline_risk_alert", "unassigned_case_assignment", "stale_contact_followup",
]);
export const AUTOMATION_ROUTING_TARGETS = Object.freeze(["source_owner", "chapter_stewards", "chapter_admins", "coordinators"]);
export const AUTOMATION_ROUTING_EVENT_KINDS = Object.freeze(["overdue_task", "case_deadline", "unassigned_case", "stale_member_contact"]);

export const AUTOMATION_RPCS = Object.freeze({
  getControlRoom: "get_organization_automation_control_room",
  getWorkspace: "mi1_get_automation_workspace",
  getRoutingRules: "mi1_get_automation_routing_rules",
  saveRoutingRule: "mi1_save_automation_routing_rule",
  deleteRoutingRule: "mi1_delete_automation_routing_rule",
  getOpportunities: "mi1_get_automation_opportunities",
  // saveDefinition (the schemaVersion-1 writer) and previewRun outlived the
  // deleted LegacyAutomationControlRoom on purpose
  // (DEBT-UG-LEGACY-AUTOMATION-CONTROL-ROOM-AND-TESTS-ARE-UNREACHABLE-20260921).
  // The environment that still needs them is a database that has not applied
  // 20260910045839_connected_automation_v2.sql: its control room reports no
  // capabilities, so ConnectedAutomationPages drafts at schemaVersion 1 and
  // saves through saveDefinition.
  // Retire both with that fallback once every target reports schemaVersion 2.
  saveDefinition: "save_organization_automation_definition",
  saveDefinitionV2: "mi1_save_automation_definition_v2",
  getDefinitions: "mi1_get_automation_definitions",
  getRuns: "mi1_get_automation_runs",
  getRun: "mi1_get_automation_run",
  getDefinition: "mi1_get_automation_definition",
  getScopeOptions: "mi1_get_automation_scope_options",
  getSourceContext: "mi1_get_automation_source_context",
  submitDefinition: "mi1_submit_automation_definition",
  reviewDefinition: "mi1_review_automation_definition",
  previewDefinition: "mi1_preview_automation_definition",
  setDefinitionStatus: "set_organization_automation_definition_status",
  setEnabled: "set_organization_automation_enabled",
  setSafetyCap: "set_organization_automation_safety_cap",
  previewRun: "preview_organization_automation_run",
  executeRun: "execute_organization_automation_run",
  rollbackRun: "rollback_organization_automation_run",
});

export function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

export function authorizeAutomationControl(session = {}) {
  const access = automationAccess(session);
  return access.connected && access.canOperate
    ? { ok: true, organizationId: access.organizationId }
    : { ok: false, reason: access.reason ?? "role_denied" };
}

export function authorizeAutomationAuthor(session = {}) {
  const access = automationAccess(session);
  return access.connected && access.canAuthor
    ? { ok: true, organizationId: access.organizationId }
    : { ok: false, reason: access.reason ?? "role_denied" };
}

function integer(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeAutomationDefinition(row) {
  if (!row || !isUuid(row.id) || !AUTOMATION_TRIGGERS.includes(row.triggerKind)) return null;
  const schemaVersion = row.schemaVersion ?? 1;
  if (schemaVersion === 1) {
    if (!LEGACY_AUTOMATION_CAPABILITIES.triggers.includes(row.triggerKind) || row.actionKind !== "create_standard_task") return null;
    if (Object.keys(row.conditions ?? {}).length || Object.keys(row.actionConfig ?? {}).length) return null;
  } else if (!validateAutomationDefinitionSpec({
    schemaVersion, id: row.id, expectedVersion: row.version, name: row.name,
    triggerKind: row.triggerKind, thresholdDays: row.thresholdDays, cadence: row.cadence,
    taskPriority: row.taskPriority, conditions: row.conditions, actionKind: row.actionKind, actionConfig: row.actionConfig,
  }).ok) return null;
  if (!AUTOMATION_CADENCES.includes(row.cadence) || !AUTOMATION_PRIORITIES.includes(row.taskPriority)) return null;
  if (!AUTOMATION_DEFINITION_STATUSES.includes(row.status)) return null;
  if (typeof row.name !== "string" || row.name.trim().length < 3 || row.name.trim().length > 80) return null;
  if (!Number.isSafeInteger(row.version) || row.version < 1) return null;
  const recipeKey = row.recipeKey ?? null;
  if (recipeKey !== null && !AUTOMATION_DEFAULT_RECIPE_KEYS.includes(recipeKey)) return null;
  if (row.scheduledAuthority !== undefined && !["pending_approval", "approver"].includes(row.scheduledAuthority)) return null;
  if (row.scheduledAuthority === "pending_approval" && recipeKey === null) return null;
  const thresholdDays = row.thresholdDays;
  if (!Number.isSafeInteger(thresholdDays) || thresholdDays < 0) return null;
  if (thresholdDays > 90 || (row.triggerKind === "unassigned_case" && thresholdDays !== 0)
    || (row.triggerKind === "stale_member_contact" && thresholdDays < 1)) return null;
  const hasReviewProjection = [
    "reviewStatus", "reviewVersion", "submittedBySelf", "submittedAt", "reviewedAt", "reviewNote",
    "canEdit", "canSubmit", "canReview", "canActivate", "canPreview",
  ].some((key) => Object.hasOwn(row, key));
  let review = {};
  if (hasReviewProjection) {
    const exactBooleans = ["submittedBySelf", "canEdit", "canSubmit", "canReview", "canActivate", "canPreview"];
    const instant = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
    const note = row.reviewNote;
    if (!AUTOMATION_REVIEW_STATUSES.includes(row.reviewStatus)
      || !(row.reviewVersion === null || Number.isSafeInteger(row.reviewVersion) && row.reviewVersion > 0)
      || (row.reviewStatus === "draft" ? row.reviewVersion !== null : row.reviewVersion !== row.version)
      || !exactBooleans.every((key) => typeof row[key] === "boolean")
      || !instant(row.submittedAt) || !instant(row.reviewedAt)
      || !(note === null || typeof note === "string" && note.length >= 1 && note.length <= 500
        && !Array.from(note).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127))
      || row.canActivate && (row.reviewStatus !== "approved" || row.reviewVersion !== row.version)
      || row.canReview && row.reviewStatus !== "submitted"
      // An approver may revise a default recipe in any review state; saving
      // returns it to draft, so it stops running until it is approved again.
      || row.canSubmit && !["draft", "changes_requested"].includes(row.reviewStatus)
      || row.canEdit && recipeKey === null && !["draft", "changes_requested"].includes(row.reviewStatus)) return null;
    review = {
      reviewStatus: row.reviewStatus, reviewVersion: row.reviewVersion,
      submittedBySelf: row.submittedBySelf, submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt, reviewNote: note,
      canEdit: row.canEdit, canSubmit: row.canSubmit, canReview: row.canReview,
      canActivate: row.canActivate, canPreview: row.canPreview,
    };
  }
  return Object.freeze({
    id: row.id,
    name: row.name.trim(),
    triggerKind: row.triggerKind,
    thresholdDays,
    schemaVersion,
    ...(row.sourceFilterAvailable === false ? { sourceFilterAvailable: false } : {}),
    conditions: Object.freeze({ ...(row.conditions || {}) }),
    actionConfig: Object.freeze({ ...(row.actionConfig || {}) }),
    actionKind: row.actionKind,
    taskPriority: row.taskPriority,
    cadence: row.cadence,
    status: row.status,
    version: row.version,
    nextRunAt: row.nextRunAt ?? null,
    lastRunAt: row.lastRunAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    recipeKey,
    ...(row.scheduledAuthority ? { scheduledAuthority: row.scheduledAuthority } : {}),
    // Approvers only: whether the scheduled authority (the approver who last
    // activated it) is still an operator. Absent for everyone else.
    ...(typeof row.dependencyReady === "boolean" ? { dependencyReady: row.dependencyReady } : {}),
    ...review,
  });
}

export function normalizeAutomationRun(row) {
  if (!row || !isUuid(row.id) || !isUuid(row.definitionId)) return null;
  if (!AUTOMATION_RUN_STATUSES.includes(row.status) || !["preview", "manual", "scheduled"].includes(row.mode)) return null;
  return Object.freeze({
    id: row.id,
    definitionId: row.definitionId,
    definitionName: typeof row.definitionName === "string" ? row.definitionName : "",
    mode: row.mode,
    status: row.status,
    candidatesCount: integer(row.candidatesCount),
    effectsCreated: integer(row.effectsCreated),
    effectsSkipped: integer(row.effectsSkipped),
    effectsFailed: integer(row.effectsFailed),
    effectsRolledBack: integer(row.effectsRolledBack),
    rollbackSkipped: integer(row.rollbackSkipped),
    deduplicatedCount: integer(row.deduplicatedCount),
    capLimitedCount: integer(row.capLimitedCount),
    confirmationPhrase: typeof row.confirmationPhrase === "string" ? row.confirmationPhrase : null,
    failureCode: typeof row.failureCode === "string" ? row.failureCode : null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    rollbackUntil: row.rollbackUntil ?? null,
    rolledBackAt: row.rolledBackAt ?? null,
    rollbackEligible: row.rollbackEligible === true,
    rollbackPhrase: typeof row.rollbackPhrase === "string" ? row.rollbackPhrase : null,
  });
}

export function normalizeAutomationControlRoom(payload, selectedOrganizationId) {
  if (!payload || payload.organizationId !== selectedOrganizationId) return null;
  const capabilities = normalizeAutomationCapabilities(payload.capabilities);
  if (!capabilities) return null;
  const definitions = Array.isArray(payload.definitions)
    ? payload.definitions.map(normalizeAutomationDefinition)
    : [];
  const runs = Array.isArray(payload.runs) ? payload.runs.map(normalizeAutomationRun) : [];
  if (definitions.some((row) => !row) || runs.some((row) => !row)) return null;
  const cap = integer(payload.settings?.maxEffectsPerRun, 20);
  if (cap < 1 || cap > 50) return null;
  const access = payload.access === undefined ? null : normalizeAutomationWorkspaceAccess(payload.access);
  if (payload.access !== undefined && !access) return null;
  const defaultRecipes = payload.defaultRecipes === undefined ? null : normalizeDefaultRecipes(payload.defaultRecipes);
  if (payload.defaultRecipes !== undefined && !defaultRecipes) return null;
  return Object.freeze({
    organizationId: selectedOrganizationId,
    settings: Object.freeze({
      enabled: payload.settings?.enabled === true,
      maxEffectsPerRun: cap,
      updatedAt: payload.settings?.updatedAt ?? null,
    }),
    schedulerConfigured: payload.schedulerConfigured === true,
    // Whether this session can supervise appointments. A payload that predates
    // the flag leaves it null (unknown) rather than claiming either answer.
    appointmentSupervision: typeof payload.appointmentSupervision === "boolean" ? payload.appointmentSupervision : null,
    ...(access ? { access } : {}),
    // Restored default recipes and alert routing switches. A payload that
    // predates them leaves this null rather than claiming either state.
    defaultRecipes,
    capabilities,
    definitions: Object.freeze(definitions),
    runs: Object.freeze(runs),
  });
}

function normalizeDefaultRecipes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["enabled", "alertRoutingEnabled"].includes(key))
    || typeof value.enabled !== "boolean" || typeof value.alertRoutingEnabled !== "boolean") return null;
  return Object.freeze({ enabled: value.enabled, alertRoutingEnabled: value.alertRoutingEnabled });
}

const ROUTING_PRIORITIES = Object.freeze(["low", "medium", "high"]);
export const ROUTING_RULE_NAME_LIMITS = Object.freeze({ min: 3, max: 80 });

export function routingRuleNameIssue(trimmedName) {
  const { min, max } = ROUTING_RULE_NAME_LIMITS;
  if (trimmedName.length < min || trimmedName.length > max) return "length";
  if (Array.from(trimmedName).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) return "characters";
  return null;
}

function normalizeAutomationRoutingRule(row) {
  if (!row || !isUuid(row.id) || typeof row.name !== "string") return null;
  const name = row.name.trim();
  if (routingRuleNameIssue(name)) return null;
  if (!AUTOMATION_ROUTING_EVENT_KINDS.includes(row.eventKind) || !AUTOMATION_ROUTING_TARGETS.includes(row.routeTo)) return null;
  if (typeof row.enabled !== "boolean" || typeof row.isDefault !== "boolean") return null;
  if (!Number.isSafeInteger(row.sortOrder) || row.sortOrder < 0 || row.sortOrder > 1000) return null;
  const priorities = row.priorities ?? null;
  if (priorities !== null && (!Array.isArray(priorities) || priorities.length < 1 || priorities.length > 3
    || new Set(priorities).size !== priorities.length || priorities.some((value) => !ROUTING_PRIORITIES.includes(value)))) return null;
  const chapterId = row.chapterId ?? null;
  if (chapterId !== null && (typeof chapterId !== "string" || chapterId.length < 1 || chapterId.length > 128)) return null;
  if (typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) return null;
  return Object.freeze({
    id: row.id, name, eventKind: row.eventKind, routeTo: row.routeTo, enabled: row.enabled,
    isDefault: row.isDefault, sortOrder: row.sortOrder,
    priorities: priorities === null ? null : Object.freeze([...priorities]), chapterId, updatedAt: row.updatedAt,
  });
}

export function normalizeAutomationRoutingRules(payload) {
  if (!payload || !Array.isArray(payload.rules) || payload.rules.length > 50
    || typeof payload.canManage !== "boolean" || typeof payload.enabled !== "boolean") return null;
  const rules = payload.rules.map(normalizeAutomationRoutingRule);
  if (rules.some((row) => !row)) return null;
  return Object.freeze({ enabled: payload.enabled, canManage: payload.canManage, rules: Object.freeze(rules) });
}

export function validRoutingRuleDraft(draft = {}) {
  if (!draft || typeof draft.name !== "string") return false;
  if (routingRuleNameIssue(draft.name.trim())) return false;
  if (!AUTOMATION_ROUTING_EVENT_KINDS.includes(draft.eventKind) || !AUTOMATION_ROUTING_TARGETS.includes(draft.routeTo)) return false;
  if (typeof draft.enabled !== "boolean") return false;
  const priorities = draft.priorities ?? null;
  if (priorities !== null && (!Array.isArray(priorities) || priorities.length < 1 || priorities.length > 3
    || new Set(priorities).size !== priorities.length || priorities.some((value) => !ROUTING_PRIORITIES.includes(value)))) return false;
  return draft.id === undefined || isUuid(draft.id);
}

function normalizeAutomationWorkspaceAccess(value) {
  if (!value || Object.keys(value).length !== 3
    || value.canAuthor !== true || typeof value.canApprove !== "boolean" || typeof value.canOperate !== "boolean"
    || value.canApprove !== value.canOperate) return null;
  return Object.freeze({ canAuthor: true, canApprove: value.canApprove, canOperate: value.canOperate });
}

export function normalizeAutomationWorkspace(payload, selectedOrganizationId) {
  if (!payload?.access || !Array.isArray(payload.definitions)
    || payload.definitions.some((row) => !Object.hasOwn(row ?? {}, "reviewStatus"))) return null;
  return normalizeAutomationControlRoom(payload, selectedOrganizationId);
}

export function normalizeAutomationOpportunities(payload) {
  if (!payload || payload.capabilityVersion !== 2 || !Array.isArray(payload.rows) || payload.rows.length > 8
    || typeof payload.observedAt !== "string" || !Number.isFinite(Date.parse(payload.observedAt))) return null;
  // scopeChapterId names the single chapter the counts came from, and only when
  // exactly one was counted. It is the chapter a non-approver draft has to be
  // bound to, so an empty string or a non-string is a refusal rather than a
  // silently dropped scope.
  const scopeChapterId = payload.scopeChapterId ?? null;
  if (scopeChapterId !== null && (typeof scopeChapterId !== "string" || scopeChapterId === "")) return null;
  const rows = payload.rows.map((row) => {
    if (!row || Object.keys(row).some((key) => !["triggerKind", "candidateCount", "thresholdDays", "scope", "covered"].includes(key))
      || !AUTOMATION_TRIGGERS.includes(row.triggerKind)
      || !Number.isSafeInteger(row.candidateCount) || row.candidateCount < 0 || row.candidateCount > 9999
      || !Number.isSafeInteger(row.thresholdDays) || row.thresholdDays < 0 || row.thresholdDays > 90
      || !["chapter", "organization"].includes(row.scope) || typeof row.covered !== "boolean") return null;
    return Object.freeze({
      triggerKind: row.triggerKind, candidateCount: row.candidateCount,
      thresholdDays: row.thresholdDays, scope: row.scope, covered: row.covered,
    });
  });
  if (rows.some((row) => !row)) return null;
  return Object.freeze({ capabilityVersion: 2, observedAt: payload.observedAt, scopeChapterId, rows: Object.freeze(rows) });
}

export function definitionDraft(definition = {}) {
  return {
    name: definition.name || "",
    triggerKind: definition.triggerKind ?? "overdue_task",
    thresholdDays: String(Number.isSafeInteger(definition.thresholdDays) ? definition.thresholdDays : 1),
    cadence: AUTOMATION_CADENCES.includes(definition.cadence) ? definition.cadence : "daily",
    taskPriority: AUTOMATION_PRIORITIES.includes(definition.taskPriority) ? definition.taskPriority : "medium",
    ...(definition.schemaVersion === 2 ? { schemaVersion: 2, conditions: { ...(definition.conditions || {}) }, actionKind: definition.actionKind, actionConfig: { ...(definition.actionConfig || {}) } } : {}),
  };
}

export function validDefinitionDraft(draft = {}) {
  if (draft.schemaVersion !== undefined && draft.schemaVersion !== 1) {
    return validateAutomationDefinitionSpec({
      schemaVersion: draft.schemaVersion, name: draft.name, triggerKind: draft.triggerKind,
      thresholdDays: automationThreshold(draft.thresholdDays),
      cadence: draft.cadence, taskPriority: draft.taskPriority, conditions: draft.conditions,
      actionKind: draft.actionKind, actionConfig: draft.actionConfig,
    }).ok;
  }
  if (typeof draft.name !== "string" || draft.actionKind !== undefined && draft.actionKind !== "create_standard_task"
    || Object.keys(draft.conditions ?? {}).length || Object.keys(draft.actionConfig ?? {}).length) return false;
  const name = draft.name.trim();
  const threshold = automationThreshold(draft.thresholdDays);
  const hasControlCharacter = Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return name.length >= 3
    && name.length <= 80
    && !hasControlCharacter
    && LEGACY_AUTOMATION_CAPABILITIES.triggers.includes(draft.triggerKind)
    && AUTOMATION_CADENCES.includes(draft.cadence)
    && AUTOMATION_PRIORITIES.includes(draft.taskPriority)
    && Number.isSafeInteger(threshold)
    && threshold >= 0
    && threshold <= 90
    && (draft.triggerKind !== "unassigned_case" || threshold === 0);
}
