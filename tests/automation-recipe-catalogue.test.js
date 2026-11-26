import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_ACTION_METADATA,
  AUTOMATION_TRIGGER_METADATA,
  LEGACY_AUTOMATION_CAPABILITIES,
  normalizeAutomationCapabilities,
  validateAutomationDefinitionSpec,
} from "../src/features/automation/capabilities.js";
import {
  AUTOMATION_RECIPES,
  AUTOMATION_RECIPE_GROUPS,
  createAutomationRecipeDraft,
  getAutomationRecipe,
  getAutomationRecipeAvailability,
  searchAutomationRecipes,
} from "../src/features/automation/recipes.js";

const capabilities = normalizeAutomationCapabilities({
  schemaVersion: 2,
  triggers: AUTOMATION_TRIGGER_METADATA.map((entry) => entry.id),
  actions: AUTOMATION_ACTION_METADATA.map((entry) => entry.id),
  cadences: ["hourly", "daily", "weekly"],
  maxThresholdDays: 90,
});
const chosenPerson = "50900000-0000-4000-8000-000000000109";

afterEach(() => vi.unstubAllGlobals());

describe("connected automation recipe catalogue", () => {
  it("offers 24+ operationally distinct recipes across all four workflows and 12+ real triggers", () => {
    expect(AUTOMATION_RECIPES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(AUTOMATION_RECIPES.map((entry) => entry.id)).size).toBe(AUTOMATION_RECIPES.length);
    expect(new Set(AUTOMATION_RECIPES.map((entry) => entry.group))).toEqual(new Set(["tasks", "casework", "appointments", "events"]));
    expect(new Set(AUTOMATION_RECIPES.map((entry) => entry.draft.triggerKind)).size).toBeGreaterThanOrEqual(12);
    // Do not count a renamed, priority-only, cadence-only or threshold-only clone.
    const predicatesAndActions = AUTOMATION_RECIPES.map(({ draft }) => JSON.stringify({
      triggerKind: draft.triggerKind,
      conditions: draft.conditions,
      actionKind: draft.actionKind,
    }));
    expect(new Set(predicatesAndActions).size).toBe(AUTOMATION_RECIPES.length);
    expect(new Set(AUTOMATION_RECIPES.map((entry) => entry.draft.actionKind))).toEqual(new Set([
      "create_standard_task", "assign_task", "raise_task_priority", "notify_in_app",
    ]));
  });

  it.each(AUTOMATION_RECIPES)("$id has complete bilingual guidance and a valid installed draft contract", (entry) => {
    for (const field of ["title", "description", "outcome", "conditionSummary", "source", "action", "destination", "safety"]) {
      for (const locale of ["en", "es"]) expect(entry[field][locale].length, `${entry.id}.${field}.${locale}`).toBeGreaterThan(10);
    }
    expect(entry.prerequisites.length).toBeGreaterThanOrEqual(2);
    for (const prerequisite of entry.prerequisites) {
      expect(prerequisite.key).toMatch(/^[a-zA-Z_]+$/);
      expect(prerequisite.label.en.length).toBeGreaterThan(10);
      expect(prerequisite.label.es.length).toBeGreaterThan(10);
    }
    const draft = createAutomationRecipeDraft(entry.id, { capabilities });
    expect(validateAutomationDefinitionSpec(draft, { allowIncomplete: true })).toEqual({ ok: true, errors: [] });
    const requiresPerson = ["assign_task", "notify_in_app"].includes(draft.actionKind);
    expect(getAutomationRecipeAvailability(entry, capabilities).status).toBe(requiresPerson ? "missing_setup" : "available");
    if (draft.actionKind === "assign_task") draft.actionConfig.assigneeId = chosenPerson;
    if (draft.actionKind === "notify_in_app") draft.actionConfig.recipientId = chosenPerson;
    expect(validateAutomationDefinitionSpec(draft)).toEqual({ ok: true, errors: [] });
    expect(validateAutomationDefinitionSpec({ ...draft, name: entry.title.es })).toEqual({ ok: true, errors: [] });
  });

  it("offers honest deadline and follow-up predicates instead of invented event completion", () => {
    const deadlineRecipes = AUTOMATION_RECIPES.filter((entry) => entry.draft.triggerKind === "casework_deadline");
    expect(new Set(deadlineRecipes.map((entry) => entry.draft.conditions.deadlineKind))).toEqual(new Set([
      "filing", "response", "hearing", "appeal", "follow_up",
    ]));
    for (const entry of deadlineRecipes) expect(entry.conditionSummary.en).toContain("overdue or due within");
    for (const entry of AUTOMATION_RECIPES.filter((row) => row.draft.triggerKind === "event_followup")) {
      expect(entry.conditionSummary.en).toContain("recorded start");
      expect(entry.conditionSummary.en).not.toMatch(/ended|completed|finished/);
      expect(entry.conditionSummary.es).toContain("inicio registrado");
    }
    const followupStatuses = AUTOMATION_RECIPES.filter((entry) => entry.draft.triggerKind === "appointment_followup")
      .map((entry) => entry.draft.conditions.status);
    expect(new Set(followupStatuses)).toEqual(new Set(["completed", "no_show"]));
    for (const entry of AUTOMATION_RECIPES) expect(entry.draft.conditions).not.toHaveProperty("boardId");
  });

  it("requires a genuine chosen recipient or assignee and never fills one from an invented actor", () => {
    for (const [id, key] of [["unassigned-task-routing", "assigneeId"], ["blocked-task-notice", "recipientId"]]) {
      const entry = getAutomationRecipe(id);
      expect(entry.draft.actionConfig).toEqual({});
      expect(getAutomationRecipeAvailability(entry, capabilities)).toEqual({ status: "missing_setup", missing: [key] });
      expect(getAutomationRecipeAvailability(entry, capabilities, { [key]: "self" })).toEqual({ status: "missing_setup", missing: [key] });
      expect(getAutomationRecipeAvailability(entry, capabilities, { [key]: chosenPerson })).toEqual({ status: "available", missing: [] });
      expect(validateAutomationDefinitionSpec(createAutomationRecipeDraft(id, { capabilities })).ok).toBe(false);
    }
  });

  it("fails closed for absent, legacy, malformed or selectively missing installed capabilities", () => {
    const id = "overdue-task-review";
    for (const unavailable of [undefined, null, {}, LEGACY_AUTOMATION_CAPABILITIES,
      { ...capabilities, triggers: ["unknown_trigger"] },
      { ...capabilities, actions: ["notify_in_app"] },
      { ...capabilities, triggers: ["case_deadline"] },
      { ...capabilities, cadences: ["weekly"] },
      { ...capabilities, maxThresholdDays: 0 },
    ]) {
      expect(getAutomationRecipeAvailability(id, unavailable)).toEqual({ status: "not_installed", missing: [] });
      expect(() => createAutomationRecipeDraft(id, { capabilities: unavailable })).toThrow("automation_recipe_not_installed");
    }
    expect(getAutomationRecipeAvailability("not-a-recipe", capabilities)).toEqual({ status: "not_installed", missing: [] });
    expect(() => createAutomationRecipeDraft("not-a-recipe", { capabilities })).toThrow("automation_recipe_unknown");
  });

  it("creates only detached unsaved draft state without a network call or implicit activation", () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network write"); });
    vi.stubGlobal("fetch", fetch);
    const draft = createAutomationRecipeDraft("casework-filing-preparation", { locale: "es", capabilities });
    expect(draft.name).toBe(getAutomationRecipe("casework-filing-preparation").title.es);
    expect(Object.keys(draft).sort()).toEqual([
      "actionConfig", "actionKind", "cadence", "conditions", "name", "schemaVersion", "taskPriority", "thresholdDays", "triggerKind",
    ]);
    draft.conditions.deadlineKind = "hearing";
    draft.actionConfig.recipientId = chosenPerson;
    draft.name = "Edited locally";
    const second = createAutomationRecipeDraft("casework-filing-preparation", { capabilities });
    expect(second.conditions.deadlineKind).toBe("filing");
    expect(second.actionConfig).toEqual({});
    expect(second.name).toBe(getAutomationRecipe("casework-filing-preparation").title.en);
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.isFrozen(AUTOMATION_RECIPES)).toBe(true);
    expect(Object.isFrozen(getAutomationRecipe("casework-filing-preparation").draft.conditions)).toBe(true);
  });

  it("does not trust a caller-supplied recipe body or resolve unknown identifiers to a default", () => {
    const spoofed = { ...getAutomationRecipe("blocked-task-notice"), draft: { triggerKind: "overdue_task", actionKind: "create_standard_task" } };
    expect(getAutomationRecipeAvailability(spoofed, capabilities)).toEqual({ status: "missing_setup", missing: ["recipientId"] });
    expect(getAutomationRecipe("__proto__")).toBeNull();
    expect(getAutomationRecipe({ id: "overdue-task-review" })).toBeNull();
  });
});

describe("bilingual recipe discovery", () => {
  it("searches English and Spanish content independently of display locale and ignores accents", () => {
    expect(searchAutomationRecipes({ query: "hearing" }).items.map((entry) => entry.id)).toContain("casework-hearing-preparation");
    expect(searchAutomationRecipes({ query: "apelacion" }).items.map((entry) => entry.id)).toContain("casework-appeal-preparation");
    expect(searchAutomationRecipes({ query: "  CITA   COMPLETADA " }).items.map((entry) => entry.id)).toContain("completed-appointment-follow-up");
    expect(searchAutomationRecipes({ query: "bloqueo" }).items.every((entry) => entry.group === "tasks")).toBe(true);
    expect(AUTOMATION_RECIPE_GROUPS.map((group) => group.label.es)).toContain("Gestión de casos");
  });

  it("filters real workflows and returns a useful empty result without showing unrelated recipes", () => {
    const result = searchAutomationRecipes({ group: "appointments", pageSize: 12 });
    expect(result.total).toBe(3);
    expect(result.items.every((entry) => entry.group === "appointments")).toBe(true);
    expect(searchAutomationRecipes({ group: "events", query: "appeal" })).toEqual({ items: [], total: 0, page: 1, pageSize: 6, pageCount: 0 });
    expect(searchAutomationRecipes({ group: "not-a-workflow" }).total).toBe(0);
    expect(searchAutomationRecipes({ query: "no such recipe exists here" }).total).toBe(0);
  });

  it("bounds pages at 12 cards, defaults to six and clamps invalid or stale page requests", () => {
    const first = searchAutomationRecipes();
    expect(first.items).toHaveLength(6);
    expect(first.total).toBe(AUTOMATION_RECIPES.length);
    expect(first.pageCount).toBe(Math.ceil(AUTOMATION_RECIPES.length / 6));
    const second = searchAutomationRecipes({ page: 2 });
    expect(second.items.some((entry) => first.items.includes(entry))).toBe(false);
    expect(searchAutomationRecipes({ page: 999 }).page).toBe(first.pageCount);
    expect(searchAutomationRecipes({ page: -10 }).page).toBe(1);
    expect(searchAutomationRecipes({ page: NaN, pageSize: Infinity }).pageSize).toBe(6);
    expect(searchAutomationRecipes({ pageSize: 10000 }).items).toHaveLength(12);
    expect(searchAutomationRecipes({ pageSize: 0 }).items).toHaveLength(1);
    expect(searchAutomationRecipes({ group: "appointments", page: 10 }).page).toBe(1);
    const all = Array.from({ length: first.pageCount }, (_, index) => searchAutomationRecipes({ page: index + 1 }).items).flat();
    expect(all).toEqual(AUTOMATION_RECIPES);
  });
});
