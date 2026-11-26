import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedAutomationPages } from "../src/features/automation/ConnectedAutomationPages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AUTOMATION_TRIGGER_METADATA, AUTOMATION_ACTION_METADATA } from "../src/features/automation/capabilities.js";
import { useWorkspace } from "../src/components/WorkspacePages.jsx";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

vi.mock("../src/components/WorkspacePages.jsx", async (importOriginal) => ({ ...await importOriginal(), useWorkspace: vi.fn() }));
const organizationId = "50900000-0000-4000-8000-000000000108";
const definitionId = "50900000-0000-4000-8000-000000000109";
const runId = "50900000-0000-4000-8000-000000000110";
const personId = "50900000-0000-4000-8000-000000000111";
const capabilities = { schemaVersion: 2, triggers: AUTOMATION_TRIGGER_METADATA.map((item) => item.id), actions: AUTOMATION_ACTION_METADATA.map((item) => item.id), cadences: ["hourly", "daily", "weekly"], maxThresholdDays: 90 };
const session = { authenticated: true, selectedOrganizationId: organizationId, mfaSatisfied: true, role: "admin", selectedHat: "admin", organizationRoles: ["admin"], membershipStatus: "active", organizationStatus: "active" };
const page = (rows = [], total = rows.length, current = 1) => ({ rows, total, page: current, pageSize: 6 });
const scopeOptionsMock = ({ chapters, people }) => {
  const slice = (rows, current) => ({ rows: rows.slice((current - 1) * 6, current * 6), total: rows.length, page: current, pageSize: 6 });
  return vi.fn().mockImplementation(async (_session, { search = "", page: current = 1 } = {}) => {
    const needle = search.trim().toLowerCase();
    const pick = (rows) => (needle ? rows.filter((item) => item.label.toLowerCase().includes(needle)) : rows);
    return { ok: true, data: { chapters: slice(pick(chapters), current), assignees: slice(pick(people), current), recipients: slice(pick(people), current) } };
  });
};
const definition = { id: definitionId, name: "Review overdue work", schemaVersion: 2, triggerKind: "overdue_task", thresholdDays: 1, taskPriority: "medium", cadence: "daily", actionKind: "create_standard_task", actionConfig: {}, conditions: {}, status: "active", version: 3 };
const run = { id: runId, definitionId, definitionName: definition.name, status: "succeeded", candidatesCount: 3, effectsCreated: 2, effectsSkipped: 1, effectsFailed: 0, rollbackEligible: true, rollbackPhrase: "ROLL BACK 50900000" };
function setup({ tab = "definitions", lang = "en", enabled = false, control: controlOverrides = {}, overrides = {}, query = "", accessToken = null, requestCompass, member = session } = {}) {
  const control = { organizationId, capabilities, settings: { enabled, maxEffectsPerRun: 20 }, schedulerConfigured: true, definitions: [], runs: [], ...controlOverrides };
  const api = {
    load: vi.fn().mockResolvedValue({ state: "ready", control }),
    getDefinitions: vi.fn().mockResolvedValue({ ok: true, data: page() }),
    getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition } }),
    getRuns: vi.fn().mockResolvedValue({ ok: true, data: page() }),
    getRun: vi.fn().mockResolvedValue({ ok: true, data: { run, effects: page() } }),
    getScopeOptions: vi.fn().mockResolvedValue({ ok: true, data: { chapters: page([{ id: "chapter-a", label: "Chapter A" }]), assignees: page([{ id: personId, label: "Eligible staff" }]), recipients: page([{ id: personId, label: "Eligible staff" }]) } }),
    getSourceContext: vi.fn().mockImplementation(async (_, sourceKind, sourceId) => ({ ok: true, data: { sourceKind, sourceId, chapterId: "chapter-a" } })),
    getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", rows: [] } }),
    saveDefinition: vi.fn().mockResolvedValue({ ok: true, data: { id: definitionId } }),
    submitDefinition: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    reviewDefinition: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    setDefinitionStatus: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    setEnabled: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    setSafetyCap: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    previewRun: vi.fn().mockResolvedValue({ ok: true, data: { ...run, confirmationPhrase: "RUN 50900000", willCreate: 2 } }),
    executeRun: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    rollbackRun: vi.fn().mockResolvedValue({ ok: true, data: {} }), ...overrides,
  };
  let rendered;
  let activeSession = member; let activeApi = api;
  const onNotice = vi.fn();
  const tree = () => <LanguageProvider lang={lang}><ConnectedAutomationPages session={activeSession} accessToken={accessToken} api={activeApi} onNotice={onNotice} requestCompass={requestCompass} /></LanguageProvider>;
  const workspace = { view: "admin", page: { tab }, open: vi.fn((path) => {
    const event = new CustomEvent("sg:before-navigate", { cancelable: true, detail: { path } });
    if (!window.dispatchEvent(event)) return;
    window.history.replaceState({}, "", path);
    workspace.page = { tab: new URL(path, window.location.origin).pathname.split("/").at(-1) };
    rendered.rerender(tree());
  }) };
  window.history.replaceState({}, "", `/m/automations/${tab}${query}`);
  useWorkspace.mockImplementation(() => workspace);
  rendered = render(tree());
  return { api, workspace, control, onNotice, changeScope(nextSession, nextApi = api) { activeSession = nextSession; activeApi = nextApi; rendered.rerender(tree()); }, ...rendered };
}
beforeEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

describe("connected automation pages", () => {
  describe.each(["en", "es"])("staff form reasons (%s)", (lang) => {
    const spanish = lang === "es";
    // #9946 (W7-7 of #9470): Edit and Preview were greyed with no reason.
    it.each([
      ["approved", { status: "active", reviewStatus: "approved", canEdit: false, canPreview: true },
        ["You cannot edit it now that it is approved. To make a different one, start a Custom automation on the Automations page.", "No puedes editarla ahora que está aprobada. Para crear otra distinta, empieza una Automatización personalizada en la página Automatizaciones."], null],
      ["waiting for review", { status: "paused", reviewStatus: "submitted", canEdit: false, canPreview: true },
        ["You cannot edit it while it waits for review.", "No puedes editarla mientras espera revisión."], null],
      ["someone else's draft", { status: "draft", reviewStatus: "draft", canEdit: false, canPreview: false },
        ["You cannot edit it because you are not its author or an approver.", "No puedes editarla porque no eres su autor ni una persona que aprueba."],
        ["You do not have access to preview this draft.", "No tienes acceso para previsualizar este borrador."]],
      ["another chapter's", { status: "paused", reviewStatus: "changes_requested", canEdit: false, canPreview: false },
        ["You cannot edit it because you are not its author or an approver.", "No puedes editarla porque no eres su autor ni una persona que aprueba."],
        ["You do not have access to preview it.", "No tienes acceso para previsualizarla."]],
      ["archived", { status: "archived", reviewStatus: "approved", canEdit: false, canPreview: true },
        ["You cannot edit it because it is archived.", "No puedes editarla porque está archivada."],
        ["You cannot preview it because it is archived.", "No puedes previsualizarla porque está archivada."]],
      ["with its source gone", { status: "paused", reviewStatus: "draft", canEdit: true, canPreview: true, sourceFilterAvailable: false },
        ["You cannot edit or preview it here because the source it follows is no longer available.", "No puedes editarla ni previsualizarla aquí porque el origen que sigue ya no está disponible."],
        ["You cannot edit or preview it here because the source it follows is no longer available.", "No puedes editarla ni previsualizarla aquí porque el origen que sigue ya no está disponible."]],
    ])("states why Edit and Preview are unavailable on an automation that is %s", async (_label, fields, editReason, previewReason) => {
      const shown = { ...definition, ...fields };
      const { api, workspace } = setup({ tab: "definition", query: `?definition=${definitionId}`, lang, overrides: {
        getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: shown } }),
      } });
      const openedBuilder = () => workspace.open.mock.calls.some(([path]) => String(path).includes("builder"));
      const pick = (pair) => (pair ? pair[spanish ? 1 : 0] : null);
      const editButton = await screen.findByRole("button", { name: spanish ? "Editar" : "Edit" });
      const previewButton = screen.getByRole("button", { name: spanish ? "Vista previa" : "Preview" });
      expect(editButton).toHaveAccessibleDescription(pick(editReason));
      expectRefusedEveryWay(editButton, pick(editReason), openedBuilder);
      if (previewReason) {
        expect(previewButton).toHaveAccessibleDescription(pick(previewReason));
        expectRefusedEveryWay(previewButton, pick(previewReason), () => api.previewRun.mock.calls.length > 0);
      } else {
        expect(previewButton).not.toHaveAttribute("aria-disabled");
        expect(previewButton).not.toHaveAccessibleDescription();
      }
    });

    it("gives a working Edit and a working Preview no reason, and runs each", async () => {
      const editable = { ...definition, status: "paused", reviewStatus: "draft", canEdit: true, canPreview: true };
      const { api, workspace } = setup({ tab: "definition", query: `?definition=${definitionId}`, lang, overrides: {
        getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: editable } }),
      } });
      const editButton = await screen.findByRole("button", { name: spanish ? "Editar" : "Edit" });
      const previewButton = screen.getByRole("button", { name: spanish ? "Vista previa" : "Preview" });
      for (const button of [editButton, previewButton]) {
        expect(button).not.toHaveAttribute("aria-disabled");
        expect(button).not.toHaveAccessibleDescription();
      }
      fireEvent.click(previewButton);
      await waitFor(() => expect(api.previewRun).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: spanish ? "Editar" : "Edit" }));
      await waitFor(() => expect(workspace.open.mock.calls.some(([path]) => String(path).includes("builder"))).toBe(true));
    });


    it("names an unchanged or invalid safety cap and saves one valid update", async () => {
      const { api } = setup({ tab: "settings", lang, enabled: true });
      const field = await screen.findByRole("spinbutton", { name: spanish ? "Máximo de efectos por ejecución" : "Maximum effects per run" });
      const save = screen.getByRole("button", { name: spanish ? "Guardar" : "Save", exact: true });
      const unchanged = spanish ? "Cambia el límite antes de guardar." : "Change the limit before saving.";
      const range = spanish ? "Ingresa un número entero del 1 al 50." : "Enter a whole number from 1 to 50.";
      expect(save).toHaveAccessibleDescription(unchanged);
      expect(field).toHaveAccessibleDescription(range);
      expect(screen.getByText(range)).toBeVisible();
      expect(save.nextElementSibling).toBeVisible();
      expectRefusedEveryWay(save, unchanged, () => api.setSafetyCap.mock.calls.length > 0);

      fireEvent.change(field, { target: { value: "51" } });
      expect(save).toHaveAccessibleDescription(range);
      expectRefusedEveryWay(save, range, () => api.setSafetyCap.mock.calls.length > 0);
      fireEvent.change(field, { target: { value: "1.5" } });
      expect(save).toHaveAccessibleDescription(range);
      fireEvent.change(field, { target: { value: "50" } });
      expect(save).not.toHaveAttribute("aria-disabled");
      fireEvent.click(save);
      await waitFor(() => expect(api.setSafetyCap).toHaveBeenCalledExactlyOnceWith(session, 50));
    });

    it("explains a missing or nonmatching confirmation phrase and sends the exact phrase once", async () => {
      const { api } = setup({ tab: "settings", lang, enabled: true });
      fireEvent.click(await screen.findByRole("button", { name: spanish ? "Pausar todo" : "Pause all" }));
      const field = screen.getByRole("textbox", { name: /PAUSE AUTOMATION/ });
      const confirm = screen.getByRole("button", { name: spanish ? "Confirmar" : "Confirm", exact: true });
      const missing = spanish
        ? "Escribe la frase de confirmación tal como aparece, con las mismas mayúsculas y espacios."
        : "Type the confirmation phrase exactly as shown, including capitalization and spaces.";
      const mismatch = spanish
        ? "La frase de confirmación no coincide. Revisa las mayúsculas y los espacios."
        : "The confirmation phrase does not match. Check capitalization and spaces.";
      expect(confirm).toHaveAccessibleDescription(missing);
      expect(confirm.nextElementSibling).toBeVisible();
      expectRefusedEveryWay(confirm, missing, () => api.setEnabled.mock.calls.length > 0);

      fireEvent.change(field, { target: { value: "pause automation" } });
      expect(confirm).toHaveAccessibleDescription(mismatch);
      expectRefusedEveryWay(confirm, mismatch, () => api.setEnabled.mock.calls.length > 0);
      fireEvent.change(field, { target: { value: " PAUSE AUTOMATION " } });
      expect(confirm).toHaveAccessibleDescription(mismatch);
      fireEvent.submit(confirm.form);
      expect(api.setEnabled).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: "PAUSE AUTOMATION" } });
      expect(confirm).not.toHaveAttribute("aria-disabled");
      fireEvent.click(confirm);
      await waitFor(() => expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(session, false, "PAUSE AUTOMATION"));
    });

    it("asks for a review note beside Request changes and sends the trimmed note once", async () => {
      const submitted = { ...definition, status: "paused", reviewStatus: "submitted", canReview: true };
      const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, lang, overrides: {
        getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: submitted } }),
      } });
      const request = await screen.findByRole("button", { name: spanish ? "Solicitar cambios" : "Request changes" });
      const field = screen.getByRole("textbox", { name: spanish ? "Nota de revisión" : "Review note" });
      const required = spanish
        ? "Escribe una nota de revisión antes de solicitar cambios."
        : "Write a review note before requesting changes.";
      fireEvent.change(field, { target: { value: "   " } });
      expect(request).toHaveAccessibleDescription(required);
      expect(request.nextElementSibling).toBeVisible();
      expectRefusedEveryWay(request, required, () => api.reviewDefinition.mock.calls.length > 0);

      fireEvent.change(field, { target: { value: "  Clarify scope.  " } });
      expect(request).not.toHaveAttribute("aria-disabled");
      fireEvent.click(request);
      await waitFor(() => expect(api.reviewDefinition).toHaveBeenCalledExactlyOnceWith(session, definitionId, 3, "request_changes", "Clarify scope."));
    });
  });

  describe.each(["en", "es"])("specific Discover blocks (%s)", (lang) => {
    const spanish = lang === "es";
    it.each([
      ["session_inactive", /organization workspace is inactive/i, /espacio de tu organización está inactivo/i, "Contact support to restore workspace", "Contactar con soporte para restaurar el espacio", "/contact"],
      ["role_denied", /active staff role.*required to draft/i, /rol de personal activo.*crear borradores/i, "Request staff access", "Solicitar acceso de personal", "/m/settings/requests"],
      ["mfa_required", /Verify two-step sign-in to manage automation/, /Verifica el inicio en dos pasos para administrar la automatización/, "Verify two-step sign-in", "Verificar el inicio en dos pasos", "/m/settings/security"],
      ["persistence_unset", /Automation storage is not configured/, /El almacenamiento de automatización no está configurado/, "Contact support to set up automations", "Contactar con soporte para configurar automatizaciones", "/contact"],
    ])("names %s consistently without a dead retry", async (state, enReason, esReason, enAction, esAction, href) => {
      const coordinator = { ...session, role: "coordinator", selectedHat: "coordinator", organizationRoles: ["coordinator"] };
      const { api, container } = setup({ tab: "discover", lang, member: coordinator, overrides: { load: vi.fn().mockResolvedValue({ state }) } });
      const setupBlock = container.querySelector(".automation-pages__setup");
      await waitFor(() => expect(within(setupBlock).getByRole("status")).toHaveTextContent(spanish ? esReason : enReason));
      expect(within(setupBlock).queryByText(/Steward|Coordinator|Advisor|representante|coordinación|asesoría/)).toBeNull();
      const action = within(setupBlock).queryByRole("link", { name: spanish ? esAction : enAction });
      if (href) expect(action).toHaveAttribute("href", href);
      else expect(action).toBeNull();
      expect(screen.queryByRole("button", { name: /Try again|Intentar de nuevo|Reintentar/ })).toBeNull();
      const how = screen.getByRole("region", { name: spanish ? "Cómo funciona" : "How it works" });
      expect(how).not.toHaveTextContent(spanish ? /Puedes redactar/ : /You can draft/);
      const opportunities = screen.getByRole("region", { name: spanish ? "Oportunidades en tu alcance" : "Opportunities in your scope" });
      await waitFor(() => expect(within(opportunities).getByRole("status")).toHaveTextContent(spanish ? "Resuelve el problema del espacio descrito arriba" : "Resolve the workspace issue described above"));
      expect(within(opportunities).getByRole("status")).toHaveAccessibleDescription(spanish ? esReason : enReason);
      expect(screen.getAllByText(spanish ? esReason : enReason)).toHaveLength(1);
      expect(api.getOpportunities).not.toHaveBeenCalled();
      if (state === "persistence_unset") {
        expect(screen.queryByRole("button", { name: spanish ? "Crear borrador" : "Create draft" })).toBeNull();
        expect(screen.queryByRole("button", { name: spanish ? "Preguntar a la Guía" : "Ask the Guide" })).toBeNull();
      } else {
        expect(screen.getByRole("button", { name: spanish ? "Crear borrador" : "Create draft" })).toBeDisabled();
        expect(screen.getByRole("button", { name: spanish ? "Crear borrador" : "Create draft" })).toHaveAccessibleDescription(spanish ? esReason : enReason);
        expect(screen.getByRole("button", { name: spanish ? "Preguntar a la Guía" : "Ask the Guide" })).toBeDisabled();
        expect(screen.getByRole("button", { name: spanish ? "Preguntar a la Guía" : "Ask the Guide" })).toHaveAccessibleDescription(spanish ? esReason : enReason);
      }
    });
    it("recovers from a transient workspace read failure with one retry", async () => {
      const { api, control } = setup({ tab: "discover", lang, overrides: { load: vi.fn().mockResolvedValue({ state: "unavailable" }) } });
      const retry = await screen.findByRole("button", { name: spanish ? "Reintentar" : "Try again" });
      expect(screen.getAllByRole("button", { name: /Try again|Intentar de nuevo|Reintentar/ })).toHaveLength(1);
      api.load.mockResolvedValue({ state: "ready", control });
      fireEvent.click(retry);
      // A pending control stays enabled (record 8435): wait for its busy state to clear.
      await waitFor(() => { const control = screen.getByRole("button", { name: spanish ? "Crear borrador" : "Create draft" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
      expect(screen.getByText(spanish ? /Puedes redactar y previsualizar/ : /You can draft and preview/)).toBeVisible();
    });
    it("keeps recipes open with the same inactive-workspace reason", async () => {
      setup({ tab: "discover", lang, overrides: { load: vi.fn().mockResolvedValue({ state: "session_inactive" }) } });
      fireEvent.click(await screen.findByRole("button", { name: spanish ? "Explorar recetas" : "Browse recipes" }));
      expect(await screen.findByRole("heading", { name: spanish ? "Biblioteca de recetas" : "Recipe library" })).toBeVisible();
      expect(screen.getAllByText(spanish ? /espacio de tu organización está inactivo/ : /organization workspace is inactive/).length).toBeGreaterThan(1);
      for (const button of screen.getAllByRole("button", { name: /^Use recipe:|^Usar receta:/ })) expect(button).toBeDisabled();
    });
    it("retries opportunity counts after a transient failure in a ready workspace", async () => {
      const { api } = setup({ tab: "discover", lang, overrides: { getOpportunities: vi.fn().mockResolvedValue({ ok: false }) } });
      const retry = await screen.findByRole("button", { name: spanish ? "Intentar de nuevo" : "Try again" });
      api.getOpportunities.mockResolvedValue({ ok: true, data: { rows: [] } });
      fireEvent.click(retry);
      expect(await screen.findByText(spanish ? /No hay patrones rutinarios sin cubrir/ : /No uncovered routine patterns/)).toBeVisible();
      expect(api.getOpportunities).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: /Try again|Intentar de nuevo|Reintentar/ })).toBeNull();
    });
  });

  it("passes the signed-in bearer token to Compass without adding it to the scoped actor", async () => {
    const requestCompass = vi.fn().mockResolvedValue({ ok: false, reason: "governance_unavailable" });
    setup({ tab: "discover", accessToken: "signed-in-token", requestCompass });
    fireEvent.change(await screen.findByLabelText("Describe the routine work"), { target: { value: "Follow up on overdue tasks" } });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Ask the Guide" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Ask the Guide" }));
    await waitFor(() => expect(requestCompass).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "signed-in-token", intent: "Follow up on overdue tasks" })));
  });

  it("provides one persistent page heading across automation tabs", async () => {
    setup({ tab: "recipes" });
    expect(await screen.findByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("shows deterministic opportunities on Discover without exposing source records", async () => {
    setup({ tab: "discover", overrides: { getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", rows: [{ triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 2, scope: "chapter", covered: false }] } }) } });
    expect(await screen.findByText("4 currently match · campaign scope")).toBeVisible();
    expect(screen.queryByText(/source id|member|case detail/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draft this" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Task overdue");
  });
  it("seeds a chapter-scoped opportunity draft with the actor's only authorized chapter", async () => {
    const { api } = setup({ tab: "discover", overrides: { getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", rows: [{ triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 2, scope: "chapter", covered: false }] } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Draft this" }));
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenCalledWith(session, expect.objectContaining({ source: "task" })));
    expect(await screen.findByLabelText("Name")).toHaveValue("Task overdue");
    // The seeded scope is the single authorized chapter the picker returned,
    // shown in the workflow summary's population line.
    expect(await screen.findByText("Chapter A")).toBeVisible();
  });
  it("leaves an organization-scoped opportunity draft unseeded", async () => {
    const { api } = setup({ tab: "discover", overrides: { getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", rows: [{ triggerKind: "overdue_task", candidateCount: 9, thresholdDays: 2, scope: "organization", covered: false }] } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Draft this" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Task overdue");
    // No chapter seed: the population line stays on every authorized chapter.
    expect(await screen.findByText("All authorized campaigns")).toBeVisible();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("ignores a stale chapter-seed response after the Discover identity changes", async () => {
    let resolveScope;
    const pending = new Promise((resolve) => { resolveScope = resolve; });
    const { api, changeScope } = setup({
      tab: "discover",
      overrides: {
        getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", rows: [{ triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 2, scope: "chapter", covered: false }] } }),
        getScopeOptions: vi.fn().mockReturnValue(pending),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Draft this" }));
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    const otherOrg = { ...session, selectedOrganizationId: "50900000-0000-4000-8000-000000000199" };
    changeScope(otherOrg);
    await act(async () => {
      resolveScope({ ok: true, data: { chapters: page([{ id: "chapter-a", label: "Chapter A" }]), assignees: page([{ id: personId, label: "Eligible staff" }]), recipients: page([{ id: personId, label: "Eligible staff" }]) } });
    });
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Chapter A")).not.toBeInTheDocument();
  });
  it("names the chapter or source requirement when a staff draft save is refused for missing scope", async () => {
    const { api } = setup({ overrides: { saveDefinition: vi.fn().mockResolvedValue({ ok: false, reason: "scope_required" }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unscoped sweep" } });
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("must stay inside one authorized campaign or a single selected source");
    expect(alert).not.toHaveTextContent("could not be completed");
  });

  it("labels an opportunity with the population it counted and seeds the chapter it counted", async () => {
    // UX-UG-DISCOVER-LABELS-OPPORTUNITY-SCOPE-CHAPTER-NON-APPROVER-ORG-LEVEL-20260921:
    // an organization-wide count is never advertised as chapter scope, and a
    // single-chapter count hands the draft the chapter a staff save requires.
    const orgWide = { capabilityVersion: 2, observedAt: "2026-09-10T20:00:00Z", scopeChapterId: null, rows: [{ triggerKind: "overdue_task", candidateCount: 47, thresholdDays: 1, scope: "organization", covered: false }] };
    const { api, changeScope } = setup({ tab: "discover", control: { access: { canAuthor: true, canApprove: false, canOperate: false } }, overrides: { getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: orgWide }) } });
    expect(await screen.findByText("47 currently match · organization scope")).toBeVisible();
    expect(screen.queryByText(/47 currently match · chapter scope/)).not.toBeInTheDocument();

    const chapterScoped = { ...orgWide, scopeChapterId: "chapter-a", rows: [{ ...orgWide.rows[0], candidateCount: 12, scope: "chapter" }] };
    changeScope(session, { ...api, getOpportunities: vi.fn().mockResolvedValue({ ok: true, data: chapterScoped }) });
    expect(await screen.findByText("12 currently match · campaign scope")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Draft this" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Task overdue");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByLabelText("Campaign / task board")).toHaveValue("chapter-a"));
    // Choosing a status and then clearing it removes the condition again.
    const status = screen.getByLabelText("Source status");
    const option = [...status.options].find((item) => item.value);
    // The summary names the selected status itself, not only a separator.
    const conditionsLine = () => document.querySelectorAll(".automation-pages__summary dd")[1];
    // The expected label is the option the reviewer chose, as displayed,
    // not the helper the summary uses, so a wrong helper label fails here.
    const label = option.textContent.trim();
    expect(label).toMatch(/\w/);
    expect(conditionsLine().textContent).not.toContain(` · ${label}`);
    fireEvent.change(status, { target: { value: option.value } });
    expect(status).toHaveValue(option.value);
    expect(conditionsLine().textContent).toContain(` · ${label}`);
    fireEvent.change(status, { target: { value: "" } });
    expect(status).toHaveValue("");
    expect(conditionsLine().textContent).not.toContain(` · ${label}`);
    expect(conditionsLine().textContent).not.toContain(" · ");
  });

  it("keeps staff authoring separate from approval and operation", async () => {
    const steward = { ...session, role: "steward", selectedHat: "steward", organizationRoles: ["steward"] };
    const sharedDefinition = { ...definition, status: "paused", reviewStatus: "submitted", reviewVersion: 3, submittedBySelf: true, submittedAt: "2026-09-10T20:00:00Z", reviewedAt: null, reviewNote: null, canEdit: false, canSubmit: false, canReview: false, canActivate: false, canPreview: true };
    const { api, changeScope } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { access: { canAuthor: true, canApprove: false, canOperate: false }, definitions: [sharedDefinition] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: sharedDefinition } }) } });
    changeScope(steward);
    expect(await screen.findByText("Review: Submitted")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve version/ })).not.toBeInTheDocument();
    expect(api.setDefinitionStatus).not.toHaveBeenCalled();
  });

  it("supports explicit exact-version approval while leaving execution paused", async () => {
    const sharedDefinition = { ...definition, status: "paused", reviewStatus: "submitted", reviewVersion: 3, submittedBySelf: true, submittedAt: "2026-09-10T20:00:00Z", reviewedAt: null, reviewNote: null, canEdit: false, canSubmit: false, canReview: true, canActivate: false, canPreview: true };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { access: { canAuthor: true, canApprove: true, canOperate: true }, definitions: [sharedDefinition] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: sharedDefinition } }) } });
    expect(await screen.findByText("Execution: Paused")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve version 3" }));
    await waitFor(() => expect(api.reviewDefinition).toHaveBeenCalledWith(session, definitionId, 3, "approve", null));
    expect(api.setDefinitionStatus).not.toHaveBeenCalled();
  });

  // The review panel's controls stay focusable while the page's
  // act() writes, and the page's busyRef refuses a second approval.
  it("keeps Approve version focused while the approval is sent, and approves once", async () => {
    const sharedDefinition = { ...definition, status: "paused", reviewStatus: "submitted", reviewVersion: 3, submittedBySelf: true, submittedAt: "2026-09-10T20:00:00Z", reviewedAt: null, reviewNote: null, canEdit: false, canSubmit: false, canReview: true, canActivate: false, canPreview: true };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { access: { canAuthor: true, canApprove: true, canOperate: true }, definitions: [sharedDefinition] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: sharedDefinition } }) } });
    await expectHeldWriteFocus(api.reviewDefinition, await screen.findByRole("button", { name: "Approve version 3" }));
    expect(api.reviewDefinition).toHaveBeenCalledTimes(1);
  });

  it("keeps Submit version focused while it is submitted for review, and submits once", async () => {
    const draftDefinition = { ...definition, status: "paused", reviewStatus: "draft", reviewVersion: 3, version: 3, submittedBySelf: false, submittedAt: null, reviewedAt: null, reviewNote: null, canEdit: true, canSubmit: true, canReview: false, canActivate: false, canPreview: true };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { access: { canAuthor: true, canApprove: false, canOperate: false }, definitions: [draftDefinition] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: draftDefinition } }) } });
    await expectHeldWriteFocus(api.submitDefinition, await screen.findByRole("button", { name: /^Submit version \d+ for review$/ }));
    expect(api.submitDefinition).toHaveBeenCalledTimes(1);
  });

  it("opens an empty draft from the Discover hero without writing", async () => {
    const { api } = setup({ tab: "discover" });
    fireEvent.click(await screen.findByRole("button", { name: "Create draft" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("");
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Describe the routine work", "Ask the Guide", "Write at least 3 characters, not counting spaces at the start or end.", "4 of 500 characters"],
    ["es", "Describe el trabajo rutinario", "Preguntar a la Guía", "Escribe al menos 3 caracteres, sin contar los espacios al principio o al final.", "4 de 500 caracteres"],
  ])("explains the Ask Compass draft length in %s", async (lang, label, ask, reason, count) => {
    const requestCompass = vi.fn().mockResolvedValue({ ok: false });
    setup({ tab: "discover", lang, accessToken: "signed-in-token", requestCompass });
    const description = await screen.findByRole("textbox", { name: label });
    expect(description).not.toHaveAttribute("aria-invalid");
    const button = screen.getByRole("button", { name: ask });
    fireEvent.change(description, { target: { value: " Ab " } });
    expect(button).toHaveAccessibleDescription(reason);
    expect(button.nextElementSibling).toBeVisible();
    expect(description).toHaveAccessibleDescription(/500/);
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(description).toHaveAttribute("maxlength", "500");
    const counter = screen.getByText(count);
    expect(counter).toBeVisible();
    expect(counter).not.toHaveAttribute("aria-live");
    expect(counter).not.toHaveAttribute("aria-atomic");
    expectRefusedEveryWay(button, reason, () => requestCompass.mock.calls.length > 0);
    const previous = within(button.form).getByRole("alert");
    fireEvent.submit(button.form);
    expect(within(button.form).getByRole("alert")).not.toBe(previous);
    expect(requestCompass).not.toHaveBeenCalled();
    fireEvent.change(description, { target: { value: " Add " } });
    expect(description).not.toHaveAttribute("aria-invalid");
    fireEvent.click(button);
    await waitFor(() => expect(requestCompass).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ intent: "Add", locale: lang })));
  });

  it("keeps Ask Compass focused while Compass drafts, and asks once", async () => {
    const requestCompass = vi.fn(async () => ({ ok: false, reason: "governance_unavailable" }));
    setup({ tab: "discover", accessToken: "signed-in-token", requestCompass });
    fireEvent.change(await screen.findByLabelText("Describe the routine work"), { target: { value: "Follow up on overdue tasks" } });
    await waitFor(() => { const control = screen.getByRole("button", { name: "Ask the Guide" }); expect(control).not.toHaveAttribute("aria-disabled"); });
    await expectHeldWriteFocus(requestCompass, screen.getByRole("button", { name: "Ask the Guide" }));
    expect(requestCompass).toHaveBeenCalledTimes(1);
  });

  it("sends the trimmed review note when approving a submitted version", async () => {
    const sharedDefinition = { ...definition, status: "paused", reviewStatus: "submitted", reviewVersion: 3, submittedBySelf: true, submittedAt: "2026-09-10T20:00:00Z", reviewedAt: null, reviewNote: null, canEdit: false, canSubmit: false, canReview: true, canActivate: false, canPreview: true };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { access: { canAuthor: true, canApprove: true, canOperate: true }, definitions: [sharedDefinition] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: sharedDefinition } }) } });
    fireEvent.change(await screen.findByLabelText("Review note"), { target: { value: "  Approved after the chapter scope was clarified.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version 3" }));
    await waitFor(() => expect(api.reviewDefinition).toHaveBeenCalledWith(session, definitionId, 3, "approve", "Approved after the chapter scope was clarified."));
    expect(api.setDefinitionStatus).not.toHaveBeenCalled();
  });
  // OPS-UG-AUTOMATION-SCHEDULED-AUTHORITY-DEPENDS-ON-LAST-EDITOR-20260921
  it.each([
    [false, true],
    [true, false],
    [undefined, false],
  ])("with dependencyReady %s an active definition explains its failing scheduled authority: %s", async (dependencyReady, shown) => {
    setup({ tab: "definition", query: `?definition=${definitionId}`, overrides: {
      getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: { ...definition, ...(dependencyReady === undefined ? {} : { dependencyReady }) } } }),
    } });
    expect(await screen.findByRole("heading", { name: definition.name })).toBeVisible();
    const note = screen.queryByText(/^Scheduled runs are failing: the Admin or President who activated this automation/);
    if (shown) expect(note).toHaveAttribute("role", "status");
    else expect(note).not.toBeInTheDocument();
  });

  it("requires exact definition phrases and preserves version while pausing or archiving", async () => {
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Pause", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    expect(api.setDefinitionStatus).not.toHaveBeenCalled();
    for (const [label, status] of [["Pause", "paused"], ["Archive", "archived"]]) {
      // The previous status change reloads the definition before its next control returns.
      const control = await screen.findByRole("button", { name: label, exact: true });
      // A pending control stays enabled (record 8435): wait for its busy state to clear.
      await waitFor(() => { expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
      fireEvent.click(control);
      fireEvent.change(screen.getByLabelText(`Type ${status.toUpperCase()} 50900000 to continue`), { target: { value: `${status.toUpperCase()} 50900000` } });
      fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
      await waitFor(() => expect(api.setDefinitionStatus).toHaveBeenLastCalledWith(session, definitionId, status, 3));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm", exact: true })).not.toBeInTheDocument());
    }
  });
  it("saves a bounded safety cap and pauses the master separately", async () => {
    const { api } = setup({ tab: "settings", enabled: true });
    const cap = await screen.findByLabelText("Maximum effects per run");
    fireEvent.change(cap, { target: { value: "51" } });
    expect(screen.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(cap, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(api.setSafetyCap).toHaveBeenCalledWith(session, 7));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Pause all" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Pause all" }));
    fireEvent.change(screen.getByLabelText("Type PAUSE AUTOMATION to continue"), { target: { value: "PAUSE AUTOMATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(session, false, "PAUSE AUTOMATION"));
  });
  // The page's synchronous busyRef refuses a second write started
  // in the same tick, and the builder's controls stay focusable while it saves.
  it("saves the safety cap once when Save is activated twice in one tick", async () => {
    const { api } = setup({ tab: "settings", enabled: true });
    fireEvent.change(await screen.findByLabelText("Maximum effects per run"), { target: { value: "7" } });
    const save = screen.getByRole("button", { name: "Save", exact: true });
    await expectOneWriteFromOneTick(api.setSafetyCap, [() => fireEvent.click(save), () => fireEvent.click(save)]);
    expect(api.setSafetyCap).toHaveBeenCalledExactlyOnceWith(session, 7);
  });

  it("keeps the builder's Save draft focused while the draft is saved, and saves it once", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Held sweep" } });
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await expectHeldWriteFocus(api.saveDefinition, screen.getByRole("button", { name: "Save draft" }));
    expect(api.saveDefinition).toHaveBeenCalledTimes(1);
  });

  it("completes confirmed undo then navigates to the exact definition", async () => {
    const { api } = setup({ tab: "run", query: `?run=${runId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));
    fireEvent.change(screen.getByLabelText("Type ROLL BACK 50900000 to continue"), { target: { value: "ROLL BACK 50900000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.rollbackRun).toHaveBeenCalledWith(session, runId, "ROLL BACK 50900000"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: "Open definition" }));
    await waitFor(() => expect(api.getDefinition).toHaveBeenCalledWith(session, definitionId));
  });
  it("opens bounded run rows and clears a definition filter on its own history page", async () => {
    const { api } = setup({ tab: "history", query: `?definition=${definitionId}`, overrides: { getRuns: vi.fn().mockResolvedValue({ ok: true, data: page([run]) }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Show all definitions" }));
    await waitFor(() => expect(api.getRuns).toHaveBeenLastCalledWith(session, expect.objectContaining({ definitionId: undefined })));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect run" }));
    await waitFor(() => expect(api.getRun).toHaveBeenCalledWith(session, runId, { page: 1, pageSize: 6 }));
  });
  it("warns before unload and discards a draft only after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { api } = setup({ tab: "builder" });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep this draft" } });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(await screen.findByRole("heading", { name: "Your automations" })).toBeVisible();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("shows a rejected read as unavailable and allows a failed load to be retried", async () => {
    const { api } = setup({ overrides: { load: vi.fn().mockRejectedValueOnce(new Error("offline")), getDefinitions: vi.fn().mockRejectedValue(new Error("offline")) } });
    const retry = await screen.findByRole("button", { name: "Try again" });
    api.load.mockResolvedValue({ state: "ready", control: { organizationId, capabilities, settings: { enabled: false, maxEffectsPerRun: 20 }, definitions: [], runs: [] } });
    fireEvent.click(retry);
    expect(await screen.findByText(/This record is unavailable/)).toBeVisible();
    expect(api.load).toHaveBeenCalledTimes(2);
  });
  it.each(["en", "es"])("explains recipes and the paused empty state in %s", async (lang) => {
    const { api } = setup({ lang });
    expect(await screen.findByText(lang === "es" ? /Las recetas ahora son definiciones/ : /Recipes are now editable/)).toBeVisible();
    expect(await screen.findByText(lang === "es" ? /Elige una receta para preparar tu primer borrador/ : /Choose a recipe to prepare your first automation draft/)).toBeVisible();
    expect(screen.getByText(lang === "es" ? /El programador está instalado/ : /The scheduler is installed/)).toHaveTextContent(lang === "es" ? /interruptor general está en pausa/ : /master switch is paused/);
    expect(api.saveDefinition).not.toHaveBeenCalled(); expect(api.setEnabled).not.toHaveBeenCalled();
  });
  it("bounds the catalogue, filters bilingual content and selects a draft without writes", async () => {
    const { api } = setup({ tab: "recipes" });
    expect(await screen.findAllByRole("button", { name: /^Use recipe:/ })).toHaveLength(6);
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "cita" } });
    expect(screen.getByText(/matching recipes/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "Review overdue work" } });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Use recipe: Review overdue work" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByRole("button", { name: "Use recipe: Review overdue work" }));
    expect(await screen.findByRole("heading", { name: "Build an automation" })).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("Review overdue work");
    expect(screen.queryByLabelText("Search recipes")).not.toBeInTheDocument();
    for (const method of ["saveDefinition", "setDefinitionStatus", "setEnabled", "previewRun", "executeRun"]) expect(api[method]).not.toHaveBeenCalled();
  });
  it("offers a useful no-results reset and disables uninstalled recipes", async () => {
    setup({ tab: "recipes", control: { capabilities: { schemaVersion: 1, triggers: ["overdue_task", "case_deadline", "unassigned_case"], actions: ["create_standard_task"], cadences: ["daily"], maxThresholdDays: 90 } } });
    expect((await screen.findAllByRole("button", { name: /^Use recipe:/ })).every((button) => button.disabled)).toBe(true);
    fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "no-such-recipe" } });
    expect(screen.getByText(/No recipes match/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("button", { name: /^Use recipe:/ })).toHaveLength(6);
  });
  // UX-UG-PRESIDENT-VP-AUTOMATION-APPROVER-OFFERED-APPOINTMENT-RECIPE-20260921
  it.each([
    [false, true],
    [true, false],
    [undefined, false],
  ])("with appointmentSupervision %s a President's appointment recipes are disabled: %s", async (appointmentSupervision, disabled) => {
    const vp = { ...session, role: "vp", selectedHat: "vp", organizationRoles: ["vp"] };
    setup({ tab: "recipes", member: vp, control: { appointmentSupervision, access: { canAuthor: true, canApprove: true, canOperate: true } } });
    fireEvent.change(await screen.findByLabelText("Workflow"), { target: { value: "appointments" } });
    // The recipe list settles once the organization's automation controls load.
    const buttons = await waitFor(() => {
      const shown = screen.getAllByRole("button", { name: /^Use recipe:/ });
      expect(shown).toHaveLength(3);
      for (const button of shown) expect(button.disabled).toBe(disabled);
      return shown;
    });
    const reasons = await waitFor(() => {
      const shown = screen.queryAllByText(/^One-on-one supervision required\./);
      expect(shown).toHaveLength(disabled ? 3 : 0);
      return shown;
    });
    if (disabled) expect(buttons[0]).toHaveAttribute("aria-describedby", reasons[0].id);
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "tasks" } });
    expect(screen.getAllByRole("button", { name: /^Use recipe:/ }).every((button) => !button.disabled)).toBe(true);
  });

  it("names appointment supervision when activating an appointment automation is refused", async () => {
    const paused = { ...definition, name: "Prepare for an upcoming appointment", triggerKind: "appointment_upcoming", thresholdDays: 2, status: "paused" };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, overrides: {
      getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: paused } }),
      setDefinitionStatus: vi.fn().mockResolvedValue({ ok: false, reason: "appointment_supervision" }),
    } });
    fireEvent.click(await screen.findByRole("button", { name: "Activate", exact: true }));
    fireEvent.change(screen.getByLabelText("Type ACTIVE 50900000 to continue"), { target: { value: "ACTIVE 50900000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
    await waitFor(() => expect(api.setDefinitionStatus).toHaveBeenCalledWith(session, definitionId, "active", 3));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This one-on-one automation cannot be activated");
    expect(alert).not.toHaveTextContent("could not be completed");
  });
  it.each(["en", "es"])("keeps compact visible recipe actions while preserving their distinct accessible names in %s", async (lang) => {
    setup({ tab: "recipes", lang });
    const buttons = await screen.findAllByRole("button", { name: lang === "es" ? /^Usar receta:/ : /^Use recipe:/ });
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button).toHaveTextContent(lang === "es" ? /^Usar receta$/ : /^Use recipe$/);
      expect(button.getAttribute("aria-label").length).toBeGreaterThan(button.textContent.length);
    }
    const first = buttons[0].closest("li");
    expect(first.parentElement).toHaveClass("automation-pages__recipes");
    const detail = first.querySelector("details");
    expect(detail).not.toHaveAttribute("open");
    expect(detail.textContent).toContain(lang === "es" ? "conserva intacto" : "keeps the original work intact");
  });
  it("validates each step, preserves back navigation and saves only on review", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/required field/);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Upcoming task planning" } });
    fireEvent.change(screen.getByLabelText("When this happens"), { target: { value: "task_due" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Day threshold"), { target: { value: "3" } });
    await waitFor(() => expect(screen.getByLabelText("Campaign / task board")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Campaign / task board"), { target: { value: "chapter-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Upcoming task planning");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Day threshold")).toHaveValue(3);
    for (let step = 0; step < 3; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.saveDefinition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(session, expect.objectContaining({ name: "Upcoming task planning", triggerKind: "task_due", thresholdDays: "3", conditions: { chapterId: "chapter-a" } })));
    expect(api.setEnabled).not.toHaveBeenCalled(); expect(api.setDefinitionStatus).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Automation details" })).toBeVisible();
  });
  it("moves focus to the new step's legend after Continue and Back, but not on open", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    const legend = () => document.querySelector(".automation-pages__builder legend");
    expect(legend()).not.toHaveFocus();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Upcoming task planning" } });
    screen.getByRole("button", { name: "Continue" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(legend()).toHaveTextContent("Only if");
    expect(legend()).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(legend()).toHaveTextContent("When");
    expect(legend()).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(legend()).toHaveTextContent("When");
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });
  it("warns before route changes, retains a draft and confirms discarding", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);
    setup(); fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("link", { name: "Recipes" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("link", { name: "Automations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume unsaved draft" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(await screen.findByRole("heading", { name: "Your automations" })).toBeVisible();
    expect(confirm).toHaveBeenCalledTimes(4);
  });
  it("keeps incomplete recipient actions unsavable and never offers provider fields", async () => {
    const { api } = setup({ tab: "recipes" });
    fireEvent.change(await screen.findByLabelText("Search recipes"), { target: { value: "Assign unowned tasks" } });
    const buttons = screen.queryAllByRole("button", { name: /^Use recipe:/ });
    if (!buttons.length) fireEvent.change(screen.getByLabelText("Search recipes"), { target: { value: "" } });
    // Start a custom draft so this test is independent of recipe naming.
    fireEvent.click(screen.getByRole("link", { name: "Automations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Assign task work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Then do this"), { target: { value: "assign_task" } });
    await waitFor(() => expect(screen.getByLabelText("Assign to")).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/required field/);
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: personId } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.queryByLabelText(/webhook|secret|credential|email|sms/i)).not.toBeInTheDocument();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("keeps chapter paging independent from the people list requested on the Then step", async () => {
    const chapters = Array.from({ length: 8 }, (_, index) => ({ id: `chapter-${index + 1}`, label: `Chapter ${index + 1}` }));
    const people = [{ id: "person-1", label: "Ada Lovelace" }, { id: "person-2", label: "Grace Hopper" }, { id: personId, label: "Eligible staff" }];
    const getScopeOptions = scopeOptionsMock({ chapters, people });
    const { api } = setup({ overrides: { getScopeOptions } });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Assign chapter work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const chapterSelect = await screen.findByLabelText("Campaign / task board");
    await waitFor(() => expect(chapterSelect).not.toBeDisabled());
    expect(within(chapterSelect).getByRole("option", { name: "Chapter 1" })).toBeInTheDocument();
    // Paging the authorized-chapters list to a later page must not move the people request.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenLastCalledWith(session, expect.objectContaining({ page: 2, search: "" })));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Then do this"), { target: { value: "assign_task" } });
    const assigneeSelect = await screen.findByLabelText("Assign to");
    await waitFor(() => expect(assigneeSelect).not.toBeDisabled());
    for (const person of people) expect(within(assigneeSelect).getByRole("option", { name: person.label })).toBeInTheDocument();
    expect(within(assigneeSelect).getAllByRole("option")).toHaveLength(4);
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenLastCalledWith(session, expect.objectContaining({ page: 1, search: "" })));
  });
  it("keeps the authorized-people search from filtering the chapter list on the Only if step", async () => {
    const chapters = Array.from({ length: 3 }, (_, index) => ({ id: `chapter-${index + 1}`, label: `Chapter ${index + 1}` }));
    const people = Array.from({ length: 10 }, (_, index) => ({ id: `person-${index + 1}`, label: `Person ${index + 1}` }));
    const getScopeOptions = scopeOptionsMock({ chapters, people });
    const { api } = setup({ overrides: { getScopeOptions } });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Notify one person" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const chapterSelect = await screen.findByLabelText("Campaign / task board");
    await waitFor(() => expect(chapterSelect).not.toBeDisabled());
    for (const chapter of chapters) expect(within(chapterSelect).getByRole("option", { name: chapter.label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Then do this"), { target: { value: "assign_task" } });
    const assigneeSelect = await screen.findByLabelText("Assign to");
    await waitFor(() => expect(assigneeSelect).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Search authorized people"), { target: { value: "Person 5" } });
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenLastCalledWith(session, expect.objectContaining({ search: "Person 5", page: 1 })));
    await waitFor(() => expect(within(assigneeSelect).getByRole("option", { name: "Person 5" })).toBeInTheDocument());
    for (const [, args] of api.getScopeOptions.mock.calls) if (args.search) expect(args.page).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const backChapterSelect = screen.getByLabelText("Campaign / task board");
    for (const chapter of chapters) expect(within(backChapterSelect).getByRole("option", { name: chapter.label })).toBeInTheDocument();
  });
  it("keeps people paging independent from the chapter list on the Only if step", async () => {
    const chapters = Array.from({ length: 3 }, (_, index) => ({ id: `chapter-${index + 1}`, label: `Chapter ${index + 1}` }));
    const people = Array.from({ length: 10 }, (_, index) => ({ id: `person-${index + 1}`, label: `Person ${index + 1}` }));
    const getScopeOptions = scopeOptionsMock({ chapters, people });
    const { api } = setup({ overrides: { getScopeOptions } });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Assign paged work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const chapterSelect = await screen.findByLabelText("Campaign / task board");
    await waitFor(() => expect(chapterSelect).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Then do this"), { target: { value: "assign_task" } });
    const assigneeSelect = await screen.findByLabelText("Assign to");
    await waitFor(() => expect(assigneeSelect).not.toBeDisabled());
    expect(within(assigneeSelect).getByRole("option", { name: "Person 1" })).toBeInTheDocument();
    // Paging the people list forward must not move the chapter request.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.getScopeOptions).toHaveBeenLastCalledWith(session, expect.objectContaining({ page: 2 })));
    await waitFor(() => expect(within(assigneeSelect).getByRole("option", { name: "Person 7" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const backChapterSelect = screen.getByLabelText("Campaign / task board");
    for (const chapter of chapters) expect(within(backChapterSelect).getByRole("option", { name: chapter.label })).toBeInTheDocument();
  });
  it("requests bounded server pages and clears stale rows while loading", async () => {
    let resolve;
    const getDefinitions = vi.fn().mockResolvedValueOnce({ ok: true, data: page([definition], 8) }).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { api } = setup({ overrides: { getDefinitions } });
    expect(await screen.findByRole("button", { name: `Open automation: ${definition.name}` })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.getDefinitions).toHaveBeenLastCalledWith(session, { page: 2, pageSize: 6, search: "", status: undefined }));
    expect(screen.queryByRole("button", { name: `Open automation: ${definition.name}` })).not.toBeInTheDocument();
    await act(async () => resolve({ ok: true, data: page([], 8, 2) }));
  });
  it.each(["en", "es"])("keeps authorization denial distinct from an empty page in %s", async (lang) => {
    const { api } = setup({ lang, overrides: { load: vi.fn().mockResolvedValue({ state: "mfa_required" }) } });
    expect(await screen.findByText(lang === "es" ? "Verifica el inicio en dos pasos para administrar la automatización." : "Verify two-step sign-in to manage automation.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Browse recipes|Explorar recetas/ })).not.toBeInTheDocument();
    expect(api.getDefinitions).not.toHaveBeenCalled();
  });
  it("requires a separate exact phrase to enable the master switch", async () => {
    const { api } = setup({ tab: "settings" });
    fireEvent.click(await screen.findByRole("button", { name: "Enable all" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }); expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Type ENABLE AUTOMATION to continue"), { target: { value: "ENABLE AUTOMATION" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(session, true, "ENABLE AUTOMATION"));
  });
  it("previews an active definition while master paused, without an executable run button", async () => {
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: `Preview: ${definition.name}` })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(api.executeRun).not.toHaveBeenCalled();
  });
  it("requires run-specific confirmation after the preview", async () => {
    const { api } = setup({ tab: "definition", enabled: true, query: `?definition=${definitionId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Type RUN 50900000 to continue"), { target: { value: "RUN 50900000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.executeRun).toHaveBeenCalledWith(session, runId, "RUN 50900000"));
  });
  it("does not reveal restricted source identifiers and keeps undo truthful", async () => {
    const secretId = "private-source-id";
    const { api } = setup({ tab: "run", query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run, effects: page([{ id: "effect-1", actionKind: "notify_in_app", sourceAvailable: false, sourceId: secretId, status: "created" }]) } }) } });
    expect(await screen.findByText("Source unavailable or restricted")).toBeVisible();
    expect(screen.queryByText(secretId)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(screen.getByText(/notification already seen cannot be recalled/)).toBeVisible();
    expect(api.rollbackRun).not.toHaveBeenCalled();
  });
  it("shows unavailable for invalid detail references without sending an RPC", async () => {
    const { api } = setup({ tab: "definition", query: "?definition=invalid" });
    expect(await screen.findByText(/record is unavailable/)).toBeVisible();
    expect(api.getDefinition).not.toHaveBeenCalled();
  });
  it("authorizes incoming source context before exposing compatible recipes or a draft", async () => {
    const { api } = setup({ tab: "recipes", query: `?sourceKind=appointment&sourceId=${personId}` });
    await waitFor(() => expect(screen.getByLabelText("Workflow")).toHaveValue("appointments"));
    expect(api.getSourceContext).toHaveBeenCalledWith(session, "appointment", personId);
    const button = screen.getAllByRole("button", { name: /^Use recipe:/ })[0];
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Build an automation" })).toBeVisible();
    expect(window.location.search).toContain(`sourceId=${personId}`);
    expect(screen.getByRole("link", { name: "Back to source" })).toHaveAttribute("href", `/m/appointments?appointment=${personId}`);
    expect(screen.getByText(/Selected source only/)).toBeVisible();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("keeps the recipe list visible with an explicit banner when the incoming source read fails", async () => {
    const { api } = setup({ tab: "recipes", query: `?sourceKind=case&sourceId=${personId}`, overrides: { getSourceContext: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }) } });
    expect((await screen.findAllByRole("button", { name: /^Use recipe:/ })).length).toBeGreaterThan(0);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The selected source is not available, so the recipes below are not limited to it/);
    expect(banner.compareDocumentPosition(screen.getByRole("heading", { name: "Recipe library" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Use recipe:/ })[0]);
    expect(screen.getByText(/The source must be authorized before starting this draft\./)).toBeVisible();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("lands a steward with canApprove:false on a populated Recipes list bound to their own-chapter task source", async () => {
    const steward = { ...session, role: "steward", selectedHat: "steward", organizationRoles: ["steward"] };
    const sourceId = "50900000-0000-4000-8000-000000000131";
    const { api } = setup({ tab: "recipes", query: `?sourceKind=task&sourceId=${sourceId}`, member: steward });
    await waitFor(() => expect(screen.getByLabelText("Workflow")).toHaveValue("tasks"));
    expect(api.getSourceContext).toHaveBeenCalledWith(steward, "task", sourceId);
    expect((await screen.findAllByRole("button", { name: /^Use recipe:/ })).length).toBeGreaterThan(0);
    expect(screen.getByText(/Recipe context is limited to the authorized source/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use recipe: Review overdue work" }));
    expect(await screen.findByRole("heading", { name: "Build an automation" })).toBeVisible();
    expect(window.location.search).toContain(`sourceId=${sourceId}`);
    expect(screen.getByText(/Selected source only/)).toBeVisible();
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(steward, expect.objectContaining({ conditions: { sourceId, chapterId: "chapter-a" } })));
  });
  it("still renders the Recipes list with an explicit banner when a steward's source read is refused", async () => {
    const steward = { ...session, role: "steward", selectedHat: "steward", organizationRoles: ["steward"] };
    const sourceId = "50900000-0000-4000-8000-000000000132";
    const { api } = setup({ tab: "recipes", query: `?sourceKind=task&sourceId=${sourceId}`, member: steward, overrides: { getSourceContext: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }) } });
    expect(await screen.findByLabelText("Workflow")).toHaveValue("all");
    expect((await screen.findAllByRole("button", { name: /^Use recipe:/ })).length).toBeGreaterThan(0);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The selected source is not available, so the recipes below are not limited to it/);
    expect(banner.compareDocumentPosition(screen.getByRole("heading", { name: "Recipe library" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Recipe context is limited to the authorized source/)).not.toBeInTheDocument();
    expect(api.saveDefinition).not.toHaveBeenCalled();
  });
  it("keeps recipe actions disabled until the source-context read settles and does not leave a false authorization alert", async () => {
    let resolveSource;
    const getSourceContext = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSource = resolve; }));
    setup({ tab: "recipes", query: `?sourceKind=task&sourceId=${personId}`, overrides: { getSourceContext } });
    await waitFor(() => expect(getSourceContext).toHaveBeenCalledWith(session, "task", personId));
    const pending = screen.getAllByRole("button", { name: /^Use recipe:/ });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]).toBeDisabled();
    expect(screen.getAllByText("Confirming the selected source…").length).toBeGreaterThan(0);
    fireEvent.click(pending[0]);
    expect(screen.queryByText(/The source must be authorized before starting this draft/)).not.toBeInTheDocument();
    await act(async () => {
      resolveSource({ ok: true, data: { sourceKind: "task", sourceId: personId, chapterId: "chapter-a" } });
    });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getAllByRole("button", { name: /^Use recipe:/ })[0]; expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    expect(screen.queryByText(/The source must be authorized before starting this draft/)).not.toBeInTheDocument();
    expect(screen.getByText(/Recipe context is limited to the authorized source/)).toBeVisible();
  });
  it("treats a one-parameter source deep link as unavailable instead of pending forever", async () => {
    const { api } = setup({ tab: "recipes", query: "?sourceKind=task" });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The selected source is not available, so the recipes below are not limited to it/);
    expect(screen.queryByText("Loading authorized records…")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirming the selected source…")).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /^Use recipe:/ });
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]).toBeEnabled();
    expect(api.getSourceContext).not.toHaveBeenCalled();
    fireEvent.click(buttons[0]);
    expect(screen.getByText(/The source must be authorized before starting this draft\./)).toBeVisible();
  });
  it("treats a terminal workspace load as an unavailable source instead of pending forever", async () => {
    const { api } = setup({
      tab: "recipes",
      query: `?sourceKind=task&sourceId=${personId}`,
      overrides: { load: vi.fn().mockResolvedValue({ state: "unavailable" }) },
    });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The selected source is not available, so the recipes below are not limited to it/);
    expect(await screen.findByText(/Automation controls could not be loaded/)).toBeVisible();
    expect(screen.queryByText("Loading authorized records…")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirming the selected source…")).not.toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /^Use recipe:/ })).length).toBeGreaterThan(0);
    expect(api.getSourceContext).not.toHaveBeenCalled();
  });
  it.each(["en", "es"])("does not turn a redacted definition into an unrestricted editable draft (%s)", async (lang) => {
    const { api, workspace } = setup({ tab: "definition", lang, query: `?definition=${definitionId}`, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: { ...definition, status: "paused", sourceFilterAvailable: false } } }) } });
    expect(await screen.findByText(lang === "es" ? /el alcance guardado no ha cambiado/ : /saved scope has not changed/)).toBeVisible();
    // #9946: Edit now states its reason, so it stays focusable (aria-disabled) and refuses every press.
    const editButton = screen.getByRole("button", { name: lang === "es" ? "Editar" : "Edit", exact: true });
    expectRefusedEveryWay(editButton, lang === "es"
      ? "No puedes editarla ni previsualizarla aquí porque el origen que sigue ya no está disponible."
      : "You cannot edit or preview it here because the source it follows is no longer available.", () => workspace.open.mock.calls.some(([path]) => String(path).includes("builder")));
    expect(screen.getByRole("button", { name: lang === "es" ? "Activar" : "Activate", exact: true })).toBeDisabled();
    expect(api.saveDefinition).not.toHaveBeenCalled();
    expect(api.previewRun).not.toHaveBeenCalled();
  });
  it("links only independently authorized sources and resulting tasks", async () => {
    setup({ tab: "run", query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run, effects: page([{ id: "effect-1", actionKind: "create_standard_task", sourceKind: "task", sourceAvailable: true, sourceId: personId, effectAvailable: true, taskId: definitionId, status: "created", reasonCode: "deduplicated" }, { id: "effect-2", actionKind: "assign_task", sourceAvailable: false, sourceId: runId, effectAvailable: false, taskId: personId, status: "skipped", reasonCode: "permission_lost" }]) } }) } });
    expect(await screen.findByRole("link", { name: "Open source" })).toHaveAttribute("href", `/m/tasks/board?task=${personId}`);
    expect(screen.getByRole("link", { name: "Open resulting task" })).toHaveAttribute("href", `/m/tasks/board?task=${definitionId}`);
    expect(screen.getAllByRole("link", { name: "Open source" })).toHaveLength(1);
    expect(screen.getByText(/Access changed, action refused/)).toBeVisible();
  });
  // BUG-UG-AUTOMATION-CASE-SOURCE-DESTINATION-20261020
  it("opens a case source in the selected hat's staff case surface and offers no link where the hat has none", async () => {
    const caseEffect = { id: "effect-3", actionKind: "create_standard_task", sourceKind: "case_checklist", sourceAvailable: true, sourceId: runId, caseId: personId, effectAvailable: false, status: "created" };
    const { changeScope } = setup({ tab: "run", query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run, effects: page([caseEffect]) } }) } });
    // The admin hat has no case surface of its own: confirmed source, no usable link.
    expect(await screen.findByText("Source access confirmed for this read")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open source" })).not.toBeInTheDocument();
    changeScope({ ...session, role: "coordinator", selectedHat: "coordinator", organizationRoles: ["coordinator"] });
    expect(await screen.findByRole("link", { name: "Open source" })).toHaveAttribute("href", `/m/coordinator?case=${personId}`);
    changeScope({ ...session, role: "steward", selectedHat: "steward", organizationRoles: ["steward"] });
    expect(await screen.findByRole("link", { name: "Open source" })).toHaveAttribute("href", `/m/steward?case=${personId}`);
  });
  it("sends time and status filters to bounded run history, and refuses an inverted range", async () => {
    const { api } = setup({ tab: "history" });
    fireEvent.change(await screen.findByLabelText("Run status"), { target: { value: "partial" } });
    fireEvent.change(screen.getByLabelText("From, device timezone"), { target: { value: "2026-09-01T09:00" } });
    fireEvent.change(screen.getByLabelText("Until, device timezone"), { target: { value: "2026-09-10T10:00" } });
    await waitFor(() => expect(api.getRuns).toHaveBeenLastCalledWith(session, expect.objectContaining({ page: 1, pageSize: 6, status: "partial", from: new Date("2026-09-01T09:00").toISOString(), to: new Date("2026-09-10T10:00").toISOString() })));
    const calls = api.getRuns.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Until, device timezone"), { target: { value: "2026-08-01T10:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/end of the range/);
    expect(api.getRuns).toHaveBeenCalledTimes(calls);
  });
  it("preserves legacy definitions when the newer read RPC is not installed", async () => {
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, control: { capabilities: { schemaVersion: 1, triggers: ["overdue_task", "case_deadline", "unassigned_case"], actions: ["create_standard_task"], cadences: ["daily"], maxThresholdDays: 90 }, definitions: [{ ...definition, schemaVersion: 1 }] }, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: false, reason: "persistence_unset" }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name")).toHaveValue(definition.name);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Legacy preserved" } });
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(session, expect.objectContaining({ schemaVersion: 1, id: definitionId, version: 3, name: "Legacy preserved" })));
  });
  it("preserves version and v2 conditions when editing a saved definition", async () => {
    const expanded = { ...definition, triggerKind: "casework_deadline", conditions: { chapterId: "chapter-a", deadlineKind: "hearing", status: "active" }, actionKind: "notify_in_app", actionConfig: { recipientId: personId } };
    const { api } = setup({ tab: "definition", query: `?definition=${definitionId}`, overrides: { getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: expanded } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(session, expect.objectContaining({ version: 3, schemaVersion: 2, conditions: expanded.conditions, actionConfig: expanded.actionConfig })));
  });
  it.each(["success", "failure"])("ignores an old preview %s after changing organization and API", async (outcome) => {
    let resolveOld;
    const oldPreview = vi.fn(() => new Promise((resolve) => { resolveOld = resolve; }));
    const fixture = setup({ tab: "definition", query: `?definition=${definitionId}`, overrides: { previewRun: oldPreview } });
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const newOrganizationId = "50900000-0000-4000-8000-000000000222";
    const nextSession = { ...session, selectedOrganizationId: newOrganizationId };
    let resolveNew;
    const nextApi = { ...fixture.api,
      load: vi.fn().mockResolvedValue({ state: "ready", control: { ...fixture.control, organizationId: newOrganizationId } }),
      getDefinition: vi.fn().mockResolvedValue({ ok: true, data: { definition: { ...definition, name: "New organization work" } } }),
      previewRun: vi.fn(() => new Promise((resolve) => { resolveNew = resolve; })),
    };
    fixture.changeScope(nextSession, nextApi);
    expect(await screen.findByRole("heading", { name: "New organization work" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-disabled", "true");
    const calls = fixture.api.load.mock.calls.length;
    await act(async () => { resolveOld(outcome === "success" ? { ok: true, data: { ...run, definitionName: "OLD SECRET PREVIEW", confirmationPhrase: "RUN OLD" } } : { ok: false, reason: "stale_definition" }); });
    expect(fixture.api.load).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText(/OLD SECRET PREVIEW/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New organization work" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-disabled", "true");
    expect(fixture.onNotice).not.toHaveBeenCalled();
    expect(fixture.workspace.open).not.toHaveBeenCalled();
    await act(async () => resolveNew({ ok: true, data: { ...run, definitionName: "New organization work", confirmationPhrase: "RUN NEW" } }));
    expect(await screen.findByRole("heading", { name: "Preview: New organization work" })).toBeVisible();
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByRole("button", { name: "Preview" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  });
  it("does not announce or navigate after an old save resolves in a new organization", async () => {
    let resolveOld;
    const fixture = setup({ overrides: { saveDefinition: vi.fn(() => new Promise((resolve) => { resolveOld = resolve; })) } });
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old organization draft" } });
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(fixture.api.saveDefinition).toHaveBeenCalledTimes(1);
    const nextSession = { ...session, selectedOrganizationId: personId };
    const nextApi = { ...fixture.api, load: vi.fn().mockResolvedValue({ state: "ready", control: { ...fixture.control, organizationId: personId } }) };
    fixture.changeScope(nextSession, nextApi);
    expect(await screen.findByRole("heading", { name: "Start with a recipe" })).toBeVisible();
    const calls = fixture.api.load.mock.calls.length, navigations = fixture.workspace.open.mock.calls.length;
    await act(async () => resolveOld({ ok: true, data: { id: definitionId } }));
    expect(fixture.api.load).toHaveBeenCalledTimes(calls);
    expect(fixture.workspace.open).toHaveBeenCalledTimes(navigations);
    expect(fixture.onNotice).not.toHaveBeenCalled();
    expect(screen.queryByText("Old organization draft")).not.toBeInTheDocument();
  });
  it.each(["en", "es"])("renders the immutable evaluated snapshot rather than the current definition in %s", async (lang) => {
    const snapshot = { ...definition, name: "Historical settings", triggerKind: "casework_deadline", thresholdDays: 7, version: 2, cadence: "weekly", conditions: { deadlineKind: "hearing", status: "active", chapterId: "chapter-a" }, actionKind: "notify_in_app", actionConfig: { recipientId: personId }, sourceFilterAvailable: true };
    const { api } = setup({ tab: "run", lang, query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run: { ...run, definitionSnapshotAvailable: true, definition: snapshot }, effects: page() } }) } });
    const region = await screen.findByRole("region", { name: lang === "es" ? "Definición evaluada" : "Evaluated definition" });
    expect(within(region).getByText("2")).toBeVisible();
    expect(within(region).getByText(lang === "es" ? "Plazo registrado del caso" : "Tracked casework deadline")).toBeVisible();
    expect(within(region).getByText(lang === "es" ? /Umbral de 7 días · Activo · Audiencia/ : /7 day threshold · Active · Hearing/)).toBeVisible();
    expect(within(region).getByText(lang === "es" ? "Enviar un aviso en la aplicación" : "Send an in-app notice")).toBeVisible();
    expect(within(region).getByText(lang === "es" ? "Cada semana" : "Weekly")).toBeVisible();
    expect(api.getDefinition).not.toHaveBeenCalled();
    expect(within(region).queryByText("Task overdue")).not.toBeInTheDocument();
    expect(region.textContent).not.toContain(personId);
  });
  it.each(["en", "es"])("explains unavailable historical snapshots without substituting current settings in %s", async (lang) => {
    setup({ tab: "run", lang, query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run: { ...run, definitionSnapshotAvailable: false, definition: { ...definition, name: "Do not substitute these settings" } }, effects: page() } }) } });
    expect(await screen.findByText(lang === "es" ? /No hay una copia inmutable/ : /No immutable definition snapshot/)).toBeVisible();
    expect(screen.queryByText("Do not substitute these settings")).not.toBeInTheDocument();
    expect(screen.queryByText(lang === "es" ? "Versión evaluada" : "Evaluated version")).not.toBeInTheDocument();
  });
  it("redacts restricted historical source filters while retaining safe evaluated predicates", async () => {
    const snapshot = { ...definition, conditions: { sourceId: personId, chapterId: "PRIVATE CHAPTER", priority: "high", assignment: "assigned" }, sourceFilterAvailable: false };
    setup({ tab: "run", query: `?run=${runId}`, overrides: { getRun: vi.fn().mockResolvedValue({ ok: true, data: { run: { ...run, definitionSnapshotAvailable: true, definition: snapshot }, effects: page() } }) } });
    const region = await screen.findByRole("region", { name: "Evaluated definition" });
    expect(within(region).getByText(/Historical source filter is restricted/)).toBeVisible();
    expect(within(region).getByText(/Priority: High · Assigned/)).toBeVisible();
    expect(region.textContent).not.toContain(personId);
    expect(region.textContent).not.toContain("PRIVATE CHAPTER");
    expect(within(region).queryByText(/All eligible authorized campaigns/)).not.toBeInTheDocument();
  });
  it("keeps contextual case IDs and chapter scope when selecting a compatible child trigger", async () => {
    const { api } = setup({ tab: "recipes", query: `?sourceKind=case&sourceId=${personId}` });
    await waitFor(() => expect(screen.getByLabelText("Workflow")).toHaveValue("casework"));
    const recipes = await screen.findAllByRole("button", { name: /^Use recipe:/ });
    fireEvent.click(recipes[0]);
    const trigger = await screen.findByLabelText("When this happens");
    expect(within(trigger).queryByRole("option", { name: "Task due soon" })).not.toBeInTheDocument();
    expect(within(trigger).queryByRole("option", { name: "Appointment approaching" })).not.toBeInTheDocument();
    fireEvent.change(trigger, { target: { value: "incomplete_case_checklist" } });
    expect(screen.getByText(/This draft stays bound to your selected source/)).toBeVisible();
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(session, expect.objectContaining({ triggerKind: "incomplete_case_checklist", thresholdDays: "0", conditions: { sourceId: personId, chapterId: "chapter-a" } })));
  });
  it("preserves compatible chapter, priority and assignment filters across task trigger changes", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Assigned high priority work" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = screen.getByLabelText("Campaign / task board"); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.change(screen.getByLabelText("Campaign / task board"), { target: { value: "chapter-a" } });
    fireEvent.change(screen.getByLabelText("Source task priority"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Source task assignment"), { target: { value: "assigned" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("When this happens"), { target: { value: "task_due" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Source task priority")).toHaveValue("high");
    expect(screen.getByLabelText("Source task assignment")).toHaveValue("assigned");
    for (let step = 0; step < 3; step += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Priority: High · Assigned/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveDefinition).toHaveBeenCalledWith(session, expect.objectContaining({ triggerKind: "task_due", conditions: { chapterId: "chapter-a", priority: "high", assignment: "assigned" } })));
  });
  it("does not offer assigned-task filters for unassigned-task triggers or task-only fields for cases", async () => {
    setup(); fireEvent.click(await screen.findByRole("button", { name: "Custom automation" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unassigned task review" } });
    fireEvent.change(screen.getByLabelText("When this happens"), { target: { value: "unassigned_task" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(within(screen.getByLabelText("Source task assignment")).queryByRole("option", { name: "Assigned", exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("When this happens"), { target: { value: "case_deadline" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByLabelText("Source task priority")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source task assignment")).not.toBeInTheDocument();
  });
  it("reports current history outcomes without presenting runtime dependencies as pre-approved", async () => {
    setup({ tab: "settings", control: { runs: [{ ...run, status: "failed", startedAt: "2026-09-09T10:00:00Z" }, { ...run, status: "partial", startedAt: "2026-09-10T10:00:00Z" }] } });
    expect(await screen.findByText(/Not pre-approved/)).toBeVisible();
    expect(screen.getByText(/Partial/)).toBeVisible();
    expect(screen.getByText("Scheduler ready")).toBeVisible();
    expect(screen.getByText("Paused")).toBeVisible();
  });

  it("stacks the Discover flow grid until the container is wide enough for the two-column page", () => {
    const css = readFileSync("src/features/automation/automationPages.css", "utf8");
    const flowRule = css.match(/\.automation-discover__flow\s*\{[^}]+\}/)?.[0] ?? "";
    expect(flowRule).toMatch(/grid-template-columns:\s*1fr/);
    expect(flowRule).not.toMatch(/repeat\(\s*5/);
    const containerQuery = css.match(/@container\s*\(min-width:\s*(\d+)px\)\s*\{[\s\S]*?\.automation-discover\s*\{[^}]*grid-template-columns:[^}]+\}/);
    expect(containerQuery).not.toBeNull();
    expect(Number(containerQuery[1])).toBeLessThan(760);
    expect(containerQuery[0]).toMatch(/\.automation-discover\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.6fr\)\s+minmax\(16rem,\s*\.75fr\)/);
  });
});
