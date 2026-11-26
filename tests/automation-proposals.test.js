import { describe, expect, it } from "vitest";

import {
  AUTOMATION_ACTION_METADATA,
  AUTOMATION_TRIGGER_METADATA,
} from "../src/features/automation/capabilities.js";
import {
  AUTOMATION_PROPOSAL_SCHEMA_VERSION,
  automationDraftFromProposal,
  normalizeAutomationProposal,
} from "../src/features/automation/proposals.js";

const UUID = "50900000-0000-4000-8000-000000000109";
const capabilities = Object.freeze({
  schemaVersion: 2,
  triggers: Object.freeze(AUTOMATION_TRIGGER_METADATA.map(({ id }) => id)),
  actions: Object.freeze(AUTOMATION_ACTION_METADATA.map(({ id }) => id)),
  cadences: Object.freeze(["hourly", "daily", "weekly"]),
  maxThresholdDays: 90,
});

function validEnvelope(patch = {}) {
  return {
    schemaVersion: 1,
    capabilityVersion: 2,
    proposal: {
      name: "Notify someone about overdue work",
      triggerKind: "overdue_task",
      thresholdDays: 3,
      cadence: "daily",
      taskPriority: "medium",
      conditions: { status: "in_progress" },
      actionKind: "notify_in_app",
      actionConfig: {},
    },
    needsInput: [{
      field: "actionConfig.recipientId",
      reason: "Choose a recipient in the builder",
    }],
    explanation: "This draft checks overdue in-progress tasks and proposes an in-app reminder.",
    assumptions: ["A daily review is frequent enough."],
    warnings: ["Nothing runs until an authorized approver activates it."],
    ...patch,
  };
}

describe("normalizeAutomationProposal", () => {
  it("accepts a capability-valid incomplete proposal and deeply freezes detached output", () => {
    const payload = validEnvelope();
    const normalized = normalizeAutomationProposal(payload, capabilities);

    expect(normalized).toEqual(payload);
    expect(normalized).not.toBe(payload);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.proposal)).toBe(true);
    expect(Object.isFrozen(normalized.proposal.conditions)).toBe(true);
    expect(Object.isFrozen(normalized.proposal.actionConfig)).toBe(true);
    expect(Object.isFrozen(normalized.needsInput)).toBe(true);
    expect(Object.isFrozen(normalized.needsInput[0])).toBe(true);
    expect(Object.isFrozen(normalized.assumptions)).toBe(true);
    expect(Object.isFrozen(normalized.warnings)).toBe(true);
    expect(AUTOMATION_PROPOSAL_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    [validEnvelope({ extra: true }), "extra top-level key"],
    [validEnvelope({ proposal: { ...validEnvelope().proposal, enabled: true } }), "extra proposal key"],
    [validEnvelope({ needsInput: [{ field: "actionConfig.recipientId", reason: "Choose one", extra: true }] }), "extra input key"],
    [validEnvelope({ schemaVersion: 2 }), "proposal schema mismatch"],
    [validEnvelope({ capabilityVersion: 1 }), "capability mismatch"],
    [validEnvelope({ proposal: { ...validEnvelope().proposal, triggerKind: "invented_trigger" } }), "unknown trigger"],
    [validEnvelope({ proposal: { ...validEnvelope().proposal, actionKind: "send_email" } }), "unknown action"],
    [validEnvelope({ proposal: { ...validEnvelope().proposal, cadence: "minutely" } }), "unknown cadence"],
    [validEnvelope({ proposal: { ...validEnvelope().proposal, thresholdDays: 91 } }), "threshold over installed maximum"],
    [validEnvelope({ needsInput: [{ field: "role", reason: "Choose authority" }] }), "authority-bearing input field"],
  ])("rejects %s", (payload) => {
    expect(normalizeAutomationProposal(payload, capabilities)).toBeNull();
  });

  it("rejects UUID-bearing model output wherever it appears", () => {
    const variants = [
      validEnvelope({ explanation: `Notify ${UUID}` }),
      validEnvelope({ assumptions: [`Recipient ${UUID}`] }),
      validEnvelope({ proposal: { ...validEnvelope().proposal, conditions: { sourceId: UUID } } }),
      validEnvelope({ proposal: { ...validEnvelope().proposal, actionConfig: { recipientId: UUID } } }),
      validEnvelope({ needsInput: [{ field: "actionConfig.recipientId", reason: UUID }] }),
    ];
    for (const payload of variants) expect(normalizeAutomationProposal(payload, capabilities)).toBeNull();
  });

  it("bounds generated text and arrays", () => {
    const variants = [
      validEnvelope({ explanation: "x".repeat(601) }),
      validEnvelope({ assumptions: new Array(7).fill("A bounded assumption") }),
      validEnvelope({ warnings: new Array(7).fill("A bounded warning") }),
      validEnvelope({ assumptions: ["x".repeat(201)] }),
      validEnvelope({ needsInput: new Array(9).fill({ field: "actionConfig.recipientId", reason: "Choose one" }) }),
      validEnvelope({ needsInput: [{ field: "actionConfig.recipientId", reason: "x".repeat(161) }] }),
    ];
    for (const payload of variants) expect(normalizeAutomationProposal(payload, capabilities)).toBeNull();
  });

  it("rejects unsafe nested values instead of coercing model output", () => {
    const variants = [
      validEnvelope({ proposal: { ...validEnvelope().proposal, conditions: { status: ["in_progress"] } } }),
      validEnvelope({ proposal: { ...validEnvelope().proposal, conditions: { status: { value: "in_progress" } } } }),
      validEnvelope({ proposal: { ...validEnvelope().proposal, conditions: { organizationId: "hidden" } } }),
      validEnvelope({ proposal: { ...validEnvelope().proposal, actionConfig: { recipientId: { choose: true } } } }),
      validEnvelope({ assumptions: [5] }),
      Object.assign(Object.create({ role: "admin" }), validEnvelope()),
    ];
    for (const payload of variants) expect(normalizeAutomationProposal(payload, capabilities)).toBeNull();
  });

  it("requires deterministic missing selections to be declared", () => {
    expect(normalizeAutomationProposal(validEnvelope({ needsInput: [] }), capabilities)).toBeNull();
    expect(normalizeAutomationProposal(validEnvelope({
      proposal: { ...validEnvelope().proposal, actionKind: "create_standard_task" },
      needsInput: [],
    }), capabilities)).not.toBeNull();
  });
});

describe("automationDraftFromProposal", () => {
  it("materializes an unsaved schema-v2 draft without review, execution, or identity fields", () => {
    const proposal = normalizeAutomationProposal(validEnvelope(), capabilities);

    expect(automationDraftFromProposal(proposal)).toEqual({
      schemaVersion: 2,
      name: "Notify someone about overdue work",
      triggerKind: "overdue_task",
      thresholdDays: 3,
      cadence: "daily",
      taskPriority: "medium",
      conditions: { status: "in_progress" },
      actionKind: "notify_in_app",
      actionConfig: {},
    });
  });

  it("refuses unnormalized or missing envelopes", () => {
    expect(automationDraftFromProposal(null)).toBeNull();
    expect(automationDraftFromProposal(validEnvelope())).toBeNull();
  });
});
