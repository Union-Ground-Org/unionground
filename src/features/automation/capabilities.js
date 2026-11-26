// This allowlist is a client boundary, not an authorization grant. The server
// independently validates the same versioned contract and every scoped ID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const isAutomationChapterId = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 128
  && !Array.from(value).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
export const automationThreshold = (value) => typeof value === "number" ? value
  : typeof value === "string" && /^[0-9]{1,2}$/.test(value.trim()) ? Number(value) : NaN;
export const AUTOMATION_THRESHOLD_MAX_DAYS = 90;
export const automationThresholdMinimum = (triggerKind) => triggerKind === "stale_member_contact" ? 1 : 0;
const TASK_STATUSES = ["backlog", "to_do", "in_progress", "needs_review"];
const DEADLINE_KINDS = ["filing", "response", "hearing", "appeal", "follow_up"];
const trigger = (id, source, en, es, thresholdMode, statuses = [], extra = []) => Object.freeze({
  id, source, label: Object.freeze({ en, es }), thresholdMode,
  conditions: Object.freeze(["chapterId", "sourceId", ...(statuses.length ? ["status"] : []), ...(source === "task" ? ["priority", "assignment"] : []), ...extra]),
  statuses: Object.freeze(statuses), deadlineKinds: Object.freeze(extra.includes("deadlineKind") ? DEADLINE_KINDS : []),
});

export const AUTOMATION_TRIGGER_METADATA = Object.freeze([
  trigger("overdue_task", "task", "Task overdue", "Tarea vencida", "past", TASK_STATUSES),
  trigger("case_deadline", "case", "Case deadline approaching", "Plazo de caso cercano", "future", ["active"]),
  trigger("unassigned_case", "case", "Case without an assignee", "Caso sin responsable", "none", ["active"]),
  trigger("task_due", "task", "Task due soon", "Tarea próxima a vencer", "future", TASK_STATUSES),
  trigger("blocked_task", "task", "Task blocked", "Tarea bloqueada", "none", TASK_STATUSES),
  trigger("unassigned_task", "task", "Task without an assignee", "Tarea sin responsable", "none", TASK_STATUSES),
  trigger("stale_task", "task", "Task without recent progress", "Tarea sin progreso reciente", "past", TASK_STATUSES),
  trigger("review_task", "task", "Task awaiting review", "Tarea pendiente de revisión", "past", ["needs_review"]),
  trigger("casework_deadline", "case", "Tracked casework deadline", "Plazo registrado del caso", "future", ["active", "missed"], ["deadlineKind"]),
  trigger("incomplete_case_checklist", "case", "Required case checklist unfinished", "Lista obligatoria del caso incompleta", "none"),
  trigger("appointment_upcoming", "appointment", "Appointment approaching", "Cita próxima", "future", ["confirmed"]),
  trigger("appointment_followup", "appointment", "Appointment follow-up needed", "Seguimiento de cita pendiente", "past", ["completed", "no_show"]),
  trigger("event_upcoming", "event", "Event approaching", "Evento próximo", "future"),
  trigger("event_followup", "event", "Event follow-up needed", "Seguimiento de evento pendiente", "past"),
  // Restored old-app recipe (lib/crm/automation-recipes.ts stale_contact_followup):
  // a member with an active case and no recorded contact inside the window.
  trigger("stale_member_contact", "case", "Member contact gone quiet", "Contacto con el miembro sin actividad", "past", ["active"]),
]);

const action = (id, sources, en, es) => Object.freeze({ id, sources: Object.freeze(sources), label: Object.freeze({ en, es }) });
export const AUTOMATION_ACTION_METADATA = Object.freeze([
  action("create_standard_task", ["task", "case", "appointment", "event"], "Create a follow-up task", "Crear una tarea de seguimiento"),
  action("assign_task", ["task"], "Assign the existing task", "Asignar la tarea existente"),
  action("raise_task_priority", ["task"], "Raise the existing task's priority", "Aumentar la prioridad de la tarea existente"),
  action("notify_in_app", ["task", "case", "appointment", "event"], "Send an in-app notice", "Enviar un aviso en la aplicación"),
]);

export const LEGACY_AUTOMATION_CAPABILITIES = Object.freeze({
  schemaVersion: 1, triggers: Object.freeze(["overdue_task", "case_deadline", "unassigned_case"]),
  actions: Object.freeze(["create_standard_task"]), cadences: Object.freeze(["hourly", "daily", "weekly"]), maxThresholdDays: AUTOMATION_THRESHOLD_MAX_DAYS,
});
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const knownKeys = (value, keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key));
const validList = (list, allowed) => Array.isArray(list) && list.length > 0 && list.length <= allowed.length
  && new Set(list).size === list.length && [...list].every((id) => allowed.includes(id));

export function normalizeAutomationCapabilities(payload) {
  if (payload === undefined || payload === null) return LEGACY_AUTOMATION_CAPABILITIES;
  if (!knownKeys(payload, ["schemaVersion", "triggers", "actions", "cadences", "maxThresholdDays"])) return null;
  if (![1, 2].includes(payload.schemaVersion)) return null;
  const legacy = payload.schemaVersion === 1;
  if (!validList(payload.triggers, legacy ? LEGACY_AUTOMATION_CAPABILITIES.triggers : AUTOMATION_TRIGGER_METADATA.map((row) => row.id))
    || !validList(payload.actions, legacy ? LEGACY_AUTOMATION_CAPABILITIES.actions : AUTOMATION_ACTION_METADATA.map((row) => row.id))
    || !validList(payload.cadences, LEGACY_AUTOMATION_CAPABILITIES.cadences)
    || !Number.isSafeInteger(payload.maxThresholdDays) || payload.maxThresholdDays < 0 || payload.maxThresholdDays > AUTOMATION_THRESHOLD_MAX_DAYS) return null;
  return Object.freeze({ ...payload, triggers: Object.freeze([...payload.triggers]), actions: Object.freeze([...payload.actions]), cadences: Object.freeze([...payload.cadences]) });
}

export function isAutomationCapabilityAvailable(capabilities, triggerKind, actionKind) {
  const normalized = normalizeAutomationCapabilities(capabilities);
  const source = AUTOMATION_TRIGGER_METADATA.find((row) => row.id === triggerKind)?.source;
  return Boolean(normalized?.triggers.includes(triggerKind) && normalized.actions.includes(actionKind)
    && AUTOMATION_ACTION_METADATA.find((row) => row.id === actionKind)?.sources.includes(source));
}

export function validateAutomationDefinitionSpec(spec, { allowIncomplete = false } = {}) {
  const errors = [];
  if (!knownKeys(spec, ["schemaVersion", "id", "expectedVersion", "name", "triggerKind", "thresholdDays", "cadence", "taskPriority", "conditions", "actionKind", "actionConfig"])) return { ok: false, errors: ["definition_shape"] };
  if (spec.schemaVersion !== 2) errors.push("schema_version");
  if (spec.id !== undefined && spec.id !== null && (typeof spec.id !== "string" || !UUID.test(spec.id))) errors.push("definition_id");
  if (spec.expectedVersion !== undefined && spec.expectedVersion !== null && (!Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1)) errors.push("expected_version");
  if (!(allowIncomplete && (spec.name === undefined || spec.name === "")) && (typeof spec.name !== "string" || spec.name.trim().length < 3 || spec.name.trim().length > 80
    || Array.from(spec.name).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127))) errors.push("name");
  const selected = AUTOMATION_TRIGGER_METADATA.find((row) => row.id === spec.triggerKind);
  const selectedAction = AUTOMATION_ACTION_METADATA.find((row) => row.id === spec.actionKind);
  if (!selected) errors.push("trigger_kind");
  if (!selectedAction || !selectedAction.sources.includes(selected?.source)) errors.push("action_kind");
  if (!LEGACY_AUTOMATION_CAPABILITIES.cadences.includes(spec.cadence)) errors.push("cadence");
  if (!["low", "medium", "high"].includes(spec.taskPriority)) errors.push("task_priority");
  if (!Number.isSafeInteger(spec.thresholdDays)
    || spec.thresholdDays < automationThresholdMinimum(spec.triggerKind)
    || spec.thresholdDays > AUTOMATION_THRESHOLD_MAX_DAYS
    || (selected?.thresholdMode === "none" && spec.thresholdDays !== 0)) errors.push("threshold_days");
  const conditions = spec.conditions ?? {};
  if (!knownKeys(conditions, selected?.conditions || [])) errors.push("conditions");
  else {
    if (conditions.chapterId !== undefined && !isAutomationChapterId(conditions.chapterId)) errors.push("chapter_id");
    if (conditions.sourceId !== undefined && (typeof conditions.sourceId !== "string" || !(selected?.source === "event" ? OPAQUE_ID : UUID).test(conditions.sourceId))) errors.push("source_id");
    if (conditions.status !== undefined && !selected?.statuses.includes(conditions.status)) errors.push("status");
    if (conditions.deadlineKind !== undefined && !selected?.deadlineKinds.includes(conditions.deadlineKind)) errors.push("deadline_kind");
    if (conditions.priority !== undefined && !["low", "medium", "high"].includes(conditions.priority)) errors.push("priority");
    if (conditions.assignment !== undefined && (!["assigned", "unassigned"].includes(conditions.assignment)
      || spec.triggerKind === "unassigned_task" && conditions.assignment !== "unassigned")) errors.push("assignment");
  }
  const config = spec.actionConfig ?? {};
  const keys = { create_standard_task: [], assign_task: ["assigneeId"], raise_task_priority: ["priority"], notify_in_app: ["recipientId"] }[spec.actionKind] ?? [];
  if (!knownKeys(config, keys)) errors.push("action_config");
  else for (const key of keys) {
    if (allowIncomplete && config[key] === undefined) continue;
    if (key === "priority" ? !["medium", "high"].includes(config[key]) : typeof config[key] !== "string" || !UUID.test(config[key])) errors.push(key === "priority" ? "action_priority" : "action_recipient");
  }
  return { ok: errors.length === 0, errors };
}
