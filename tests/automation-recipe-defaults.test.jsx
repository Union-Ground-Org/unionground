// REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001: client contract for the
// restored default recipes, the stale_member_contact trigger and alert routing.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_TRIGGER_METADATA, normalizeAutomationCapabilities, validateAutomationDefinitionSpec } from "../src/features/automation/capabilities.js";
import {
  normalizeAutomationControlRoom, normalizeAutomationDefinition, normalizeAutomationRoutingRules, validRoutingRuleDraft,
} from "../src/features/automation/controlPlane.js";
import { AutomationDefaultRecipes, AutomationRoutingRules } from "../src/features/automation/AutomationRoutingRules.jsx";
import { createAutomationRecipeDraft } from "../src/features/automation/recipes.js";
import { createAutomationApi } from "../src/lib/mi1AutomationWiring.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { BusyTestHost, expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const ORG = "50900000-0000-4000-8000-000000000001";
const DEFINITION = "50900000-0000-4000-8000-000000000101";
const RULE = "50900000-0000-4000-8000-000000000201";

const recipeRow = (overrides = {}) => ({
  id: DEFINITION, name: "Follow up on quiet member contact", schemaVersion: 2, triggerKind: "stale_member_contact",
  thresholdDays: 14, taskPriority: "medium", actionKind: "create_standard_task", conditions: {}, actionConfig: {},
  cadence: "daily", status: "active", version: 1, nextRunAt: null, lastRunAt: null, createdAt: null, updatedAt: null,
  reviewStatus: "approved", reviewVersion: 1, submittedBySelf: false, submittedAt: null, reviewedAt: null, reviewNote: null,
  canEdit: true, canSubmit: false, canReview: false, canActivate: true, canPreview: true,
  recipeKey: "stale_contact_followup", scheduledAuthority: "approver", dependencyReady: true, ...overrides,
});

const ruleRow = (overrides = {}) => ({
  id: RULE, name: "Overdue task escalation to the assignee", eventKind: "overdue_task", routeTo: "source_owner",
  enabled: true, isDefault: true, sortOrder: 30, priorities: ["high"], chapterId: null, updatedAt: "2026-10-02T06:00:00.000Z", ...overrides,
});

const capabilities = { schemaVersion: 2, triggers: AUTOMATION_TRIGGER_METADATA.map((row) => row.id), actions: ["create_standard_task"], cadences: ["daily"], maxThresholdDays: 90 };

function translated(node, lang = "en") {
  return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

describe("stale_member_contact trigger", () => {
  it("is an installed case trigger that needs at least one day", () => {
    expect(normalizeAutomationCapabilities(capabilities).triggers).toContain("stale_member_contact");
    const spec = { schemaVersion: 2, name: "Quiet contact", triggerKind: "stale_member_contact", thresholdDays: 14, cadence: "daily", taskPriority: "medium", conditions: {}, actionKind: "create_standard_task", actionConfig: {} };
    expect(validateAutomationDefinitionSpec(spec)).toEqual({ ok: true, errors: [] });
    expect(validateAutomationDefinitionSpec({ ...spec, thresholdDays: 0 }).errors).toContain("threshold_days");
    expect(validateAutomationDefinitionSpec({ ...spec, actionKind: "assign_task", actionConfig: { assigneeId: DEFINITION } }).errors).toContain("action_kind");
  });

  it("has a catalogue recipe that opens an unsaved casework draft", () => {
    const draft = createAutomationRecipeDraft("stale-member-contact-follow-up", { capabilities });
    expect(draft).toMatchObject({ triggerKind: "stale_member_contact", thresholdDays: 14, actionKind: "create_standard_task" });
  });
});

describe("default recipe definitions", () => {
  it("keeps the recipe key and requires an approver for an active recipe", () => {
    expect(normalizeAutomationDefinition(recipeRow())).toMatchObject({ recipeKey: "stale_contact_followup", scheduledAuthority: "approver", canEdit: true });
    expect(normalizeAutomationDefinition(recipeRow({ status: "draft", reviewStatus: "draft", reviewVersion: null,
      scheduledAuthority: "pending_approval", dependencyReady: false, canActivate: false }))).toMatchObject({ scheduledAuthority: "pending_approval" });
  });

  it("still refuses canEdit on an approved custom definition and an unknown recipe key", () => {
    expect(normalizeAutomationDefinition(recipeRow({ recipeKey: null, scheduledAuthority: "approver" }))).toBeNull();
    expect(normalizeAutomationDefinition(recipeRow({ recipeKey: "made_up" }))).toBeNull();
    expect(normalizeAutomationDefinition(recipeRow({ recipeKey: null, scheduledAuthority: "pending_approval", canEdit: false }))).toBeNull();
    expect(normalizeAutomationDefinition(recipeRow({ canSubmit: true }))).toBeNull();
    expect(normalizeAutomationDefinition(recipeRow({ thresholdDays: 0 }))).toBeNull();
  });

  it("preserves a plain review note and refuses a note with control characters", () => {
    expect(normalizeAutomationDefinition(recipeRow({ reviewNote: "Ready for the chapter" }))).toMatchObject({ reviewNote: "Ready for the chapter" });
    expect(normalizeAutomationDefinition(recipeRow({ reviewNote: "Ready\tfor the chapter" }))).toBeNull();
  });

  it("carries the default-recipe switches from the workspace and refuses a malformed block", () => {
    const payload = { organizationId: ORG, capabilities, settings: { enabled: true, maxEffectsPerRun: 20 }, definitions: [recipeRow()], runs: [], defaultRecipes: { enabled: true, alertRoutingEnabled: false } };
    expect(normalizeAutomationControlRoom(payload, ORG).defaultRecipes).toEqual({ enabled: true, alertRoutingEnabled: false });
    expect(normalizeAutomationControlRoom({ ...payload, defaultRecipes: undefined }, ORG).defaultRecipes).toBeNull();
    expect(normalizeAutomationControlRoom({ ...payload, defaultRecipes: { enabled: "yes", alertRoutingEnabled: true } }, ORG)).toBeNull();
  });
});

describe("routing rules contract", () => {
  it("normalizes rule pages and validates drafts", () => {
    expect(normalizeAutomationRoutingRules({ organizationId: ORG, enabled: true, canManage: true, rules: [ruleRow()] }).rules[0]).toMatchObject({ routeTo: "source_owner", priorities: ["high"] });
    expect(normalizeAutomationRoutingRules({ enabled: true, canManage: true, rules: [ruleRow({ routeTo: "everyone" })] })).toBeNull();
    expect(normalizeAutomationRoutingRules({ enabled: true, canManage: true, rules: [ruleRow({ priorities: ["urgent"] })] })).toBeNull();
    expect(validRoutingRuleDraft({ name: "Quiet contact to stewards", eventKind: "stale_member_contact", routeTo: "chapter_stewards", enabled: true, priorities: null })).toBe(true);
    expect(validRoutingRuleDraft({ name: "No", eventKind: "stale_member_contact", routeTo: "chapter_stewards", enabled: true })).toBe(false);
    expect(validRoutingRuleDraft({ name: "Wrong event", eventKind: "event_upcoming", routeTo: "coordinators", enabled: true })).toBe(false);
  });

  it("preserves the routing name boundaries and priority validation", () => {
    const draft = { name: "X".repeat(80), eventKind: "overdue_task", routeTo: "coordinators", enabled: true, priorities: ["high"] };
    expect(validRoutingRuleDraft(draft)).toBe(true);
    expect(validRoutingRuleDraft({ ...draft, name: draft.name + "X" })).toBe(false);
    expect(validRoutingRuleDraft({ ...draft, priorities: ["urgent"] })).toBe(false);
    expect(normalizeAutomationRoutingRules({ enabled: true, canManage: true, rules: [ruleRow({ name: draft.name + "X" })] })).toBeNull();
    expect(normalizeAutomationRoutingRules({ enabled: true, canManage: true, rules: [ruleRow({ name: "A\tBC" })] })).toBeNull();
  });

  it("calls the approver RPC with the closed rule shape only", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { organizationId: ORG, ...ruleRow() }, error: null });
    const api = createAutomationApi({ rpc });
    const session = { authenticated: true, selectedOrganizationId: ORG, membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true, role: "admin" };
    const result = await api.saveRoutingRule(session, { name: " Quiet contact ", eventKind: "stale_member_contact", routeTo: "coordinators", enabled: true, priorities: null, extra: "dropped" });
    expect(result).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("mi1_save_automation_routing_rule", { p_rule: { name: "Quiet contact", eventKind: "stale_member_contact", routeTo: "coordinators", enabled: true, priorities: null, chapterId: null, sortOrder: 100 } });
    expect(await api.saveRoutingRule(session, { name: "x", eventKind: "overdue_task", routeTo: "coordinators", enabled: true })).toEqual({ ok: false, reason: "invalid_action" });
    expect(await api.deleteRoutingRule(session, "not-a-uuid")).toEqual({ ok: false, reason: "invalid_action" });
    // A steward may read rules but the approver-only writer refuses before any RPC.
    rpc.mockClear();
    expect(await api.saveRoutingRule({ ...session, role: "steward" }, { name: "Quiet contact", eventKind: "stale_member_contact", routeTo: "coordinators", enabled: true })).toMatchObject({ ok: false, reason: "role_denied" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("routing and default recipe panels", () => {
  const control = (overrides = {}) => normalizeAutomationControlRoom({
    organizationId: ORG, capabilities, settings: { enabled: true, maxEffectsPerRun: 20 }, definitions: [recipeRow()], runs: [],
    defaultRecipes: { enabled: true, alertRoutingEnabled: true }, ...overrides,
  }, ORG);

  it.each([{}, { getRoutingRules: vi.fn().mockRejectedValue(new Error("access revoked")) }])(
    "shows no private rules when routing is unavailable", async (api) => {
      translated(<AutomationRoutingRules api={api} session={{}} act={vi.fn()} busy={false} revision={0} />);
      expect(await screen.findByText("This record is unavailable or you no longer have access. Private information is not shown.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Save routing rule" })).toBeNull();
    },
  );

  // A rule's Delete stays focusable while its owner's write runs,
  // and refuses a second deletion.
  it("keeps a rule's Delete focused while it is deleted, and deletes it once", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const api = { getRoutingRules: vi.fn().mockResolvedValue({ ok: true, data: normalizeAutomationRoutingRules({ organizationId: ORG, enabled: true, canManage: true, rules: [ruleRow()] }) }), deleteRoutingRule: vi.fn(async () => ({ ok: true, data: null })) };
      translated(<BusyTestHost>{(pending, run) => <AutomationRoutingRules api={api} session={{}} act={(work) => run(work)} busy={pending} revision={0} />}</BusyTestHost>);
      const remove = await screen.findByRole("button", { name: /^Delete rule: Overdue task escalation/ });
      await expectHeldWriteFocus(api.deleteRoutingRule, remove);
      expect(api.deleteRoutingRule).toHaveBeenCalledExactlyOnceWith({}, RULE);
    } finally {
      confirm.mockRestore();
    }
  });

  it("preserves campaign and custom priority restrictions when displaying read-only rules", async () => {
    const api = { getRoutingRules: vi.fn().mockResolvedValue({ ok: true, data: {
      enabled: true, canManage: false,
      rules: [ruleRow({ priorities: null }), ruleRow({ id: "second", priorities: ["medium"], chapterId: "chapter", enabled: false })],
    } }) };
    translated(<AutomationRoutingRules api={api} session={{}} act={vi.fn()} busy={false} revision={0} />);
    expect(await screen.findByText(/Selected priorities/)).toHaveTextContent("One campaign");
    expect(screen.queryByRole("button", { name: /Enable rule/ })).toBeNull();
  });

  it("lists default recipes with their switch states and opens one", () => {
    const open = vi.fn();
    translated(<AutomationDefaultRecipes control={control()} open={open} />);
    expect(screen.getByRole("heading", { name: "Default recipes" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Feature switches and limits" })).toHaveAttribute("href", expect.stringContaining("/m/admin/configuration"));
    fireEvent.click(screen.getByRole("button", { name: "Open default recipe: Follow up on quiet member contact" }));
    expect(open).toHaveBeenCalledWith("definition", { definition: DEFINITION });
  });

  it("says plainly when default recipes are off or waiting on the master switch", () => {
    const { unmount } = translated(<AutomationDefaultRecipes control={control({ definitions: [], defaultRecipes: { enabled: false, alertRoutingEnabled: true } })} open={vi.fn()} />);
    expect(screen.getByText("Default recipes are switched off for this organization.")).toBeVisible();
    unmount();
    translated(<AutomationDefaultRecipes control={control({ settings: { enabled: false, maxEffectsPerRun: 20 } })} open={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("master switch is paused");
  });

  it.each([
    ["en", "Rule name", "Save routing rule", "Use 3 to 80 characters for the rule name. Leading and trailing whitespace does not count. Some characters, such as emoji, can count as more than one.", "Remove tabs and other control characters from the rule name."],
    ["es", "Nombre de la regla", "Guardar regla de enrutamiento", "Usa de 3 a 80 caracteres para el nombre de la regla. Los espacios en blanco al principio y al final no cuentan. Algunos caracteres, como los emojis, pueden contar como más de uno.", "Quita las tabulaciones y otros caracteres de control del nombre de la regla."],
  ])("explains a blocked routing-rule save in %s", async (lang, nameLabel, saveLabel, lengthReason, controlReason) => {
    const api = {
      getRoutingRules: vi.fn().mockResolvedValue({ ok: true, data: { enabled: true, canManage: true, rules: [] } }),
      saveRoutingRule: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    };
    const act = vi.fn(async (work) => (await work()).data);
    translated(<AutomationRoutingRules api={api} session={{}} act={act} busy={false} revision={0} />, lang);
    const save = await screen.findByRole("button", { name: saveLabel });
    const name = screen.getByRole("textbox", { name: nameLabel });

    fireEvent.change(name, { target: { value: " Ab " } });
    expect(save).toHaveAccessibleDescription(lengthReason);
    expect(save.nextElementSibling).toHaveTextContent(lengthReason);
    expectRefusedEveryWay(save, lengthReason, () => api.saveRoutingRule.mock.calls.length > 0 || act.mock.calls.length > 0);

    fireEvent.change(name, { target: { value: "A\tBC" } });
    expectRefusedEveryWay(save, controlReason, () => api.saveRoutingRule.mock.calls.length > 0 || act.mock.calls.length > 0);

    fireEvent.change(name, { target: { value: "A😀" } });
    expect(save).not.toHaveAttribute("aria-disabled");
    expect(save).not.toHaveAccessibleDescription();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveRoutingRule).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ name: "A😀" })));
    await waitFor(() => expect(name).toHaveValue(""));
  });

  it("lets an approver toggle, delete and add rules", async () => {
    const api = {
      getRoutingRules: vi.fn().mockResolvedValue({ ok: true, data: { enabled: true, canManage: true, rules: [ruleRow()] } }),
      saveRoutingRule: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      deleteRoutingRule: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    };
    const act = vi.fn((work) => Promise.resolve(work()).then((result) => result.data));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    translated(<AutomationRoutingRules api={api} session={{}} act={act} busy={false} revision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable rule: Overdue task escalation to the assignee" }));
    expect(api.saveRoutingRule).toHaveBeenCalledWith({}, expect.objectContaining({ id: RULE, enabled: false, priorities: ["high"] }));
    fireEvent.click(screen.getByRole("button", { name: "Delete rule: Overdue task escalation to the assignee" }));
    expect(api.deleteRoutingRule).toHaveBeenCalledWith({}, RULE);
    const save = screen.getByRole("button", { name: "Save routing rule" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Quiet contact to stewards" } });
    fireEvent.change(screen.getByLabelText("When an automation creates a task for"), { target: { value: "stale_member_contact" } });
    fireEvent.change(screen.getByLabelText("Notify"), { target: { value: "chapter_stewards" } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveRoutingRule).toHaveBeenLastCalledWith({}, { name: "Quiet contact to stewards", eventKind: "stale_member_contact", routeTo: "chapter_stewards", enabled: true, priorities: null }));
  });

  it("is read-only for authors who are not approvers and states a switched-off routing", async () => {
    const api = { getRoutingRules: vi.fn().mockResolvedValue({ ok: true, data: { enabled: false, canManage: false, rules: [ruleRow()] } }) };
    translated(<AutomationRoutingRules api={api} session={{}} act={vi.fn()} busy={false} revision={0} />, "es");
    expect(await screen.findByText("Solo la Administración o la Presidencia pueden cambiar las reglas de enrutamiento.")).toBeVisible();
    expect(screen.getByText(/El enrutamiento de alertas está desactivado/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Desactivar regla/ })).toBeNull();
  });
});
