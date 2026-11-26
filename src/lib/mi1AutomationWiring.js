import {
  AUTOMATION_RPCS,
  authorizeAutomationAuthor,
  authorizeAutomationControl,
  normalizeAutomationOpportunities,
  normalizeAutomationWorkspace,
} from "../features/automation/index.js";
import { isUuid, normalizeAutomationDefinition, normalizeAutomationRoutingRules, normalizeAutomationRun, validDefinitionDraft, validRoutingRuleDraft } from "../features/automation/controlPlane.js";
import { automationThreshold, isAutomationChapterId, validateAutomationDefinitionSpec } from "../features/automation/capabilities.js";
import { validAutomationSource } from "../features/automation/links.js";
import { isConflictRefusalCode } from "./memberApiError.js";

export const MI1_AUTOMATION_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  inspected: Object.freeze([
    "app/dashboard/admin/automation-control/page.tsx",
    "lib/crm/automation-execution.ts",
    "lib/crm/automation-recipes.ts",
    "lib/crm/automation-safety.ts",
    "lib/crm/automation-rollback.ts",
    "app/api/cron/automation-recipes/route.ts",
    "supabase/migrations/0528_automation_runs.sql",
    "supabase/migrations/0577_automation_safety.sql",
  ]),
  rejected: Object.freeze([
    "Next.js routes and server actions",
    "service-role keys in application request paths",
    "global agency and branch tenant assumptions",
    "hard-coded recipes that require code changes",
    "member, grievance, or task copy in generated task cards",
    "direct browser table writes and legacy migration ordering",
    "fictional production tenants, actors, credentials, or seed rows",
  ]),
});

function isMissingRpc(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

function failureReason(error) {
  if (isMissingRpc(error)) return "persistence_unset";
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  if (/multi-factor authentication required|mfa required/i.test(message)) return "mfa_required";
  if (code === "42501" && /staff drafts require visible chapter or source scope/i.test(message)) return "scope_required";
  if (code === "42501" && /appointment supervision required/i.test(message)) return "appointment_supervision";
  if (code === "42501") return "role_denied";
  if (/changes requested/i.test(message)) return "changes_requested";
  if (isConflictRefusalCode(code) && /approval|unapproved/i.test(message)) return "stale_approval";
  if (isConflictRefusalCode(code)) return "stale_definition";
  if (code === "23505") return "duplicate_name";
  if (code === "22023" || code === "23514") return "invalid_action";
  return "unavailable";
}

export function normalizeAutomationEffect(row) {
  // Persistence names the child relation "checklist"; navigation uses the
  // explicit case-family name and still requires the independently visible parent.
  const sourceKind = row?.sourceKind === "checklist" ? "case_checklist" : row?.sourceKind;
  if (!row || !isUuid(row.id) || !["task", "case", "casework_deadline", "case_checklist", "appointment", "event"].includes(sourceKind)
    || !["pending", "created", "skipped", "failed", "rolled_back", "rollback_skipped"].includes(row.status)) return null;
  if (row.sourceAvailable === true && (typeof row.sourceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(row.sourceId)
    || row.sourceKind !== "event" && !isUuid(row.sourceId))) return null;
  if (row.taskId != null && !isUuid(row.taskId) || row.caseId != null && !isUuid(row.caseId)) return null;
  if (![undefined, null, "human_modified", "irreversible", "source_unavailable", "action_failed", "deduplicated", "cap_reached", "permission_lost"].includes(row.reasonCode)) return null;
  return Object.freeze({
    id: row.id, sourceKind, sourceId: row.sourceAvailable === true ? row.sourceId : null, status: row.status,
    taskId: row.effectAvailable === true ? row.taskId ?? null : null, caseId: row.sourceAvailable === true ? row.caseId ?? null : null,
    reasonCode: row.reasonCode ?? null,
    actionKind: typeof row.actionKind === "string" ? row.actionKind : null,
    sourceAvailable: row.sourceAvailable === true, effectAvailable: row.effectAvailable === true,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    rolledBackAt: typeof row.rolledBackAt === "string" ? row.rolledBackAt : null,
    // Do not spread persistence rows: snapshots may contain internal state.
  });
}

export function createAutomationApi(client) {
  const invalid = () => ({ ok: false, reason: "invalid_action" });
  const pageArgs = ({ page = 1, pageSize = 20 } = {}) => Number.isSafeInteger(page) && page >= 1 && page <= 10000
    && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 50 ? { p_page: page, p_page_size: pageSize } : null;
  const normalizePage = (value, normalizeRow) => {
    if (!value || !Array.isArray(value.rows) || value.rows.length > 50 || !Number.isSafeInteger(value.total) || value.total < 0
      || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pageSize)
      || !pageArgs({ page: value.page, pageSize: value.pageSize }) || value.rows.length > value.pageSize || value.rows.length > value.total) return null;
    const rows = value.rows.map(normalizeRow);
    return rows.some((row) => !row) ? null : { rows, total: value.total, page: value.page, pageSize: value.pageSize };
  };
  const normalizeOption = (row) => row && isAutomationChapterId(row.id)
    && typeof row.label === "string" && row.label.length <= 200 ? { id: row.id, label: row.label } : null;
  const validInstant = (value) => value == null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  async function call(session, rpc, args = undefined, authority = "author") {
    const gate = authority === "approver" ? authorizeAutomationControl(session) : authorizeAutomationAuthor(session);
    if (!gate.ok) return gate;
    if (!client?.rpc || !Object.values(AUTOMATION_RPCS).includes(rpc)) {
      return { ok: false, reason: "persistence_unset" };
    }
    try {
      const { data, error } = await client.rpc(rpc, args);
      if (error) return { ok: false, reason: failureReason(error) };
      return { ok: true, data, organizationId: gate.organizationId };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async function read(session, rpc, args, normalize) {
    const gate = authorizeAutomationAuthor(session);
    if (!gate.ok) return gate;
    if (!args) return invalid();
    const result = await call(session, rpc, args);
    if (!result.ok) return result;
    if (result.data?.organizationId !== result.organizationId) return { ok: false, reason: "unavailable" };
    const data = normalize(result.data);
    return data ? { ...result, data: { ...data, organizationId: result.organizationId } } : { ok: false, reason: "unavailable" };
  }

  async function getWorkspace(session) {
    const result = await call(session, AUTOMATION_RPCS.getWorkspace);
    if (!result.ok) return { state: result.reason, control: null };
    const control = normalizeAutomationWorkspace(result.data, result.organizationId);
    return control ? { state: "ready", control } : { state: "unavailable", control: null };
  }

  return Object.freeze({
    getWorkspace,
    load: getWorkspace,
    async getOpportunities(session) {
      const result = await call(session, AUTOMATION_RPCS.getOpportunities);
      if (!result.ok) return result;
      const data = normalizeAutomationOpportunities(result.data);
      return data ? { ...result, data } : { ok: false, reason: "unavailable" };
    },
    saveDefinition: async (session, fields = {}) => {
      const gate = authorizeAutomationAuthor(session);
      if (!gate.ok) return gate;
      if (fields.schemaVersion !== undefined && fields.schemaVersion !== 1) {
        const definition = { schemaVersion: fields.schemaVersion,
          ...(fields.id == null ? {} : { id: fields.id }),
          ...(fields.expectedVersion == null && fields.version == null ? {} : { expectedVersion: fields.expectedVersion ?? fields.version }),
          name: typeof fields.name === "string" ? fields.name.trim() : fields.name,
          triggerKind: fields.triggerKind, thresholdDays: automationThreshold(fields.thresholdDays),
          cadence: fields.cadence, taskPriority: fields.taskPriority, conditions: fields.conditions ?? {},
          actionKind: fields.actionKind, actionConfig: fields.actionConfig ?? {} };
        if (!validateAutomationDefinitionSpec(definition).ok) return invalid();
        return call(session, AUTOMATION_RPCS.saveDefinitionV2, { p_definition: definition });
      }
      // schemaVersion 1: only ConnectedAutomationPages' fallback for a database
      // without 20260910045839_connected_automation_v2.sql reaches this (see
      // AUTOMATION_RPCS in features/automation/controlPlane.js).
      if (!validDefinitionDraft(fields) || (fields.id && !isUuid(fields.id))) return invalid();
      return call(session, AUTOMATION_RPCS.saveDefinition, {
        p_definition_id: fields.id || null,
        p_name: fields.name.trim(),
        p_trigger_kind: fields.triggerKind,
        p_threshold_days: Number(fields.thresholdDays),
        p_cadence: fields.cadence,
        p_task_priority: fields.taskPriority,
        p_expected_version: fields.version ?? null,
      }, "approver");
    },
    getDefinitions: (session, options = {}) => read(session, AUTOMATION_RPCS.getDefinitions,
      pageArgs(options) && typeof (options.search ?? "") === "string" && (options.search ?? "").length <= 80
        && [undefined, null, "draft", "active", "paused", "archived"].includes(options.status)
        ? { ...pageArgs(options), p_search: options.search ?? "", p_status: options.status ?? null } : null,
      (data) => normalizePage(data, normalizeAutomationDefinition)),
    getRuns: (session, options = {}) => read(session, AUTOMATION_RPCS.getRuns,
      pageArgs(options) && (options.definitionId == null || isUuid(options.definitionId))
        && validInstant(options.from) && validInstant(options.to) && (!options.from || !options.to || Date.parse(options.from) <= Date.parse(options.to))
        && [undefined, null, "previewed", "in_progress", "no_op", "succeeded", "partial", "failed", "rolled_back", "rollback_partial"].includes(options.status)
        ? { ...pageArgs(options), p_definition_id: options.definitionId ?? null, p_status: options.status ?? null, p_from: options.from ?? null, p_to: options.to ?? null } : null,
      (data) => normalizePage(data, normalizeAutomationRun)),
    getDefinition: (session, id) => read(session, AUTOMATION_RPCS.getDefinition, isUuid(id) ? { p_definition_id: id } : null,
      (data) => { const definition = normalizeAutomationDefinition(data.definition); return definition?.id === id ? { definition } : null; }),
    getRun: (session, id, options = {}) => read(session, AUTOMATION_RPCS.getRun,
      isUuid(id) && pageArgs(options) ? { p_run_id: id, ...pageArgs(options) } : null,
      (data) => {
        const run = normalizeAutomationRun(data.run);
        const effects = normalizePage(data.effects, normalizeAutomationEffect);
        if (run?.id !== id || !effects) return null;
        let definition = null;
        if (data.run.definitionSnapshotAvailable === true) {
          const snapshot = data.run.definition;
          const conditions = { ...snapshot?.conditions };
          if (snapshot?.sourceFilterAvailable === false) delete conditions.sourceId;
          definition = normalizeAutomationDefinition({ ...snapshot, conditions });
          if (!definition || definition.id !== run.definitionId
            || data.run.definitionVersion != null && definition.version !== data.run.definitionVersion) return null;
          definition = Object.freeze({ ...definition, sourceFilterAvailable: snapshot.sourceFilterAvailable !== false });
        }
        return { run: Object.freeze({ ...run, definition, definitionSnapshotAvailable: definition !== null }), effects };
      }),
    getScopeOptions: (session, options = {}) => read(session, AUTOMATION_RPCS.getScopeOptions,
      pageArgs(options) && ["task", "case", "appointment", "event"].includes(options.source)
        && (options.chapterId == null || isAutomationChapterId(options.chapterId))
        && typeof (options.search ?? "") === "string" && (options.search ?? "").length <= 80
        ? { ...pageArgs(options), p_source: options.source, p_chapter_id: options.chapterId ?? null, p_search: options.search ?? "" } : null,
      (data) => {
        const chapters = normalizePage(data.chapters, normalizeOption);
        const assignees = normalizePage(data.assignees, (row) => isUuid(row?.id) ? normalizeOption(row) : null);
        const recipients = normalizePage(data.recipients, (row) => isUuid(row?.id) ? normalizeOption(row) : null);
        return chapters && assignees && recipients ? { chapters, assignees, recipients } : null;
      }),
    getSourceContext: (session, sourceKind, sourceId) => read(session, AUTOMATION_RPCS.getSourceContext,
      validAutomationSource(sourceKind, sourceId) ? { p_source: sourceKind, p_source_id: sourceId } : null,
      (data) => data.sourceKind === sourceKind && data.sourceId === sourceId && isAutomationChapterId(data.chapterId) ? { sourceKind, sourceId, chapterId: data.chapterId } : null),
    submitDefinition: (session, id, version) => isUuid(id) && Number.isSafeInteger(version) && version > 0
      ? call(session, AUTOMATION_RPCS.submitDefinition, { p_definition_id: id, p_expected_version: version }) : invalid(),
    reviewDefinition: (session, id, version, action, note = null) => {
      const boundedNote = note === null || typeof note === "string" && note.length >= 1 && note.length <= 500
        && !Array.from(note).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
      if (!isUuid(id) || !Number.isSafeInteger(version) || version < 1
        || !["approve", "request_changes"].includes(action) || !boundedNote
        || action === "request_changes" && note === null) return invalid();
      return call(session, AUTOMATION_RPCS.reviewDefinition, {
        p_definition_id: id, p_expected_version: version, p_action: action, p_note: note,
      }, "approver");
    },
    previewDefinition: (session, definitionId) => isUuid(definitionId)
      ? call(session, AUTOMATION_RPCS.previewDefinition, { p_definition_id: definitionId }) : invalid(),
    setDefinitionStatus: (session, id, status, version) => call(session, AUTOMATION_RPCS.setDefinitionStatus, {
      p_definition_id: id,
      p_status: status,
      p_expected_version: version,
    }, "approver"),
    setEnabled: (session, enabled, confirmation) => call(session, AUTOMATION_RPCS.setEnabled, {
      p_enabled: enabled,
      p_confirmation: confirmation,
    }, "approver"),
    setSafetyCap: (session, cap) => call(session, AUTOMATION_RPCS.setSafetyCap, {
      p_max_effects_per_run: Number(cap),
    }, "approver"),
    // Kept for the environments named at AUTOMATION_RPCS (features/automation/
    // controlPlane.js); ConnectedAutomationPages calls it only when its api has
    // no previewDefinition.
    previewRun: (session, definitionId) => call(session, AUTOMATION_RPCS.previewRun, {
      p_definition_id: definitionId,
    }, "approver"),
    executeRun: (session, runId, confirmation) => call(session, AUTOMATION_RPCS.executeRun, {
      p_run_id: runId,
      p_confirmation: confirmation,
    }, "approver"),
    rollbackRun: (session, runId, confirmation) => call(session, AUTOMATION_RPCS.rollbackRun, {
      p_run_id: runId,
      p_confirmation: confirmation,
    }, "approver"),
    // Restored alert routing (old lib/notifications/alert-routing.ts, 0529):
    // staff authors read the organization's rules, approvers change them.
    getRoutingRules: (session) => read(session, AUTOMATION_RPCS.getRoutingRules, {}, normalizeAutomationRoutingRules),
    saveRoutingRule: (session, draft = {}) => {
      if (!validRoutingRuleDraft(draft)) return Promise.resolve(invalid());
      const rule = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(), eventKind: draft.eventKind, routeTo: draft.routeTo, enabled: draft.enabled,
        priorities: draft.priorities ?? null, chapterId: draft.chapterId ?? null,
        sortOrder: Number.isSafeInteger(draft.sortOrder) ? draft.sortOrder : 100,
      };
      return call(session, AUTOMATION_RPCS.saveRoutingRule, { p_rule: rule }, "approver");
    },
    deleteRoutingRule: (session, id) => isUuid(id)
      ? call(session, AUTOMATION_RPCS.deleteRoutingRule, { p_rule_id: id }, "approver") : Promise.resolve(invalid()),
  });
}
