import {
  isAutomationCapabilityAvailable,
  normalizeAutomationCapabilities,
  validateAutomationDefinitionSpec,
} from "./capabilities.js";

export const AUTOMATION_PROPOSAL_SCHEMA_VERSION = 1;

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion",
  "capabilityVersion",
  "proposal",
  "needsInput",
  "explanation",
  "assumptions",
  "warnings",
]);
const PROPOSAL_KEYS = Object.freeze([
  "name",
  "triggerKind",
  "thresholdDays",
  "cadence",
  "taskPriority",
  "conditions",
  "actionKind",
  "actionConfig",
]);
const INPUT_KEYS = Object.freeze(["field", "reason"]);
const INPUT_FIELDS = Object.freeze([
  "conditions.chapterId",
  "conditions.sourceId",
  "actionConfig.assigneeId",
  "actionConfig.recipientId",
]);
const normalizedProposals = new WeakSet();

const plain = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const exactKeys = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function boundedText(value, maximum, { minimum = 1 } = {}) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) return false;
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  });
}

function safeScalarObject(value) {
  if (!plain(value)) return false;
  return Object.values(value).every((entry) => (
    typeof entry === "boolean"
    || (typeof entry === "string" && boundedText(entry, 128))
    || (Number.isSafeInteger(entry) && Math.abs(entry) <= 9999)
  ));
}

function textList(value, maximumItems, maximumLength) {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((entry) => boundedText(entry, maximumLength));
}

function containsUuid(value) {
  if (typeof value === "string") return UUID_ANYWHERE.test(value);
  if (Array.isArray(value)) return value.some(containsUuid);
  if (plain(value)) return Object.entries(value).some(([key, entry]) => containsUuid(key) || containsUuid(entry));
  return false;
}

function requiredInputField(proposal) {
  if (proposal.actionKind === "assign_task" && proposal.actionConfig.assigneeId === undefined) {
    return "actionConfig.assigneeId";
  }
  if (proposal.actionKind === "notify_in_app" && proposal.actionConfig.recipientId === undefined) {
    return "actionConfig.recipientId";
  }
  return null;
}

export function normalizeAutomationProposal(payload, capabilities) {
  const installed = normalizeAutomationCapabilities(capabilities);
  if (!installed || installed.schemaVersion !== 2 || !exactKeys(payload, ENVELOPE_KEYS)) return null;
  if (payload.schemaVersion !== AUTOMATION_PROPOSAL_SCHEMA_VERSION
    || payload.capabilityVersion !== installed.schemaVersion
    || containsUuid(payload)
    || !exactKeys(payload.proposal, PROPOSAL_KEYS)
    || !Array.isArray(payload.needsInput)
    || payload.needsInput.length > 8
    || !boundedText(payload.explanation, 600)
    || !textList(payload.assumptions, 6, 200)
    || !textList(payload.warnings, 6, 200)) return null;

  const proposal = payload.proposal;
  if (!safeScalarObject(proposal.conditions)
    || !safeScalarObject(proposal.actionConfig)
    || !installed.triggers.includes(proposal.triggerKind)
    || !installed.actions.includes(proposal.actionKind)
    || !installed.cadences.includes(proposal.cadence)
    || !Number.isSafeInteger(proposal.thresholdDays)
    || proposal.thresholdDays > installed.maxThresholdDays
    || !isAutomationCapabilityAvailable(installed, proposal.triggerKind, proposal.actionKind)) return null;

  const definition = { schemaVersion: 2, ...proposal };
  if (!validateAutomationDefinitionSpec(definition, { allowIncomplete: true }).ok) return null;

  const needsInput = [];
  const seenFields = new Set();
  for (const input of payload.needsInput) {
    if (!exactKeys(input, INPUT_KEYS)
      || !INPUT_FIELDS.includes(input.field)
      || seenFields.has(input.field)
      || !boundedText(input.reason, 160)) return null;
    seenFields.add(input.field);
    needsInput.push(Object.freeze({ field: input.field, reason: input.reason }));
  }
  const required = requiredInputField(proposal);
  if (required !== null && !seenFields.has(required)) return null;

  const normalized = Object.freeze({
    schemaVersion: payload.schemaVersion,
    capabilityVersion: payload.capabilityVersion,
    proposal: Object.freeze({
      name: proposal.name,
      triggerKind: proposal.triggerKind,
      thresholdDays: proposal.thresholdDays,
      cadence: proposal.cadence,
      taskPriority: proposal.taskPriority,
      conditions: Object.freeze({ ...proposal.conditions }),
      actionKind: proposal.actionKind,
      actionConfig: Object.freeze({ ...proposal.actionConfig }),
    }),
    needsInput: Object.freeze(needsInput),
    explanation: payload.explanation,
    assumptions: Object.freeze([...payload.assumptions]),
    warnings: Object.freeze([...payload.warnings]),
  });
  normalizedProposals.add(normalized);
  return normalized;
}

export function automationDraftFromProposal(envelope) {
  if (!plain(envelope) || !normalizedProposals.has(envelope)) return null;
  const proposal = envelope.proposal;
  return {
    schemaVersion: 2,
    name: proposal.name,
    triggerKind: proposal.triggerKind,
    thresholdDays: proposal.thresholdDays,
    cadence: proposal.cadence,
    taskPriority: proposal.taskPriority,
    conditions: { ...proposal.conditions },
    actionKind: proposal.actionKind,
    actionConfig: { ...proposal.actionConfig },
  };
}
