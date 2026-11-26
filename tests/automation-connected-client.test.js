import { describe, expect, it, vi } from "vitest";
import { createAutomationApi, normalizeAutomationEffect } from "../src/lib/mi1AutomationWiring.js";
import { AUTOMATION_RPCS, normalizeAutomationDefinition } from "../src/features/automation/controlPlane.js";
import {
  automationContextFromSearch, automationEffectHref, automationSourceHref,
  automationWorkflowHref, validAutomationSource,
} from "../src/features/automation/links.js";

const organizationId = "50900000-0000-4000-8000-000000000108";
const definitionId = "50900000-0000-4000-8000-000000000109";
const runId = "50900000-0000-4000-8000-000000000110";
const sourceId = "50900000-0000-4000-8000-000000000111";
const taskId = "50900000-0000-4000-8000-000000000112";
const effectId = "50900000-0000-4000-8000-000000000113";
const caseId = "50900000-0000-4000-8000-000000000114";
const session = {
  authenticated: true, selectedOrganizationId: organizationId, mfaSatisfied: true,
  membershipStatus: "active", organizationStatus: "active", role: "admin",
  selectedHat: "admin", organizationRoles: ["admin", "vp"],
};
const stewardSession = { ...session, role: "steward", selectedHat: "steward", organizationRoles: ["steward"] };
const specification = (patch = {}) => ({
  schemaVersion: 2, name: "  Review upcoming tasks  ", triggerKind: "task_due", thresholdDays: "3",
  cadence: "daily", taskPriority: "medium", conditions: { chapterId: "chapter-1", sourceId },
  actionKind: "create_standard_task", actionConfig: {}, ...patch,
});
const definition = (patch = {}) => ({
  ...specification(), name: "Review upcoming tasks", thresholdDays: 3,
  id: definitionId, status: "draft", version: 1, ...patch,
});
const reviewedDefinition = (patch = {}) => definition({
  reviewStatus: "draft", reviewVersion: null, submittedBySelf: false,
  submittedAt: null, reviewedAt: null, reviewNote: null,
  canEdit: true, canSubmit: true, canReview: false, canActivate: false, canPreview: true,
  ...patch,
});
const capabilities = {
  schemaVersion: 2, triggers: ["task_due"], actions: ["create_standard_task"],
  cadences: ["daily"], maxThresholdDays: 90,
};
const workspace = (patch = {}) => ({
  organizationId,
  access: { canAuthor: true, canApprove: false, canOperate: false },
  settings: { enabled: false, maxEffectsPerRun: 20 },
  schedulerConfigured: true,
  capabilities,
  definitions: [reviewedDefinition()],
  runs: [],
  ...patch,
});
const run = (patch = {}) => ({
  id: runId, definitionId, definitionName: "Review upcoming tasks", mode: "manual", status: "succeeded",
  candidatesCount: 1, effectsCreated: 1, ...patch,
});
const effect = (patch = {}) => ({
  id: effectId, sourceKind: "task", sourceId, sourceAvailable: true, taskId,
  effectAvailable: true, status: "created", actionKind: "create_standard_task", ...patch,
});
const page = (rows = [], patch = {}) => ({ rows, total: rows.length, page: 1, pageSize: 20, ...patch });
const transport = (data) => {
  const rpc = vi.fn().mockResolvedValue({ data: { organizationId, ...data }, error: null });
  return { rpc, api: createAutomationApi({ rpc }) };
};

describe("connected automation client requests", () => {
  it("splits staff author calls from Admin/President consequential authority", async () => {
    const rpc = vi.fn(async (name) => ({
      data: name === AUTOMATION_RPCS.getWorkspace ? workspace()
        : name === AUTOMATION_RPCS.getOpportunities
          ? { capabilityVersion: 2, observedAt: "2026-09-10T12:00:00Z", rows: [{ triggerKind: "task_due", candidateCount: 3, thresholdDays: 3, scope: "chapter", covered: false }] }
          : { organizationId, id: definitionId, version: 1 },
      error: null,
    }));
    const api = createAutomationApi({ rpc });

    expect((await api.getWorkspace(stewardSession)).state).toBe("ready");
    expect((await api.getOpportunities(stewardSession)).data.rows[0]).toEqual({ triggerKind: "task_due", candidateCount: 3, thresholdDays: 3, scope: "chapter", covered: false });
    expect((await api.saveDefinition(stewardSession, specification())).ok).toBe(true);
    expect((await api.previewDefinition(stewardSession, definitionId)).ok).toBe(true);
    expect((await api.submitDefinition(stewardSession, definitionId, 1)).ok).toBe(true);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      AUTOMATION_RPCS.getWorkspace, AUTOMATION_RPCS.getOpportunities,
      AUTOMATION_RPCS.saveDefinitionV2, AUTOMATION_RPCS.previewDefinition,
      AUTOMATION_RPCS.submitDefinition,
    ]);

    rpc.mockClear();
    for (const request of [
      () => api.reviewDefinition(stewardSession, definitionId, 1, "approve"),
      () => api.setDefinitionStatus(stewardSession, definitionId, "active", 1),
      () => api.setEnabled(stewardSession, true, "ENABLE AUTOMATION"),
      () => api.setSafetyCap(stewardSession, 20),
      () => api.executeRun(stewardSession, runId, "RUN 50900000"),
      () => api.rollbackRun(stewardSession, runId, "ROLL BACK 50900000"),
    ]) expect(await request()).toEqual(expect.objectContaining({ ok: false, reason: "role_denied" }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed review and permission projections as a whole", async () => {
    expect(normalizeAutomationDefinition(reviewedDefinition({ canActivate: true }))).toBeNull();
    expect(normalizeAutomationDefinition(reviewedDefinition({ reviewStatus: "invented" }))).toBeNull();
    expect(normalizeAutomationDefinition(reviewedDefinition({ reviewStatus: "submitted", reviewVersion: 2 }))).toBeNull();
    expect(normalizeAutomationDefinition(reviewedDefinition({ reviewNote: "x".repeat(501) }))).toBeNull();
    const approved = normalizeAutomationDefinition(reviewedDefinition({
      reviewStatus: "approved", reviewVersion: 1, canEdit: false, canSubmit: false,
      canActivate: true, reviewedAt: "2026-09-10T12:00:00Z",
    }));
    expect(approved).toMatchObject({ reviewStatus: "approved", reviewVersion: 1, canActivate: true });
    expect(Object.isFrozen(approved)).toBe(true);

    const { api, rpc } = transport(workspace({ access: { canAuthor: true, canApprove: "yes", canOperate: false } }));
    expect(await api.getWorkspace(stewardSession)).toEqual({ state: "unavailable", control: null });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(AUTOMATION_RPCS.getWorkspace, undefined);
  });

  it("omits absent identity/version on new saves for the strict database contract", async () => {
    const { api, rpc } = transport({ id: definitionId });
    expect((await api.saveDefinition(session, specification())).ok).toBe(true);
    const spec = rpc.mock.calls[0][1].p_definition;
    expect(spec).not.toHaveProperty("id");
    expect(spec).not.toHaveProperty("expectedVersion");
    expect(spec.thresholdDays).toBe(3);
  });

  it("sends typed task priority and assignment filters without widening other source families", async () => {
    const { api, rpc } = transport({ id: definitionId });
    const conditions = { priority: "high", assignment: "assigned" };
    expect((await api.saveDefinition(session, specification({ conditions }))).ok).toBe(true);
    expect(rpc.mock.calls[0][1].p_definition.conditions).toEqual(conditions);
    for (const patch of [
      { conditions: { priority: "urgent" } }, { conditions: { assignment: true } },
      { triggerKind: "event_upcoming", conditions },
      { triggerKind: "unassigned_task", thresholdDays: 0, conditions },
    ]) {
      rpc.mockClear();
      expect(await api.saveDefinition(session, specification(patch))).toEqual({ ok: false, reason: "invalid_action" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("retains an exact evaluated snapshot without exposing redacted source references", async () => {
    const { api, rpc } = transport({ run: run({ definitionVersion: 1,
      definitionSnapshotAvailable: true, definition: definition({ sourceFilterAvailable: false }) }), effects: page([]) });
    const result = await api.getRun(session, runId);
    expect(result.ok).toBe(true);
    expect(result.data.run.definitionSnapshotAvailable).toBe(true);
    expect(result.data.run.definition).toMatchObject({ version: 1, sourceFilterAvailable: false, conditions: { chapterId: "chapter-1" } });
    expect(result.data.run.definition.conditions).not.toHaveProperty("sourceId");
    for (const snapshot of [definition({ id: sourceId }), definition({ version: 2 }), { triggerKind: "invented" }, null]) {
      rpc.mockResolvedValue({ data: { organizationId, run: run({ definitionVersion: 1,
        definitionSnapshotAvailable: true, definition: snapshot }), effects: page([]) }, error: null });
      expect(await api.getRun(session, runId)).toMatchObject({ ok: false, reason: "unavailable" });
    }
  });

  it("does not invent evaluated conditions for historical unsnapshotted runs", async () => {
    const { api } = transport({ run: run({ definition: definition(), definitionSnapshotAvailable: false }), effects: page([]) });
    expect((await api.getRun(session, runId)).data.run).toMatchObject({ definition: null, definitionSnapshotAvailable: false });
  });

  it("sends the exact v2 definition contract without a legacy fallback or caller authority fields", async () => {
    const { api, rpc } = transport({ id: definitionId });
    const fields = specification({ id: definitionId, version: 4, organizationId: "not-authority", enabled: true });
    expect((await api.saveDefinition(session, fields)).ok).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mi1_save_automation_definition_v2", {
      p_definition: {
        schemaVersion: 2, id: definitionId, expectedVersion: 4, name: "Review upcoming tasks",
        triggerKind: "task_due", thresholdDays: 3, cadence: "daily", taskPriority: "medium",
        conditions: { chapterId: "chapter-1", sourceId }, actionKind: "create_standard_task", actionConfig: {},
      },
    });
    rpc.mockClear();
    expect(await api.saveDefinition(session, specification({ schemaVersion: 999 }))).toEqual({ ok: false, reason: "invalid_action" });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await api.saveDefinition(session, specification())).toEqual({ ok: false, reason: "persistence_unset" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(AUTOMATION_RPCS.saveDefinitionV2);
  });

  it.each(["", " ", "1.5", "NaN", "91", null, false, true, [], [3]].map((value) => [value]))(
    "rejects malformed v2 threshold input before transport: %j", async (thresholdDays) => {
      const { api, rpc } = transport({ id: definitionId });
      expect(await api.saveDefinition(session, specification({ thresholdDays }))).toEqual({ ok: false, reason: "invalid_action" });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("maps a staff-draft missing-scope refusal to a distinct scope reason, not a generic denial", async () => {
    const { api, rpc } = transport({ id: definitionId });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "staff drafts require visible chapter or source scope" } });
    expect(await api.saveDefinition(session, specification())).toEqual({ ok: false, reason: "scope_required" });
    // Other 42501 refusals keep their existing mapping.
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "active automation author role required" } });
    expect(await api.saveDefinition(session, specification())).toEqual({ ok: false, reason: "role_denied" });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "multi-factor authentication required" } });
    expect(await api.saveDefinition(session, specification())).toEqual({ ok: false, reason: "mfa_required" });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "mfa required" } });
    expect(await api.saveDefinition(session, specification())).toEqual({ ok: false, reason: "mfa_required" });
  });

  it("sends bounded paginated definition filters and normalizes v2 rows", async () => {
    const { api, rpc } = transport(page([definition()], { page: 2, pageSize: 6, total: 7 }));
    const result = await api.getDefinitions(session, { page: 2, pageSize: 6, search: "review", status: "draft" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mi1_get_automation_definitions", {
      p_page: 2, p_page_size: 6, p_search: "review", p_status: "draft",
    });
    expect(result.ok).toBe(true);
    expect(result.data.organizationId).toBe(organizationId);
    expect(result.data.rows[0]).toMatchObject({ schemaVersion: 2, conditions: { chapterId: "chapter-1", sourceId } });
  });

  it("sends definition, status and UTC time filters for run history", async () => {
    const { api, rpc } = transport(page([run()], { page: 2, pageSize: 6, total: 7 }));
    const from = "2026-09-01T00:00:00Z", to = "2026-09-10T00:00:00.000Z";
    expect((await api.getRuns(session, { page: 2, pageSize: 6, definitionId, status: "succeeded", from, to })).ok).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mi1_get_automation_runs", {
      p_page: 2, p_page_size: 6, p_definition_id: definitionId, p_status: "succeeded", p_from: from, p_to: to,
    });
  });

  it("reads an exact definition and an exact run with independently bounded effects", async () => {
    const { api, rpc } = transport({ definition: definition() });
    expect((await api.getDefinition(session, definitionId)).ok).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("mi1_get_automation_definition", { p_definition_id: definitionId });
    rpc.mockResolvedValue({ data: { organizationId, run: run(), effects: page([effect()], { page: 3, pageSize: 5, total: 11 }) }, error: null });
    const result = await api.getRun(session, runId, { page: 3, pageSize: 5 });
    expect(result.ok).toBe(true);
    expect(result.data.effects).toMatchObject({ total: 11, page: 3, pageSize: 5 });
    expect(rpc).toHaveBeenLastCalledWith("mi1_get_automation_run", { p_run_id: runId, p_page: 3, p_page_size: 5 });
    rpc.mockResolvedValue({ data: { organizationId, definition: definition({ id: sourceId }) }, error: null });
    expect(await api.getDefinition(session, definitionId)).toEqual({ ok: false, reason: "unavailable" });
    rpc.mockResolvedValue({ data: { organizationId, run: run({ id: sourceId }), effects: page([]) }, error: null });
    expect(await api.getRun(session, runId)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("normalizes the real checklist persistence discriminator into canonical case navigation", async () => {
    const { api } = transport({ run: run(), effects: page([effect({ sourceKind: "checklist", caseId })]) });
    const result = await api.getRun(session, runId);
    expect(result.ok).toBe(true);
    expect(result.data.effects.rows[0]).toMatchObject({ sourceKind: "case_checklist", sourceId, caseId });
    expect(automationSourceHref(result.data.effects.rows[0], "coordinator")).toContain(caseId);
    expect(automationSourceHref(result.data.effects.rows[0], "coordinator")).not.toContain(sourceId);
  });

  it("preserves the server's unavailable source marker on definition detail", async () => {
    const { api } = transport({ definition: definition({ conditions: {}, sourceFilterAvailable: false }) });
    const result = await api.getDefinition(session, definitionId);
    expect(result.ok).toBe(true);
    expect(result.data.definition.sourceFilterAvailable).toBe(false);
    expect(result.data.definition.conditions).not.toHaveProperty("sourceId");
  });

  it("requests real chapter/person options with pagination and no synthetic board identifiers", async () => {
    const { api, rpc } = transport({
      chapters: page([{ id: "chapter-1", label: "Chapter one" }]),
      assignees: page([{ id: sourceId, label: "Selected staff member" }]),
      recipients: page([{ id: taskId, label: "Selected recipient" }]),
    });
    const result = await api.getScopeOptions(session, { source: "task", chapterId: "chapter-1", search: "Selected" });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mi1_get_automation_scope_options", {
      p_page: 1, p_page_size: 20, p_source: "task", p_chapter_id: "chapter-1", p_search: "Selected",
    });
    expect(result.data).not.toHaveProperty("boards");
    rpc.mockResolvedValue({ data: { organizationId, chapters: page([]), assignees: page([{ id: "not-a-person-uuid", label: "Wrong" }]), recipients: page([]) }, error: null });
    expect(await api.getScopeOptions(session, { source: "task" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("resolves an authorized source context without retaining extra sensitive response fields", async () => {
    const { api, rpc } = transport({ sourceKind: "event", sourceId: "event-legacy_1", chapterId: "chapter-1", privateNotes: "never expose" });
    const result = await api.getSourceContext(session, "event", "event-legacy_1");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mi1_get_automation_source_context", { p_source: "event", p_source_id: "event-legacy_1" });
    expect(result.data).toEqual({ organizationId, sourceKind: "event", sourceId: "event-legacy_1", chapterId: "chapter-1" });
    for (const patch of [{ sourceId: "different-event" }, { sourceKind: "task" }, { chapterId: "bad\nchapter" }]) {
      rpc.mockResolvedValue({ data: { organizationId, sourceKind: "event", sourceId: "event-legacy_1", chapterId: "chapter-1", ...patch }, error: null });
      expect(await api.getSourceContext(session, "event", "event-legacy_1")).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("checks authorization before any read or write reaches transport", async () => {
    const { api, rpc } = transport({});
    for (const invalidSession of [{}, { ...session, role: "member" }, { ...session, mfaSatisfied: false }, { ...session, membershipStatus: "inactive" }]) {
      const requests = [
        () => api.saveDefinition(invalidSession, specification()), () => api.getDefinitions(invalidSession),
        () => api.getRuns(invalidSession), () => api.getDefinition(invalidSession, definitionId),
        () => api.getRun(invalidSession, runId), () => api.getScopeOptions(invalidSession, { source: "task" }),
        () => api.getSourceContext(invalidSession, "task", sourceId),
        () => api.setEnabled(invalidSession, true, "ENABLE AUTOMATION"),
      ];
      for (const request of requests) expect((await request()).ok).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses wrong-tenant response envelopes on every connected read", async () => {
    const { api, rpc } = transport({ organizationId: sourceId, ...page([definition()]), definition: definition(), run: run(), effects: page([]), chapters: page([]), assignees: page([]), recipients: page([]), sourceKind: "task", sourceId, chapterId: "chapter-1" });
    for (const request of [
      () => api.getDefinitions(session), () => api.getRuns(session), () => api.getDefinition(session, definitionId),
      () => api.getRun(session, runId), () => api.getScopeOptions(session, { source: "task" }),
      () => api.getSourceContext(session, "task", sourceId),
    ]) expect(await request()).toEqual({ ok: false, reason: "unavailable" });
    expect(rpc).toHaveBeenCalledTimes(6);
  });

  it("rejects malformed result pages and invalid rows as a whole instead of dropping bad rows", async () => {
    const { api, rpc } = transport({});
    for (const malformed of [
      page([definition()], { total: -1 }), page([definition()], { total: 0 }), page([definition()], { total: "1" }),
      page([definition()], { page: 0 }), page([definition()], { page: 1.5 }), page([definition()], { pageSize: 51 }),
      page([definition()], { pageSize: 0 }), page([definition()], { rows: {} }),
      page([definition(), definition({ triggerKind: "unsupported" })]),
      page(Array.from({ length: 51 }, () => definition()), { pageSize: 50 }),
    ]) {
      rpc.mockResolvedValue({ data: { organizationId, ...malformed }, error: null });
      expect(await api.getDefinitions(session)).toEqual({ ok: false, reason: "unavailable" });
    }
    rpc.mockResolvedValue({ data: { organizationId, run: run(), effects: page([effect(), effect({ sourceKind: "unknown" })]) }, error: null });
    expect(await api.getRun(session, runId)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("rejects bad paging, filters, time ranges and source references before transport", async () => {
    const { api, rpc } = transport({});
    const requests = [
      ...[{ page: 0 }, { page: "1" }, { page: 10001 }, { pageSize: 51 }, { pageSize: -1 }, { search: "x".repeat(81) }, { status: "unknown" }].map((options) => () => api.getDefinitions(session, options)),
      ...[{ definitionId: "bad" }, { from: "2026-09-01" }, { from: "2026-09-01T00:00:00+00:00" }, { from: "2026-09-10T00:00:00Z", to: "2026-09-01T00:00:00Z" }, { status: "unknown" }].map((options) => () => api.getRuns(session, options)),
      () => api.getDefinition(session, "bad"), () => api.getRun(session, [runId]),
      () => api.getScopeOptions(session, { source: "unknown" }), () => api.getScopeOptions(session, { source: "task", chapterId: "bad\nchapter" }),
      () => api.getSourceContext(session, "casework_deadline", sourceId), () => api.getSourceContext(session, "task", "event-id"),
    ];
    for (const request of requests) expect(await request()).toEqual({ ok: false, reason: "invalid_action" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([false, 0, ""])("rejects supplied non-UUID run definition filters: %j", async (definitionId) => {
    const { api, rpc } = transport(page([]));
    expect(await api.getRuns(session, { definitionId })).toEqual({ ok: false, reason: "invalid_action" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a calendar-invalid UTC instant instead of relying on Date.parse rollover", async () => {
    const { api, rpc } = transport(page([]));
    expect(await api.getRuns(session, { from: "2026-02-30T00:00:00Z" })).toEqual({ ok: false, reason: "invalid_action" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("safe automation traces and workflow links", () => {
  it("redacts unavailable source/effect IDs and never spreads stored snapshots into client data", () => {
    const result = normalizeAutomationEffect(effect({
      sourceAvailable: false, effectAvailable: false, caseId,
      beforeState: { privateText: "secret" }, afterState: { privateText: "secret" }, recipientId: sourceId,
    }));
    expect(result).toMatchObject({ sourceId: null, taskId: null, caseId: null, sourceAvailable: false, effectAvailable: false });
    expect(result).not.toHaveProperty("beforeState");
    expect(result).not.toHaveProperty("afterState");
    expect(result).not.toHaveProperty("recipientId");
    expect(automationSourceHref(result)).toBeNull();
    expect(automationEffectHref(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(normalizeAutomationEffect(effect({ reasonCode: "arbitrary sensitive text" }))).toBeNull();
  });

  it("supports explicit text event identifiers but rejects unknown sources and malformed references", () => {
    expect(validAutomationSource("event", "event-legacy_42")).toBe(true);
    expect(validAutomationSource("task", "event-legacy_42")).toBe(false);
    expect(automationContextFromSearch(`?sourceKind=task&sourceId=${sourceId}`)).toEqual({ sourceKind: "task", sourceId });
    expect(automationContextFromSearch("?sourceKind=event&sourceId=event-legacy_42")).toEqual({ sourceKind: "event", sourceId: "event-legacy_42" });
    for (const sourceKind of ["unknown", "__proto__", "organization", "https://example.test"]) {
      expect(automationContextFromSearch(`?sourceKind=${encodeURIComponent(sourceKind)}&sourceId=${sourceId}`)).toBeNull();
      expect(automationWorkflowHref(session, sourceKind, sourceId)).toBeNull();
      expect(automationSourceHref(effect({ sourceKind }))).toBeNull();
    }
    expect(automationContextFromSearch(`?sourceKind=casework_deadline&sourceId=${sourceId}`)).toBeNull();
    for (const bad of ["../path", "//host", "https://example.test", "<script>", "x".repeat(129)]) {
      expect(validAutomationSource("event", bad)).toBe(false);
      expect(automationSourceHref(effect({ sourceKind: "event", sourceId: bad }))).toBeNull();
    }
  });

  it("keeps links in the explicitly selected authorized hat, not a stronger available membership", () => {
    expect(automationWorkflowHref(session, "task", sourceId)).toBe(`/m/automations/recipes?sourceKind=task&sourceId=${sourceId}`);
    expect(automationWorkflowHref({ ...session, role: "vp", selectedHat: "vp" }, "event", "event-1")).toBe("/m/automations/recipes?sourceKind=event&sourceId=event-1");
    expect(automationWorkflowHref(stewardSession, "task", sourceId)).toBe(`/m/automations/recipes?sourceKind=task&sourceId=${sourceId}`);
    for (const patch of [
      { selectedHat: "steward" }, { selectedHat: "vp" }, { role: "vp" }, { organizationRoles: ["vp"] },
      { organizationRoles: undefined }, { mfaSatisfied: false }, { membershipStatus: "inactive" },
      { selectedHat: undefined }, { role: "member", selectedHat: "member" },
    ]) expect(automationWorkflowHref({ ...session, ...patch }, "task", sourceId)).toBeNull();
  });

  it("does not treat a string as an organization-role list", () => {
    expect(automationWorkflowHref({ ...session, organizationRoles: "admin" }, "task", sourceId)).toBeNull();
  });

  // BUG-UG-AUTOMATION-CASE-SOURCE-DESTINATION-20261020: a case source
  // opens the staff case surface of the explicitly selected hat, never the
  // fenced Member Cases page, and no usable link is offered where the hat has none.
  it("uses authorized canonical case IDs for deadline/checklist links rather than their child record IDs", () => {
    for (const sourceKind of ["casework_deadline", "case_checklist"]) {
      expect(automationSourceHref(effect({ sourceKind, caseId }), "coordinator")).toBe(`/m/coordinator?case=${caseId}`);
      expect(automationSourceHref(effect({ sourceKind, caseId }), "steward")).toBe(`/m/steward?case=${caseId}`);
      expect(automationSourceHref(effect({ sourceKind, caseId: null }), "coordinator")).toBeNull();
      for (const hat of ["admin", "vp", "advisor", "member", "", null, undefined, "__proto__", "constructor"]) {
        expect(automationSourceHref(effect({ sourceKind, caseId }), hat)).toBeNull();
      }
    }
    expect(automationSourceHref(effect({ sourceKind: "case", caseId: null, sourceId: caseId }), "coordinator")).toBe(`/m/coordinator?case=${caseId}`);
    expect(automationSourceHref(effect({ sourceKind: "case", caseId: null, sourceId: caseId }), "admin")).toBeNull();
    expect(automationSourceHref(effect({ sourceKind: "case_checklist", caseId, sourceAvailable: false }), "coordinator")).toBeNull();
    // Task, event and appointment sources do not depend on the hat.
    for (const hat of ["admin", "coordinator", null]) {
      expect(automationSourceHref(effect(), hat)).toBe(`/m/tasks/board?task=${sourceId}`);
      expect(automationSourceHref(effect({ sourceKind: "event", sourceId: "evt-1" }), hat)).toBe("/m/events?event=evt-1");
      expect(automationSourceHref(effect({ sourceKind: "appointment", sourceId: caseId }), hat)).toBe(`/m/appointments?appointment=${caseId}`);
    }
    expect(automationEffectHref(effect())).toBe(`/m/tasks/board?task=${taskId}`);
    expect(automationEffectHref(effect({ taskId: "bad" }))).toBeNull();
  });
});
