import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ACTION_METADATA,
  AUTOMATION_TRIGGER_METADATA,
  LEGACY_AUTOMATION_CAPABILITIES,
  isAutomationCapabilityAvailable,
  normalizeAutomationCapabilities,
  validateAutomationDefinitionSpec,
} from "../src/features/automation/capabilities.js";

const id = "50900000-0000-4000-8000-000000000109";
const draft = (patch = {}) => ({
  schemaVersion: 2, name: "Review upcoming work", triggerKind: "task_due",
  thresholdDays: 3, cadence: "daily", taskPriority: "medium",
  conditions: {}, actionKind: "create_standard_task", actionConfig: {}, ...patch,
});
const installed = (patch = {}) => ({
  schemaVersion: 2,
  triggers: AUTOMATION_TRIGGER_METADATA.map((entry) => entry.id),
  actions: AUTOMATION_ACTION_METADATA.map((entry) => entry.id),
  cadences: ["hourly", "daily", "weekly"], maxThresholdDays: 90, ...patch,
});

describe("versioned automation definition boundary", () => {
  it("accepts a complete specification and preserves legacy capability discovery", () => {
    expect(validateAutomationDefinitionSpec(draft())).toEqual({ ok: true, errors: [] });
    expect(normalizeAutomationCapabilities()).toBe(LEGACY_AUTOMATION_CAPABILITIES);
    expect(normalizeAutomationCapabilities(null)).toBe(LEGACY_AUTOMATION_CAPABILITIES);
    expect(isAutomationCapabilityAvailable(undefined, "overdue_task", "create_standard_task")).toBe(true);
    expect(isAutomationCapabilityAvailable(undefined, "event_upcoming", "create_standard_task")).toBe(false);
    expect(isAutomationCapabilityAvailable(undefined, "overdue_task", "notify_in_app")).toBe(false);
    expect(normalizeAutomationCapabilities(LEGACY_AUTOMATION_CAPABILITIES)).toEqual(LEGACY_AUTOMATION_CAPABILITIES);
  });

  // Labelled cases: a printed Date would change the title every run (#7990).
  it.each([
    ["undefined", undefined], ["null", null], ["an array", []], ["a string", "definition"], ["a number", 3],
    ["a Date", new Date(0)], ["an object with a custom prototype", Object.create({ inherited: true })],
  ])(
    "rejects non-object, array and custom-prototype definition inputs: %s", (_label, value) => {
      expect(validateAutomationDefinitionSpec(value)).toEqual({ ok: false, errors: ["definition_shape"] });
    },
  );

  it("accepts plain null-prototype JSON-like objects without inheriting fields", () => {
    expect(validateAutomationDefinitionSpec(Object.assign(Object.create(null), draft())).ok).toBe(true);
    expect(validateAutomationDefinitionSpec(draft({ conditions: Object.create(null), actionConfig: Object.create(null) })).ok).toBe(true);
    expect(validateAutomationDefinitionSpec(Object.assign(Object.create({ role: "admin" }), draft())).ok).toBe(false);
  });

  it.each([
    [{ schemaVersion: 1 }, "schema_version"], [{ schemaVersion: "2" }, "schema_version"],
    [{ schemaVersion: 3 }, "schema_version"], [{ schemaVersion: undefined }, "schema_version"],
    [{ triggerKind: "future_trigger" }, "trigger_kind"], [{ actionKind: "send_email" }, "action_kind"],
    [{ triggerKind: "task_due", actionKind: "post_webhook" }, "action_kind"],
    [{ cadence: "minutely" }, "cadence"], [{ taskPriority: "urgent" }, "task_priority"],
  ])("rejects unknown schema, trigger, action or vocabulary: %j", (patch, error) => {
    expect(validateAutomationDefinitionSpec(draft(patch)).errors).toContain(error);
  });

  it("rejects unknown authority-bearing fields rather than ignoring them", () => {
    for (const field of ["organizationId", "actorId", "enabled", "status", "role", "boardId"]) {
      expect(validateAutomationDefinitionSpec(draft({ [field]: id }))).toEqual({ ok: false, errors: ["definition_shape"] });
    }
    expect(validateAutomationDefinitionSpec(draft({ conditions: { organizationId: id } })).errors).toContain("conditions");
    expect(validateAutomationDefinitionSpec(draft({ conditions: { boardId: "board-1" } })).errors).toContain("conditions");
    expect(validateAutomationDefinitionSpec(draft({ actionConfig: { boardId: "board-1" } })).errors).toContain("action_config");
    expect(validateAutomationDefinitionSpec(draft({ conditions: { or: [{ chapterId: "chapter-1" }] } })).errors).toContain("conditions");
  });

  it.each(["", "3", 1.5, NaN, Infinity, -1, 91, null, undefined, true, [], {}])(
    "rejects blank, noninteger or out-of-bounds thresholds: %s", (thresholdDays) => {
      expect(validateAutomationDefinitionSpec(draft({ thresholdDays })).errors).toContain("threshold_days");
    },
  );

  it("accepts the inclusive threshold bounds but requires zero for no-threshold triggers", () => {
    for (const thresholdDays of [0, 90]) expect(validateAutomationDefinitionSpec(draft({ thresholdDays })).ok).toBe(true);
    const noThreshold = AUTOMATION_TRIGGER_METADATA.filter((entry) => entry.thresholdMode === "none");
    expect(noThreshold.map((entry) => entry.id)).toEqual(["unassigned_case", "blocked_task", "unassigned_task", "incomplete_case_checklist"]);
    for (const { id: triggerKind } of noThreshold) {
      expect(validateAutomationDefinitionSpec(draft({ triggerKind, thresholdDays: 0 })).ok).toBe(true);
      expect(validateAutomationDefinitionSpec(draft({ triggerKind, thresholdDays: 1 })).errors).toContain("threshold_days");
    }
  });

  it("restricts statuses and deadline kinds to the selected real source schema", () => {
    for (const metadata of AUTOMATION_TRIGGER_METADATA) {
      const base = draft({ triggerKind: metadata.id, thresholdDays: metadata.thresholdMode === "none" ? 0 : 3 });
      for (const status of metadata.statuses) expect(validateAutomationDefinitionSpec({ ...base, conditions: { status } }).ok).toBe(true);
      expect(validateAutomationDefinitionSpec({ ...base, conditions: { status: "cancelled" } }).ok).toBe(false);
      if (!metadata.statuses.length) expect(validateAutomationDefinitionSpec({ ...base, conditions: { status: "active" } }).errors).toContain("conditions");
      for (const deadlineKind of metadata.deadlineKinds) {
        expect(validateAutomationDefinitionSpec({ ...base, conditions: { deadlineKind } }).ok).toBe(true);
      }
      expect(validateAutomationDefinitionSpec({ ...base, conditions: { deadlineKind: "invented" } }).ok).toBe(false);
    }
    expect(validateAutomationDefinitionSpec(draft({ triggerKind: "review_task", conditions: { status: "to_do" } })).errors).toContain("status");
  });

  it("rejects arrays and inherited condition/action objects", () => {
    for (const value of [[], ["chapter-1"], "chapter-1", 1, Object.create({ chapterId: "chapter-1" })]) {
      expect(validateAutomationDefinitionSpec(draft({ conditions: value })).errors).toContain("conditions");
    }
    for (const value of [[], [id], "recipient", 1, Object.create({ recipientId: id })]) {
      expect(validateAutomationDefinitionSpec(draft({ actionConfig: value })).errors).toContain("action_config");
    }
  });

  it("requires typed UUID definition and recipient references, with bounded opaque event/chapter IDs", () => {
    expect(validateAutomationDefinitionSpec(draft({ id, expectedVersion: 1, conditions: { chapterId: "chapter-1", sourceId: id } })).ok).toBe(true);
    for (const invalid of ["wrong", "../path", "https://example.test", "x".repeat(129), "contains space"]) {
      expect(validateAutomationDefinitionSpec(draft({ conditions: { sourceId: invalid } })).ok).toBe(false);
    }
    for (const invalid of ["../path", "https://example.test", "x".repeat(129), "contains space", "", 5]) {
      expect(validateAutomationDefinitionSpec(draft({ triggerKind: "event_upcoming", conditions: { sourceId: invalid } })).errors).toContain("source_id");
    }
    // chapters.id is canonical text, NOT chapters.slug. Never use a chapter ID
    // as a path: spaces and punctuation remain valid bound SQL values.
    expect(validateAutomationDefinitionSpec(draft({ conditions: { chapterId: "Chapter / West" } })).ok).toBe(true);
    for (const invalid of ["", " ", "bad\nchapter", "x".repeat(129), 5]) {
      expect(validateAutomationDefinitionSpec(draft({ conditions: { chapterId: invalid } })).errors).toContain("chapter_id");
    }
    expect(validateAutomationDefinitionSpec(draft({ triggerKind: "event_upcoming", conditions: { sourceId: "event-legacy_42" } })).ok).toBe(true);
    for (const invalid of ["bad-id", [id], { toString: () => id }]) {
      expect(validateAutomationDefinitionSpec(draft({ id: invalid })).errors).toContain("definition_id");
      expect(validateAutomationDefinitionSpec(draft({ actionKind: "notify_in_app", actionConfig: { recipientId: invalid } })).errors).toContain("action_recipient");
    }
    for (const expectedVersion of [0, -1, "1", 1.5, NaN, Infinity]) {
      expect(validateAutomationDefinitionSpec(draft({ expectedVersion })).errors).toContain("expected_version");
    }
  });

  it("rejects source/action mismatches even if both capabilities are independently installed", () => {
    for (const trigger of AUTOMATION_TRIGGER_METADATA) {
      for (const action of AUTOMATION_ACTION_METADATA) {
        const compatible = action.sources.includes(trigger.source);
        expect(isAutomationCapabilityAvailable(installed(), trigger.id, action.id)).toBe(compatible);
        const spec = draft({ triggerKind: trigger.id, thresholdDays: trigger.thresholdMode === "none" ? 0 : 3, actionKind: action.id });
        expect(validateAutomationDefinitionSpec(spec, { allowIncomplete: true }).errors.includes("action_kind")).toBe(!compatible);
      }
    }
  });

  it("requires action-specific setup and refuses unrelated or invalid action keys", () => {
    for (const [actionKind, key] of [["assign_task", "assigneeId"], ["notify_in_app", "recipientId"]]) {
      expect(validateAutomationDefinitionSpec(draft({ actionKind })).errors).toContain("action_recipient");
      expect(validateAutomationDefinitionSpec(draft({ actionKind }), { allowIncomplete: true }).ok).toBe(true);
      expect(validateAutomationDefinitionSpec(draft({ actionKind, actionConfig: { [key]: id } })).ok).toBe(true);
      expect(validateAutomationDefinitionSpec(draft({ actionKind, actionConfig: { [key]: "" } }), { allowIncomplete: true }).errors).toContain("action_recipient");
    }
    expect(validateAutomationDefinitionSpec(draft({ actionKind: "raise_task_priority", actionConfig: { priority: "medium" } })).ok).toBe(true);
    expect(validateAutomationDefinitionSpec(draft({ actionKind: "raise_task_priority", actionConfig: { priority: "high" } })).ok).toBe(true);
    expect(validateAutomationDefinitionSpec(draft({ actionKind: "raise_task_priority", actionConfig: { priority: "low" } })).errors).toContain("action_priority");
    expect(validateAutomationDefinitionSpec(draft({ actionKind: "assign_task", actionConfig: { recipientId: id } })).errors).toContain("action_config");
  });

  it("allows a missing draft name but does not allow a malformed supplied name during incomplete validation", () => {
    expect(validateAutomationDefinitionSpec(draft({ name: undefined }), { allowIncomplete: true }).ok).toBe(true);
    for (const name of ["ab", "x".repeat(81), "name\nwith control", "name\u007f", {}, []]) {
      expect(validateAutomationDefinitionSpec(draft({ name })).errors).toContain("name");
      expect(validateAutomationDefinitionSpec(draft({ name }), { allowIncomplete: true }).errors).toContain("name");
    }
  });
});

describe("installed automation capability parsing", () => {
  it("accepts a known subset and freezes detached lists without mutating the server response", () => {
    const payload = installed({ triggers: ["task_due"], actions: ["create_standard_task"], cadences: ["daily"], maxThresholdDays: 7 });
    const normalized = normalizeAutomationCapabilities(payload);
    expect(normalized).toEqual(payload);
    expect(Object.isFrozen(normalized)).toBe(true);
    for (const key of ["triggers", "actions", "cadences"]) {
      expect(Object.isFrozen(normalized[key])).toBe(true);
      expect(normalized[key]).not.toBe(payload[key]);
    }
    payload.triggers.push("event_upcoming");
    expect(normalized.triggers).toEqual(["task_due"]);
    expect(isAutomationCapabilityAvailable(normalized, "event_upcoming", "create_standard_task")).toBe(false);
  });

  it.each([
    [], 1, "capabilities", {}, Object.create({ schemaVersion: 2 }),
    installed({ schemaVersion: 3 }), installed({ schemaVersion: "2" }),
    installed({ unknown: true }), installed({ triggers: [] }), installed({ actions: [] }),
    installed({ cadences: [] }), installed({ triggers: "task_due" }),
    installed({ actions: ["send_email"] }), installed({ triggers: ["invented"] }),
    installed({ cadences: ["minutely"] }), installed({ triggers: ["task_due", "task_due"] }),
    installed({ actions: ["notify_in_app", "notify_in_app"] }), installed({ cadences: ["daily", "daily"] }),
    installed({ maxThresholdDays: 91 }), installed({ maxThresholdDays: -1 }),
    installed({ maxThresholdDays: "90" }), installed({ maxThresholdDays: 1.5 }),
    installed({ schemaVersion: 1 }), installed({ schemaVersion: 1, triggers: ["overdue_task"], actions: ["notify_in_app"] }),
    installed({ triggers: [null] }), installed({ actions: [undefined] }),
  ])("refuses malformed server capability surfaces: %j", (payload) => {
    expect(normalizeAutomationCapabilities(payload)).toBeNull();
    expect(isAutomationCapabilityAvailable(payload, "task_due", "create_standard_task")).toBe(false);
  });

  it("rejects sparse allowlists rather than normalizing holes into installed capabilities", () => {
    for (const key of ["triggers", "actions", "cadences"]) {
      expect(normalizeAutomationCapabilities(installed({ [key]: new Array(1) }))).toBeNull();
    }
  });
});
