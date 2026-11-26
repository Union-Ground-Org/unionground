import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { WorkloadConfigurationCard } from "../src/components/AdminWorkloadConfiguration.jsx";
import { WorkloadConfiguredEntry } from "../src/components/WorkloadConfiguredEntry.jsx";
import { WorkloadConfiguredHistory, withWorkloadHistoryDefinition } from "../src/components/WorkloadConfiguredHistory.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { createMemberSessionLoader, memberMutationResources, memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";
import { configuredWorkloadCsv, defaultWorkloadDefinition, liveWorkloadConfigurationApi, workloadDefinitionError, workloadDefinitionProblem, workloadFieldLabel, workloadPersonalSummary, workloadPeriodKey, workloadValuesError } from "../src/lib/workloadConfiguration.js";
import { loadOrganizationWorkloadConfiguration, saveOrganizationWorkloadConfiguration, submitWorkloadLog } from "../src/lib/memberApi.js";
import { fictionalWorkloadConfigurations, largeWorkloadDefinition } from "./fixtures/workloadConfigurations.js";

const field = (key, type = "number", extra = {}) => ({ key, label: key, type, kind: "field", visible: true, required: false, retired: false, unit: "", summary: "none", options: [], ...extra });
const definition = () => ({ title: "Service report", period: "week", statuses: ["draft", "complete"], fields: [field("volume", "number", { summary: "sum", unit: "visits", required: true }), field("area", "text")] });
const config = (d = definition()) => ({ organizationId: "fictional-org", version: 1, definition: d, canEdit: true, history: [{ version: 1, definition: d, createdAt: "2026-11-01" }] });
const mount = (node) => render(<LanguageProvider lang="en">{node}</LanguageProvider>);
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => { clearDeviceParityState(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/m/workload"); });

describe("versioned workload definition and values", () => {
  it("preserves defaults and recognizes supported configuration limits", () => {
    expect(workloadDefinitionError(defaultWorkloadDefinition())).toBeNull();
    expect(workloadDefinitionError(largeWorkloadDefinition())).toBeNull();
    for (const f of fictionalWorkloadConfigurations()) expect(workloadDefinitionError(f.definition)).toBeNull();
  });
  it("names the first broken rule in Main's check order", () => {
    // A flag that is not true/false is read before a non-numeric category, as on Main.
    const both = { ...definition(), fields: [field("volume"), field("note", "text", { kind: "category", required: "yes" })] };
    expect(workloadDefinitionProblem(both)).toMatchObject({ section: "fields", reason: "fieldData", index: 1 });
    expect(workloadDefinitionProblem({ ...both, fields: [field("volume"), field("note", "text", { kind: "category" })] })).toMatchObject({ reason: "fieldKind", control: "kind", index: 1 });
    expect(workloadDefinitionProblem({ ...both, fields: [field("volume"), field("note", "text", { options: "broken" })] })).toMatchObject({ reason: "fieldData", index: 1 });
    expect(workloadDefinitionProblem({ ...both, fields: [field("volume"), field("note", "text", { options: "broken" })] }).control).toBeUndefined();
    expect(workloadFieldLabel(field("a", "text", { label: "workload.workedOn" }), "en")).toBe("Day worked");
    const d = definition();
    for (const bad of [null, {}, { ...d, title: "" }, { ...d, title: "<b>bad" }, { ...d, period: "year" }, { ...d, statuses: [] }, { ...d, statuses: ["a", "a"] }, { ...d, statuses: ["x".repeat(41)] }, { ...d, fields: [] }, { ...d, fields: [...d.fields, d.fields[0]] }]) expect(workloadDefinitionError(bad)).not.toBeNull();
    for (const patch of [{ key: "9bad" }, { type: "file" }, { kind: "other" }, { label: "" }, { required: "true" }, { visible: false, required: true }, { retired: true, required: true }, { unit: "x".repeat(25) }, { summary: "median" }, { type: "text", summary: "sum" }, { type: "text", kind: "category" }, { options: null }, { type: "select", options: [] }, { type: "select", options: ["a", "a"] }, { type: "select", options: ["<b>bad"] }]) expect(workloadDefinitionError({ ...d, fields: [{ ...field("a"), ...patch }] }), JSON.stringify(patch)).not.toBeNull();
    expect(workloadDefinitionError({ ...d, fields: [field("a", "number", { visible: false })] })).toBe("visible");
    expect(workloadDefinitionError({ ...d, fields: [field("a", "select", { options: ["a", "b"] })] })).toBeNull();
    expect(workloadDefinitionError({ ...d, fields: [field("priority", "text")] })).toBe("fields");
    expect(workloadDefinitionError({ ...d, fields: [field("employment", "select", { options: ["unknown"] })] })).toBe("fields");
  });
  it("validates required and typed values without treating false or zero as missing", () => {
    const d = { ...definition(), fields: [field("n", "number", { required: true }), field("s", "select", { options: ["a", "b"] }), field("b", "boolean", { required: true }), field("d", "date"), field("text", "text"), field("priority"), field("hoursWorked"), field("workedOn", "date")] };
    expect(workloadValuesError(d, { n: 0, b: false, s: "a", d: "2026-02-28", text: "fine", priority: 300, hoursWorked: 4.25 }, "draft")).toBeNull();
    for (const [values, status] of [[{}, "draft"], [{ n: 1, b: false }, "missing"], [[], "draft"], [null, "draft"], [{ n: 1, b: false, bad: 1 }, "draft"], [{ n: "1", b: false }, "draft"], [{ n: -1, b: false }, "draft"], [{ n: 1, b: "false" }, "draft"], [{ n: 1, b: false, s: "c" }, "draft"], [{ n: 1, b: false, d: "2026-02-30" }, "draft"], [{ n: 1, b: false, d: "invalid" }, "draft"], [{ n: 1, b: false, text: "x".repeat(501) }, "draft"], [{ n: 1, b: false, priority: 1.2 }, "draft"], [{ n: 1, b: false, hoursWorked: 1.2 }, "draft"], [{ n: 1, b: false, workedOn: "2099-01-01" }, "draft"]]) expect(workloadValuesError(d, values, status)).not.toBeNull();
    expect(workloadValuesError(definition(), { volume: 1, area: "" }, "draft")).toBeNull();
  });
  it("groups periods and versions separately and exports original labels with safe cells", () => {
    expect(workloadPeriodKey("2026-11-01", "week")).toBe("2026-10-26");
    expect(workloadPeriodKey("2026-11-01", "month")).toBe("2026-11");
    expect(workloadPeriodKey("2026-11-01", "quarter")).toBe("2026-Q4");
    expect(workloadPeriodKey("invalid", "week")).toBe("");
    const e = { id: "e", createdAt: "2026-11-03T12:00:00Z", receipt: "receipt", configurationSnapshot: config(), values: { volume: 3, area: '=HYPERLINK("bad")' }, status: "draft" };
    const newer = { ...e, configurationSnapshot: { ...config(), version: 2, definition: { ...definition(), fields: [field("volume", "number", { summary: "average", unit: "items" })] } }, values: { volume: 7 } };
    const groups = workloadPersonalSummary([{}, e, { ...e, values: { volume: 5 } }, newer]);
    expect(groups.map((g) => [g.version, g.value])).toEqual([[1, 8], [2, 7]]);
    const csv = configuredWorkloadCsv([e]); expect(csv).toContain('"configuration_version"'); expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain('"visits"');
    expect(configuredWorkloadCsv([{ ...e, meta: "original employment and overtime", configurationSnapshot: { ...config(), version: 0 } }])).toContain('"legacy_metadata","Legacy metadata","text","","original employment and overtime"');
    expect(configuredWorkloadCsv([{ ...e, meta: "unused legacy defaults" }])).not.toContain("unused legacy defaults");
    expect(withWorkloadHistoryDefinition(e)).toBe(e);
    expect(withWorkloadHistoryDefinition({ counts: { priority: 4 }, workedOn: "2026-11-01", hoursWorked: 2, note: "memo" }).values).toMatchObject({ priority: 4, hoursWorked: 2, note: "memo" });
  });
});

describe("administrator workload settings", () => {
  function admin({ load, save, chapterScoped = false, lang = "en" } = {}) {
    const api = { loadWorkloadConfiguration: load || vi.fn().mockResolvedValue(config()), saveWorkloadConfiguration: save || vi.fn().mockImplementation(async (d) => ({ ...config(d), version: 2 })) };
    const onNotice = vi.fn(); const view = render(<LanguageProvider lang={lang}><WorkloadConfigurationCard api={api} onNotice={onNotice} chapterScoped={chapterScoped} /></LanguageProvider>); return { ...view, api, onNotice };
  }
  describe.each([
    ["en", "Preview your changes before applying them.", "Use 1 to 80 characters in the form title. Leave out angle brackets and control characters.",
      "Use each status only once.", "Use each choice only once for Shift.", "Workload configuration could not be loaded."],
    ["es", "Revisa la vista previa de tus cambios antes de aplicarlos.", "Usa de 1 a 80 caracteres en el título del formulario. Evita los signos < y > y los caracteres de control.",
      "Usa cada estado una sola vez.", "Usa cada opción una sola vez para Shift.", "No se pudo cargar la configuración de carga de trabajo."],
  ])("blocked configuration feedback (%s)", (lang, previewFirst, titleReason, statusReason, choicesReason, loadReason) => {
    const label = (key) => t(lang, `workload.config.${key}`);
    const preview = () => screen.getByRole("button", { name: label("preview") });
    const apply = () => screen.getByRole("button", { name: label("apply") });

    it("explains why Apply needs a fresh preview", async () => {
      const { api } = admin({ lang });
      await screen.findByLabelText(label("formTitle"));
      expectRefusedEveryWay(apply(), previewFirst, () => api.saveWorkloadConfiguration.mock.calls.length > 0);
      fireEvent.click(preview());
      expect(apply()).not.toHaveAttribute("aria-disabled");
      change(label("formTitle"), "Service totals");
      expect(apply()).toHaveAccessibleDescription(previewFirst);
    });

    it("identifies the invalid title and status controls", async () => {
      const { api } = admin({ lang });
      const title = await screen.findByLabelText(label("formTitle"));
      // The polite region is in place before a problem appears, so the change is read out.
      const live = document.querySelector("[data-workload-problem]");
      expect(live).toHaveAttribute("role", "status");
      expect(live).toHaveTextContent(/^$/);
      fireEvent.change(title, { target: { value: "<report>" } });
      expect(title).toHaveAccessibleDescription(titleReason);
      expect(live).toHaveTextContent(titleReason);
      expect(document.querySelectorAll("[data-workload-problem]")).toHaveLength(1);
      expect(title).toHaveAttribute("aria-invalid", "true");
      expectRefusedEveryWay(preview(), titleReason, () => Boolean(screen.queryByRole("region", { name: label("preview") })));
      expect(apply()).toHaveAccessibleDescription(titleReason);
      fireEvent.change(title, { target: { value: "Service totals" } });
      const statuses = screen.getByLabelText(label("statuses"));
      fireEvent.change(statuses, { target: { value: "open, open" } });
      expect(statuses).toHaveAccessibleDescription(statusReason);
      expect(live).toHaveTextContent(statusReason);
      expect(preview()).toHaveAccessibleDescription(statusReason);
      fireEvent.change(statuses, { target: { value: "open, closed" } });
      expect(live).toHaveTextContent(/^$/);
      fireEvent.click(preview());
      fireEvent.click(apply());
      await waitFor(() => expect(api.saveWorkloadConfiguration).toHaveBeenCalledTimes(1));
    });

    it("identifies the field with duplicate choices", async () => {
      const initial = { ...definition(), fields: [field("shift", "select", { label: "Shift", options: ["Day", "Night"] })] };
      admin({ lang, load: vi.fn().mockResolvedValue(config(initial)) });
      const choices = await screen.findByLabelText(label("options"));
      fireEvent.change(choices, { target: { value: "Day, Day" } });
      expect(choices).toHaveAccessibleDescription(choicesReason);
      expect(preview()).toHaveAccessibleDescription(choicesReason);
    });

    it("identifies the hidden field needed by another visible field", async () => {
      admin({ lang, load: vi.fn().mockResolvedValue(config(defaultWorkloadDefinition())) });
      const shown = await screen.findByLabelText(`${label("visible")} ptHours`);
      const hours = t(lang, "workload.ptHours");
      const employment = label("default.employment");
      const reason = lang === "es" ? `Muestra ${hours} u oculta ${employment}.` : `Show ${hours} or hide ${employment}.`;
      fireEvent.click(shown);
      expect(shown).toHaveAccessibleDescription(reason);
      expect(apply()).toHaveAccessibleDescription(reason);
      fireEvent.click(shown);
      expect(preview()).not.toHaveAttribute("aria-disabled");
    });

    it("asks to hide Employment when the part-time hours field is not in the form", async () => {
      const initial = defaultWorkloadDefinition();
      initial.fields = initial.fields.filter((f) => f.key !== "ptHours");
      admin({ lang, load: vi.fn().mockResolvedValue(config(initial)) });
      const employmentShown = await screen.findByLabelText(`${label("visible")} employment`);
      const hours = t(lang, "workload.ptHours");
      const employment = label("default.employment");
      const reason = lang === "es" ? `Oculta ${employment}: necesita ${hours}, que no está en este formulario.` : `Hide ${employment}: it needs ${hours}, which is not in this form.`;
      expect(employmentShown).toHaveAttribute("aria-invalid", "true");
      expect(employmentShown).toHaveAccessibleDescription(reason);
      expect(preview()).toHaveAccessibleDescription(reason);
      fireEvent.click(employmentShown);
      expect(preview()).not.toHaveAttribute("aria-disabled");
    });

    it("asks to clear Retired on part-time hours rather than to show it", async () => {
      admin({ lang, load: vi.fn().mockResolvedValue(config(defaultWorkloadDefinition())) });
      const retired = await screen.findByLabelText(`${label("retired")} ptHours`);
      const hours = t(lang, "workload.ptHours");
      const employment = label("default.employment");
      const reason = lang === "es" ? `Desmarca Retirado en ${hours} u oculta ${employment}.` : `Clear Retired on ${hours}, or hide ${employment}.`;
      fireEvent.click(retired);
      expect(retired).toHaveAttribute("aria-invalid", "true");
      expect(retired).toHaveAccessibleDescription(reason);
      expect(screen.getByLabelText(`${label("visible")} ptHours`)).not.toHaveAttribute("aria-invalid");
      fireEvent.click(retired);
      expect(preview()).not.toHaveAttribute("aria-disabled");
    });

    it("asks to clear Retired and show part-time hours when it is both retired and hidden", async () => {
      admin({ lang, load: vi.fn().mockResolvedValue(config(defaultWorkloadDefinition())) });
      const retired = await screen.findByLabelText(`${label("retired")} ptHours`);
      const shown = screen.getByLabelText(`${label("visible")} ptHours`);
      const hours = t(lang, "workload.ptHours");
      const employment = label("default.employment");
      const reason = lang === "es" ? `Desmarca Retirado en ${hours} y muéstralo, u oculta ${employment}.` : `Clear Retired on ${hours} and show it, or hide ${employment}.`;
      fireEvent.click(shown);
      fireEvent.click(retired);
      expect(retired).toHaveAttribute("aria-invalid", "true");
      expect(retired).toHaveAccessibleDescription(reason);
      expect(shown).not.toHaveAttribute("aria-invalid");
      expect(preview()).toHaveAccessibleDescription(reason);
      fireEvent.click(retired);
      fireEvent.click(shown);
      expect(preview()).not.toHaveAttribute("aria-disabled");
    });

    it("says to reload when a field's stored choices cannot be read", async () => {
      const initial = { ...definition(), fields: [field("volume"), field("note", "text", { label: "Fixture memo", options: "broken" })] };
      const { api } = admin({ lang, load: vi.fn().mockResolvedValue(config(initial)) });
      await screen.findByLabelText(label("formTitle"));
      const reason = lang === "es"
        ? "No se pueden leer los ajustes guardados de Fixture memo. Recarga la página para cargarlos de nuevo."
        : "The saved settings for Fixture memo cannot be read. Reload the page to load them again.";
      expect(screen.queryByLabelText(label("options"))).toBeNull();
      expect(within(screen.getByText("(note)").closest("li")).getByText(reason)).toBeInTheDocument();
      expectRefusedEveryWay(preview(), reason, () => Boolean(screen.queryByRole("region", { name: label("preview") })));
      expect(api.saveWorkloadConfiguration).not.toHaveBeenCalled();
    });

    it("ends loading after a refusal and retries from the card", async () => {
      const load = vi.fn().mockRejectedValueOnce(new Error("fixture offline")).mockResolvedValue(config());
      admin({ lang, load });
      expect(await screen.findByRole("alert")).toHaveTextContent(loadReason);
      expect(screen.queryByText(label("loading"))).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: t(lang, "app.tryAgain") }));
      expect(await screen.findByLabelText(label("formTitle"))).toHaveValue("Service report");
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  it("requires preview, invalidates it on edits, then applies with the observed version", async () => {
    const { api, onNotice } = admin(); await screen.findByLabelText("Form title");
    expect(screen.getByRole("button", { name: "Apply configuration" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply configuration" })); expect(api.saveWorkloadConfiguration).not.toHaveBeenCalled();
    change("Form title", "Service totals"); fireEvent.click(screen.getByRole("button", { name: "Preview configuration" }));
    expect(screen.getByRole("region", { name: "Preview configuration" })).toHaveTextContent("Service totals");
    change("Statuses (comma separated, up to 12)", "open, closed"); expect(screen.getByRole("button", { name: "Apply configuration" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply configuration" })); expect(api.saveWorkloadConfiguration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview configuration" })); fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Workload configuration applied."));
    expect(api.saveWorkloadConfiguration).toHaveBeenCalledWith(expect.objectContaining({ title: "Service totals", statuses: ["open", "closed"] }), 1, "fictional-org");
  });
  // Record 8435: Apply stays focusable while it applies.
  it("keeps Apply configuration focused while it applies, and applies it once", async () => {
    const { api } = admin(); await screen.findByLabelText("Form title");
    change("Form title", "Service totals"); fireEvent.click(screen.getByRole("button", { name: "Preview configuration" }));
    await expectHeldWriteFocus(api.saveWorkloadConfiguration, screen.getByRole("button", { name: "Apply configuration" }));
    expect(api.saveWorkloadConfiguration).toHaveBeenCalledTimes(1);
  });
  it("edits labels, types, choices, units, flags and ordering", async () => {
    const { container } = admin(); await screen.findByLabelText("Form title");
    change("Label volume", "Customers"); change("Reporting period", "quarter");
    fireEvent.click(screen.getByRole("button", { name: "Add field" })); change("Type custom_1", "select");
    change("Choices (comma separated, up to 20)", "morning, night");
    fireEvent.click(screen.getByRole("button", { name: "Move up custom_1" })); fireEvent.click(screen.getByRole("button", { name: "Move down custom_1" }));
    fireEvent.click(screen.getByLabelText("Required custom_1")); fireEvent.click(screen.getByLabelText("Retired custom_1"));
    fireEvent.click(screen.getByLabelText("Shown area"));
    const row = container.querySelector(".workload-definition-field");
    fireEvent.change(within(row).getByLabelText("Unit"), { target: { value: "people" } });
    fireEvent.change(within(row).getByLabelText("Summary"), { target: { value: "average" } });
    fireEvent.change(within(row).getByLabelText("Use as"), { target: { value: "category" } });
    expect(screen.getByRole("button", { name: "Preview configuration" })).toBeEnabled();
    change("Form title", ""); expect(screen.getByRole("button", { name: "Preview configuration" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Preview configuration" })); expect(screen.queryByRole("region", { name: "Preview configuration" })).toBeNull();
  });
  it("keeps multiword statuses and choices typed one character at a time", async () => {
    const { api } = admin(); await screen.findByLabelText("Form title");
    const type = (input, text) => { fireEvent.change(input, { target: { value: "" } }); for (const ch of text) fireEvent.change(input, { target: { value: input.value + ch } }); };
    const statuses = screen.getByLabelText("Statuses (comma separated, up to 12)");
    type(statuses, "In progress, Done "); expect(statuses).toHaveValue("In progress, Done ");
    fireEvent.blur(statuses); expect(statuses).toHaveValue("In progress, Done");
    fireEvent.click(screen.getByRole("button", { name: "Add field" })); change("Type custom_1", "select");
    const choices = screen.getByLabelText("Choices (comma separated, up to 20)");
    type(choices, "Day shift ,Night shift"); expect(choices).toHaveValue("Day shift ,Night shift");
    fireEvent.blur(choices); expect(choices).toHaveValue("Day shift, Night shift");
    fireEvent.click(screen.getByRole("button", { name: "Preview configuration" })); fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
    await waitFor(() => expect(api.saveWorkloadConfiguration).toHaveBeenCalledTimes(1));
    const [saved] = api.saveWorkloadConfiguration.mock.calls[0];
    expect(saved.statuses).toEqual(["In progress", "Done"]);
    expect(saved.fields.find((f) => f.key === "custom_1").options).toEqual(["Day shift", "Night shift"]);
  });
  it("shows read/load/apply failures and omits chapter-only administration", async () => {
    const a = admin({ load: vi.fn().mockRejectedValue(new Error("offline")) }); await screen.findByRole("alert"); a.unmount();
    const b = admin({ load: vi.fn().mockResolvedValue({ ...config(), canEdit: false }) }); await screen.findByText("An organization administrator manages workload configuration."); b.unmount();
    const c = admin({ chapterScoped: true }); expect(c.api.loadWorkloadConfiguration).not.toHaveBeenCalled(); c.unmount();
    const stale = admin({ save: vi.fn().mockRejectedValue(new Error("stale")) }); await screen.findByLabelText("Form title"); fireEvent.click(screen.getByRole("button", { name: "Preview configuration" })); fireEvent.click(screen.getByRole("button", { name: "Apply configuration" })); await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Apply configuration" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply configuration" })); expect(stale.api.saveWorkloadConfiguration).toHaveBeenCalledTimes(1);
  });
});

describe("configured member/staff entries, filters and reports", () => {
  it("creates a typed entry for each fictional organization's different configuration", async () => {
    for (const fixture of fictionalWorkloadConfigurations()) {
      const onSave = vi.fn().mockResolvedValue({ id: "saved" }); const view = mount(<WorkloadConfiguredEntry configuration={config(fixture.definition)} onSave={onSave} />);
      if (fixture.name.includes("library")) { change("Patron visits * (visits)", "5"); change("Shift *", "morning"); }
      else { change("Route distance * (km)", "3.5"); fireEvent.click(screen.getByLabelText("Equipment checked *")); change("Park area *", "West green"); }
      change("Day worked", "2026-11-01"); change("Hours worked (hours)", "4.5");
      fireEvent.submit(view.container.querySelector("form")); await screen.findByText("Workload entry saved.");
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configurationVersion: 1, values: expect.objectContaining({ workedOn: "2026-11-01", hoursWorked: 4.5 }) })); view.unmount();
    }
  });
  it("refuses invalid values, reports a stale form and supports cancel/edit", async () => {
    const save = vi.fn().mockRejectedValue({ details: "workload_configuration_changed" }); const cancel = vi.fn();
    const view = mount(<WorkloadConfiguredEntry configuration={config()} onSave={save} onCancel={cancel} />);
    fireEvent.submit(view.container.querySelector("form")); expect(save).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent("Check the marked fields: volume.");
    change("volume * (visits)", "3"); fireEvent.submit(view.container.querySelector("form")); await screen.findByText(/configuration changed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(cancel).toHaveBeenCalledOnce();
  });
  it("filters reports, exports the filtered version, and edits with the original definition", async () => {
    const rows = [
      { id: "one", createdAt: "2026-11-03T12:00:00Z", receipt: "one", configurationSnapshot: config(), values: { volume: 5, area: "East" }, status: "draft" },
      { id: "two", createdAt: "2026-10-03T12:00:00Z", receipt: "two", configurationSnapshot: { ...config(), version: 2 }, values: { volume: 7 }, status: "complete" },
    ];
    const create = vi.fn().mockReturnValue("blob:download"); Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true }); Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true }); vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const save = vi.fn().mockResolvedValue({ id: "one" }); const view = mount(<WorkloadConfiguredHistory entries={rows} configuration={config()} onSave={save} />);
    change("Status", "draft"); expect(view.container.querySelectorAll(".mwl-histrow")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /CSV/ })); expect(create).toHaveBeenCalledOnce();
    change("Reporting period", "2026-11-02"); change("Field", "area");
    fireEvent.click(screen.getByRole("button", { name: "Edit entry" }));
    const form = view.container.querySelector("form"); fireEvent.change(within(form).getByLabelText("volume * (visits)"), { target: { value: "6" } }); fireEvent.submit(form);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ entryId: "one", configurationVersion: 1, values: { volume: 6, area: "East" } })));
    change("Status", "complete"); expect(screen.getByText(/No submissions yet/)).toBeInTheDocument();
  });
  it("wires the configured view into Submit, History and Stats without exposing collective custom metrics", () => {
    mount(<WorkloadView data={{ workload: { configuration: config(), entries: [] } }} onLogWork={vi.fn()} />);
    expect(screen.getByText(/Service report/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" })); expect(screen.getByText("Your workload report")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stats" })); expect(screen.getByText(/Custom fields support your personal report/)).toBeInTheDocument();
  });
});

describe("configuration RPC and session invalidation wiring", () => {
  it("loads the configuration on the real Workload route and invalidates it after a write", async () => {
    let current = config(); const calls = [];
    const rows = { member_profiles: { id: "member", first_name: "Test", full_name: "Fictional Worker" } };
    const client = { from(table) { let query; query = new Proxy({}, { get(_o, k) { if (k === "then") return (resolve, reject) => Promise.resolve({ data: rows[table] || [], error: null }).then(resolve, reject); return () => query; } }); return query; }, rpc: async (name) => { calls.push(name); return { data: name === "get_organization_workload_configuration" ? current : null, error: null }; } };
    const loader = createMemberSessionLoader(client, { id: "member" });
    expect(memberResourcesForRoute("workload")).toContain("rpc:get_organization_workload_configuration");
    expect(memberMutationResources("submitWorkloadLog")).toContain("rpc:get_organization_workload_configuration");
    expect((await loader.loadRoute("workload")).workload.configuration).toEqual(current);
    await loader.loadRoute("workload"); expect(calls.filter((n) => n === "get_organization_workload_configuration")).toHaveLength(1);
    current = { ...current, version: 2 }; loader.invalidateResources(memberMutationResources("submitWorkloadLog"));
    expect((await loader.loadRoute("workload")).workload.configuration.version).toBe(2);
    loader.dispose();
  });
  it("mounts the full configuration card on the administrator settings surface", async () => {
    mount(<AdminSecurityConfiguration configuration={null} api={{ loadWorkloadConfiguration: vi.fn().mockResolvedValue(config()) }} reload={vi.fn()} onNotice={vi.fn()} />);
    await screen.findByLabelText("Form title"); expect(screen.getByRole("heading", { name: "Workload configuration" })).toBeInTheDocument();
  });
  it.each([["en", "leave the category out until at least 25 workers have"], ["es", "la omiten hasta que al menos 25 trabajadores lo hayan hecho"]])("tells the administrator in %s what hiding an original category does to collective reports", async (lang, text) => {
    render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={null} api={{ loadWorkloadConfiguration: vi.fn().mockResolvedValue(config()) }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });
  it("passes exact versions for applies and entry edits", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { ok: true } }) };
    await loadOrganizationWorkloadConfiguration(client); await saveOrganizationWorkloadConfiguration(client, definition(), 1);
    await submitWorkloadLog(client, { organizationId: "fictional-org", configurationVersion: 1, entryId: "entry", values: { volume: 1 }, status: "draft" });
    expect(client.rpc).toHaveBeenLastCalledWith("save_configured_workload_log", { p_organization_id: "fictional-org", p_entry_id: "entry", p_version: 1, p_values: { volume: 1 }, p_status: "draft" });
    await submitWorkloadLog(client, { configurationVersion: 1, values: {}, status: "draft" }); expect(client.rpc.mock.calls.at(-1)[1].p_entry_id).toBeNull();
  });
  it("invalidates the configuration resource and refuses a late answer after scope changes", async () => {
    let current = true; let data = { workload: { entries: [] } };
    const loader = { invalidateResources: vi.fn() }; const load = vi.fn().mockResolvedValue(config());
    const api = liveWorkloadConfigurationApi({ load, save: vi.fn().mockResolvedValue(config()), guardRef: { current: { captureOperation: () => ({ isCurrent: () => current }) } }, loaderRef: { current: loader }, setData: (fn) => { data = fn(data); } });
    expect(await api.loadWorkloadConfiguration()).toEqual(config()); await api.saveWorkloadConfiguration(definition(), 0);
    expect(data.workload.configuration).toEqual(config()); expect(loader.invalidateResources).toHaveBeenCalledWith(["rpc:get_organization_workload_configuration"]);
    current = false; expect(await api.saveWorkloadConfiguration(definition(), 1)).toBeUndefined(); expect(loader.invalidateResources).toHaveBeenCalledOnce();
  });
});

describe("configured workload entries keep focus while they save (record 8435)", () => {
  it("keeps Submit focused while the entry is saved, and saves it once", async () => {
    const save = vi.fn(async () => ({ id: "saved" }));
    mount(<WorkloadConfiguredEntry configuration={config()} onSave={save} />);
    change("volume * (visits)", "3");
    const submit = document.querySelector('form button[type="submit"]');
    await expectHeldWriteFocus(save, submit);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("configured workload fields while the entry saves (record 8435)", () => {
  it("keeps every configured field focusable but pending while the entry is saved", async () => {
    let release;
    const save = vi.fn(() => new Promise((resolve) => { release = () => resolve({ id: "saved" }); }));
    mount(<WorkloadConfiguredEntry configuration={config()} onSave={save} />);
    change("volume * (visits)", "3");
    fireEvent.click(document.querySelector('form button[type="submit"]'));
    const fields = [...document.querySelectorAll(".workload-configured-fields input, .workload-configured-fields select")];
    expect(fields.length).toBeGreaterThan(0);
    try {
      await waitFor(() => fields.forEach((field) => expect(field).toHaveAttribute("aria-disabled", "true")));
      fields.forEach((field) => expect(field).toBeEnabled());
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { release(); });
    }
    fields.forEach((field) => expect(field).not.toHaveAttribute("aria-disabled", "true"));
  });
});
