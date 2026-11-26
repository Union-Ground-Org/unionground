import { describe, expect, it, vi } from "vitest";
import {
  authorizeAutomationControl,
  definitionDraft,
  normalizeAutomationControlRoom,
  validDefinitionDraft,
} from "../src/features/automation/controlPlane.js";
import { createAutomationApi, MI1_AUTOMATION_DONOR } from "../src/lib/mi1AutomationWiring.js";

const organizationId = "50900000-0000-4000-8000-000000000108";
const definitionId = "50900000-0000-4000-8000-000000000109";
const runId = "50900000-0000-4000-8000-000000000110";
const session = {
  authenticated: true,
  selectedOrganizationId: organizationId,
  mfaSatisfied: true,
  membershipStatus: "active",
  organizationStatus: "active",
  role: "admin",
};

function payload(overrides = {}) {
  return {
    organizationId,
    schedulerConfigured: true,
    settings: { enabled: false, maxEffectsPerRun: 20, updatedAt: null },
    definitions: [{
      id: definitionId,
      name: "Overdue review queue",
      triggerKind: "overdue_task",
      thresholdDays: 1,
      actionKind: "create_standard_task",
      taskPriority: "high",
      cadence: "daily",
      status: "active",
      version: 2,
    }],
    runs: [{
      id: runId,
      definitionId,
      definitionName: "Overdue review queue",
      mode: "manual",
      status: "succeeded",
      candidatesCount: 3,
      effectsCreated: 2,
      effectsSkipped: 1,
      effectsFailed: 0,
      rollbackEligible: true,
      rollbackPhrase: "ROLL BACK 50900000",
    }],
    ...overrides,
  };
}

describe("CR-108 automation client boundary", () => {
  it("fails closed for inactive, weak-MFA, and unauthorized sessions", () => {
    expect(authorizeAutomationControl({})).toEqual({ ok: false, reason: "session_inactive" });
    expect(authorizeAutomationControl({ ...session, mfaSatisfied: false })).toEqual({ ok: false, reason: "mfa_required" });
    expect(authorizeAutomationControl({ ...session, role: "steward" })).toEqual({ ok: false, reason: "role_denied" });
    expect(authorizeAutomationControl({ ...session, role: "vp" })).toEqual({ ok: true, organizationId });
  });

  it("rejects wrong-tenant or malformed persistence payloads", () => {
    expect(normalizeAutomationControlRoom(payload(), organizationId)?.definitions).toHaveLength(1);
    // dependencyReady passes through only as an exact boolean.
    const withDependency = (value) => normalizeAutomationControlRoom(payload({ definitions: [{ ...payload().definitions[0], dependencyReady: value }] }), organizationId)?.definitions[0];
    expect(withDependency(false)).toMatchObject({ dependencyReady: false });
    expect(withDependency(true)).toMatchObject({ dependencyReady: true });
    expect(withDependency(null)).not.toHaveProperty("dependencyReady");
    expect(normalizeAutomationControlRoom(payload(), "50900000-0000-4000-8000-000000000999")).toBeNull();
    expect(normalizeAutomationControlRoom(payload({ settings: { maxEffectsPerRun: 51 } }), organizationId)).toBeNull();
    expect(normalizeAutomationControlRoom(payload({ definitions: [{ ...payload().definitions[0], actionKind: "post_webhook" }] }), organizationId)).toBeNull();
    expect(normalizeAutomationControlRoom(payload({ runs: [{ ...payload().runs[0], status: "unknown" }] }), organizationId)).toBeNull();
  });

  it("keeps definition inputs bounded and unassigned-case thresholds fixed at zero", () => {
    expect(definitionDraft().triggerKind).toBe("overdue_task");
    expect(validDefinitionDraft({
      name: "Unassigned cases",
      triggerKind: "unassigned_case",
      thresholdDays: "0",
      cadence: "hourly",
      taskPriority: "medium",
    })).toBe(true);
    expect(validDefinitionDraft({
      name: "Unassigned cases",
      triggerKind: "unassigned_case",
      thresholdDays: "1",
      cadence: "hourly",
      taskPriority: "medium",
    })).toBe(false);
    expect(validDefinitionDraft({
      name: "bad\nname",
      triggerKind: "overdue_task",
      thresholdDays: "1",
      cadence: "daily",
      taskPriority: "high",
    })).toBe(false);
  });

  it("calls only the approved RPC vocabulary with typed database arguments", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: definitionId }, error: null });
    const api = createAutomationApi({ rpc });
    await api.saveDefinition(session, {
      name: "  Overdue review queue  ",
      triggerKind: "overdue_task",
      thresholdDays: "2",
      cadence: "weekly",
      taskPriority: "high",
    });
    expect(rpc).toHaveBeenCalledWith("save_organization_automation_definition", {
      p_definition_id: null,
      p_name: "Overdue review queue",
      p_trigger_kind: "overdue_task",
      p_threshold_days: 2,
      p_cadence: "weekly",
      p_task_priority: "high",
      p_expected_version: null,
    });
    await api.executeRun(session, runId, "RUN 50900000");
    expect(rpc).toHaveBeenLastCalledWith("execute_organization_automation_run", {
      p_run_id: runId,
      p_confirmation: "RUN 50900000",
    });

    await api.setDefinitionStatus(session, definitionId, "paused", 3);
    expect(rpc).toHaveBeenLastCalledWith("set_organization_automation_definition_status", {
      p_definition_id: definitionId,
      p_status: "paused",
      p_expected_version: 3,
    });
    await api.setEnabled(session, false, "PAUSE AUTOMATION");
    expect(rpc).toHaveBeenLastCalledWith("set_organization_automation_enabled", {
      p_enabled: false,
      p_confirmation: "PAUSE AUTOMATION",
    });
    await api.setSafetyCap(session, "7");
    expect(rpc).toHaveBeenLastCalledWith("set_organization_automation_safety_cap", {
      p_max_effects_per_run: 7,
    });
    await api.previewRun(session, definitionId);
    expect(rpc).toHaveBeenLastCalledWith("preview_organization_automation_run", {
      p_definition_id: definitionId,
    });
    await api.rollbackRun(session, runId, "ROLL BACK 50900000");
    expect(rpc).toHaveBeenLastCalledWith("rollback_organization_automation_run", {
      p_run_id: runId,
      p_confirmation: "ROLL BACK 50900000",
    });
  });

  it("maps missing persistence and SQL failures to stable UI states", async () => {
    expect(await createAutomationApi(null).load(session)).toEqual({ state: "persistence_unset", control: null });
    const stale = createAutomationApi({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PT409" } }) });
    expect(await stale.setDefinitionStatus(session, definitionId, "paused", 2)).toEqual({ ok: false, reason: "stale_definition" });
    const denied = createAutomationApi({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) });
    expect(await denied.setSafetyCap(session, 10)).toEqual({ ok: false, reason: "role_denied" });
  });

  it.each([
    [{ code: "PGRST202" }, "persistence_unset"],
    [{ status: "42883" }, "persistence_unset"],
    [{ message: "could not find the function" }, "persistence_unset"],
    [{ message: "MFA required for this operation" }, "mfa_required"],
    [{ message: "mfa required" }, "mfa_required"],
    [{ message: "multi-factor authentication required", code: "42501" }, "mfa_required"],
    [{ message: "active automation author role required", code: "42501" }, "role_denied"],
    [{ code: "42501", message: "permission denied for table" }, "role_denied"],
    [{ code: "42501", message: "appointment supervision required" }, "appointment_supervision"],
    [{ code: "23505" }, "duplicate_name"],
    [{ code: "22023" }, "invalid_action"],
    [{ code: "23514" }, "invalid_action"],
    [{ code: "XX000", message: "database unavailable" }, "unavailable"],
  ])("maps database failure %j to %s", async (error, reason) => {
    const api = createAutomationApi({ rpc: vi.fn().mockResolvedValue({ data: null, error }) });
    expect(await api.setSafetyCap(session, 10)).toEqual({ ok: false, reason });
  });

  it("fails closed when RPC transport throws or returns a malformed control-room payload", async () => {
    const thrown = createAutomationApi({ rpc: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(await thrown.previewRun(session, definitionId)).toEqual({ ok: false, reason: "unavailable" });

    const malformed = createAutomationApi({ rpc: vi.fn().mockResolvedValue({
      data: payload({ organizationId: "50900000-0000-4000-8000-000000000999" }),
      error: null,
    }) });
    expect(await malformed.load(session)).toEqual({ state: "unavailable", control: null });
  });

  it("rejects calls before transport for a weak session", async () => {
    const rpc = vi.fn();
    const api = createAutomationApi({ rpc });
    expect(await api.setEnabled({ ...session, mfaSatisfied: false }, true, "ENABLE AUTOMATION"))
      .toEqual({ ok: false, reason: "mfa_required" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("pins the donor baseline and rejects donor credentials and tenant assumptions", () => {
    expect(MI1_AUTOMATION_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MI1_AUTOMATION_DONOR.inspected).toContain("lib/crm/automation-rollback.ts");
    expect(MI1_AUTOMATION_DONOR.rejected.join(" ")).toMatch(/service-role keys/i);
    expect(MI1_AUTOMATION_DONOR.rejected.join(" ")).toMatch(/tenant assumptions/i);
  });
});
