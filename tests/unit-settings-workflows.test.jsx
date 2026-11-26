import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { TaskTemplateDialog } from "../src/views/TaskTemplateDialog.jsx";
import { FormsView } from "../src/views/FormsView.jsx";
import { DEMO_TASK_TEMPLATES } from "../src/lib/taskTemplates.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { workloadPersonalSummary } from "../src/lib/workloadConfiguration.js";
import { UnitWorkflowChoice, useUnitWorkflow } from "../src/features/chapterAccess/UnitWorkflowChoice.jsx";

const member = { id: "actor", chapterId: "chapter", organizationId: "org" };
const units = [{ id: "north", name: "North" }, { id: "south", name: "South" }];
const definition = { title: "Unit report", period: "week", statuses: ["logged"], fields: [
  { key: "cases", label: "Cases", type: "number", kind: "category", required: false, visible: true, retired: false, summary: "sum", options: [], unit: "cases" },
] };
const context = (unitId = null) => ({ actorId: "actor", chapterId: "chapter", organizationId: "org", units, unitId, needsChoice: !unitId,
  effective: unitId ? { forms: [], templates: ["issue_incident"], configuration: { ...member, actorId: member.id, unitId, unitName: unitId === "north" ? "North" : "South", version: 0, settingsRevision: unitId, definition } } : null });
const api = () => ({ load: vi.fn().mockImplementation(async (unit) => context(unit)) });
const mount = (node) => render(<LanguageProvider lang="en">{node}</LanguageProvider>);
beforeEach(() => { clearDeviceParityState(); window.history.replaceState(null, "", "/m/workload"); });

describe("unit settings in mounted workflows", () => {
  it("holds workload creation for an explicit unit and freezes selection through its save", async () => {
    let release;
    const save = vi.fn().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const settings = api();
    mount(<WorkloadView data={{ member, workload: { entries: [] } }} unitSettingsApi={settings} onLogWork={save} />);
    const picker = await screen.findByLabelText("Choose the unit for this work");
    expect(picker.value).toBe(""); expect(screen.queryByText("Chapter settings")).toBeNull();
    expect(screen.queryByRole("button", { name: "Log workload" })).toBeNull();
    fireEvent.change(picker, { target: { value: "south" } });
    fireEvent.change(await screen.findByLabelText("Cases (cases)"), { target: { value: "4" } });
    fireEvent.submit(screen.getByLabelText("Cases (cases)").closest("form"));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ unitId: "south", actorId: "actor", chapterId: "chapter", organizationId: "org", settingsRevision: "south", values: { cases: 4 } })));
    // Frozen as a pending control (record 8435): focusable, announced
    // unavailable, and a change is refused while the save runs.
    const frozen = screen.getByLabelText("Choose the unit for this work");
    expect(frozen).toBeEnabled();
    expect(frozen).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(frozen, { target: { value: "" } });
    expect(frozen.value).toBe("south");
    await act(async () => { release({ id: "saved" }); });
    expect(screen.getByLabelText("Choose the unit for this work")).toBeEnabled();
  });
  it("cannot let a late chapter reply replace the new workflow", async () => {
    let release;
    const settings = { load: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue({ ...context(), actorId: "new", chapterId: "new-chapter" }) };
    function Host({ person }) {
      const workflow = useUnitWorkflow(settings, `${person.id}:${person.chapterId}`, person);
      return <UnitWorkflowChoice workflow={workflow} />;
    }
    const view = mount(<Host person={member} />);
    view.rerender(<LanguageProvider lang="en"><Host person={{ ...member, id: "new", chapterId: "new-chapter" }} /></LanguageProvider>);
    await screen.findByLabelText("Choose the unit for this work");
    await act(async () => { release({ ...context("north"), units: [{ id: "old", name: "Old unit" }] }); });
    expect(screen.queryByRole("option", { name: "Old unit" })).toBeNull();
  });
  it("filters template creation for the chosen unit without filtering existing tasks", async () => {
    function Host() {
      const { t } = useLang();
      return <TaskTemplateDialog t={t} templates={DEMO_TASK_TEMPLATES} workstreams={["Chapter work"]} unitSettingsApi={apiInstance} unitSettingsMember={member} unitSettingsScope="actor:chapter:org" />;
    }
    const apiInstance = api(); mount(<Host />);
    const picker = await screen.findByLabelText("Choose the unit for this work");
    expect(screen.queryByRole("button", { name: /Issue or Incident/i })).toBeNull();
    expect(screen.queryByText("Task templates are not available right now.")).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "north" } });
    await screen.findByRole("button", { name: /Issue or Incident/i });
    expect(screen.queryByRole("button", { name: /Member Follow-up/i })).toBeNull();
  });
  it("shows templates are unavailable when the read has no effective settings or required unit choice", async () => {
    const settings = { load: vi.fn().mockResolvedValue({ ...context(), units: [], needsChoice: false }) };
    function Host() {
      const { t } = useLang();
      return <TaskTemplateDialog t={t} templates={DEMO_TASK_TEMPLATES} unitSettingsApi={settings} unitSettingsMember={member} unitSettingsScope="actor:chapter:org" />;
    }
    mount(<Host />);
    expect(await screen.findByText("Task templates are not available right now.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue or Incident/i })).not.toBeInTheDocument();
  });
  it.each([
    {
      lang: "en", loading: "Loading task templates…", retry: "Try again", template: /Issue or Incident/i,
      failure: "Unit settings could not be loaded.", empty: "Task templates are not available right now.",
    },
    {
      lang: "es", loading: "Cargando las plantillas de tareas…", retry: "Intentar de nuevo", template: null,
      failure: "No se pudieron cargar los ajustes.", empty: "Las plantillas de tareas no están disponibles en este momento.",
    },
  ])("distinguishes loading, failed and successful template reads in $lang", async ({ lang, loading, retry, template, failure, empty }) => {
    let rejectRead;
    let completeRetry;
    const settings = { load: vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { completeRetry = resolve; })) };
    const create = vi.fn();
    function Host() {
      const { t } = useLang();
      return <TaskTemplateDialog t={t} lang={lang} templates={DEMO_TASK_TEMPLATES} workstreams={["Chapter work"]}
        unitSettingsApi={settings} unitSettingsMember={member} unitSettingsScope="actor:chapter:org" onCreate={create} />;
    }
    render(<LanguageProvider lang={lang}><Host /></LanguageProvider>);
    expect.soft(screen.getByRole("status")).toHaveTextContent(loading);
    await act(async () => { rejectRead(new Error("offline fixture")); });

    expect(screen.getByRole("alert")).toHaveTextContent(failure);
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: retry }));
    expect(screen.getByRole("status")).toHaveTextContent(loading);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(settings.load.mock.calls).toEqual([[null], [null]]);

    const result = context("north");
    if (!template) result.effective.templates = [];
    await act(async () => { completeRetry(result); });
    if (template) {
      expect(screen.getByRole("button", { name: template })).toBeInTheDocument();
      expect(screen.queryByText(empty)).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("status")).toHaveTextContent(empty);
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps same-version summaries separate by unit and settings revision", () => {
    const entry = { createdAt: "2026-11-09T12:00:00Z", values: { cases: 2 }, configurationSnapshot: context("north").effective.configuration };
    const south = { ...entry, values: { cases: 5 }, configurationSnapshot: context("south").effective.configuration };
    const renamed = { ...entry, values: { cases: 7 }, configurationSnapshot: { ...entry.configurationSnapshot, settingsRevision: "north-renamed" } };
    expect(workloadPersonalSummary([entry, south, renamed]).map((row) => row.value).sort((a, b) => a - b)).toEqual([2, 5, 7]);
  });
  it("explains why an older draft cannot resume until its unit is chosen", async () => {
    const settings = api();
    const forms = [{ id: "older-draft", templateKey: "grievance", status: "draft", answers: {} }];
    mount(<FormsView data={{ member, forms }} unitSettingsApi={settings} />);
    const resume = screen.getByRole("button", { name: "Resume draft" });
    expect(resume).toHaveAccessibleDescription("Loading your units. Wait before resuming this draft.");
    const picker = await screen.findByLabelText("Choose the unit for this work");
    expect(resume).toHaveAccessibleDescription("Choose your unit above, then resume this draft.");
    fireEvent.click(resume);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose your unit above");
    fireEvent.change(picker, { target: { value: "north" } });
    await waitFor(() => expect(resume).not.toHaveAttribute("aria-disabled"));
    expect(resume).not.toHaveAccessibleDescription();
    fireEvent.click(resume);
    expect(screen.getByText("North", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument();
  });

  it("resumes a pinned draft in its own unit while the other units are loading", () => {
    const settings = { load: vi.fn(() => new Promise(() => {})) };
    const forms = [{ id: "pinned-draft", templateKey: "grievance", status: "draft",
      unitPinned: true, unitId: "south", unitName: "South filing", answers: {} }];
    mount(<FormsView data={{ member, forms }} unitSettingsApi={settings} />);
    const resume = screen.getByRole("button", { name: "Resume draft" });
    expect(resume).not.toHaveAttribute("aria-disabled");
    fireEvent.click(resume);
    expect(screen.getByText("South filing", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument();
  });

  it("filters new forms after choice while keeping every visible draft labeled by its unit", async () => {
    const settings = api();
    const template = (key) => ({ key, version: 1, titleKey: key, steps: [{ titleKey: "Answers", fields: [] }] });
    const forms = [{ id: "old-a", templateKey: "north_form", templateVersion: 1, status: "draft", unitPinned: true, unitId: "north", unitName: "North filing", answers: {} },
      { id: "old-b", templateKey: "south_form", templateVersion: 1, status: "draft", unitPinned: true, unitId: "south", unitName: "South filing", answers: {} }];
    mount(<FormsView data={{ member, forms, formTemplates: [template("north_form"), template("south_form")] }} unitSettingsApi={settings} />);
    const picker = await screen.findByLabelText("Choose the unit for this work");
    fireEvent.change(picker, { target: { value: "south" } });
    await waitFor(() => expect(settings.load).toHaveBeenLastCalledWith("south"));
    expect(await screen.findByText("North filing")).toBeInTheDocument();
    expect(screen.getByText("South filing")).toBeInTheDocument();
    expect(document.querySelectorAll('.mforms-tile')).toHaveLength(0);
  });
});
