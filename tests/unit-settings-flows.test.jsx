// REQ-UG-PER-UNIT-SETTINGS-20261109 (#7667): the editor paths a chapter
// lead and a unit steward take, the workflow unit choice's retry and paging,
// and workload history labelled by unit.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { UnitSettingsPanel } from "../src/features/chapterAccess/UnitSettingsPanel.jsx";
import { UnitWorkflowChoice, useUnitWorkflow } from "../src/features/chapterAccess/UnitWorkflowChoice.jsx";
import { WorkloadConfiguredHistory } from "../src/components/WorkloadConfiguredHistory.jsx";

const mount = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
const units = [{ id: "a", name: "North" }, { id: "b", name: "South" }];
const categories = [
  { key: "priority", label: "workload.cat.priority", visible: true },
  { key: "pending", label: "Pending custom", visible: true },
];
function leadWorkspace(overrides = {}) {
  return {
    actorId: "lead", chapterId: "chapter", units, unitCount: 2, nextUnitOffset: null, unitId: null, unitName: null, canSetChapter: true,
    allowed: { forms: true }, chapterOverrides: {},
    organizationDefaults: { workload: categories, forms: ["grievance"], templates: ["issue_incident", "member_follow_up"], capabilities: { "secretary:records": true } },
    defaults: { workload: categories, forms: ["grievance"], templates: ["issue_incident", "member_follow_up"], capabilities: { "secretary:records": true } },
    effective: {}, overrides: {}, chapterVersion: 3, unitVersion: 0,
    formChoices: [{ key: "grievance", labelEn: "Grievance intake", labelEs: "Queja" }],
    templateChoices: [{ key: "issue_incident", labelEn: "Issue or incident", labelEs: "Asunto" }],
    audit: [{ id: "a1", unit_name: "North", created_at: "2026-11-12T15:00:00Z" }, { id: "a2", unit_name: null, created_at: "2026-11-12T16:00:00Z" }],
    ...overrides,
  };
}

describe("unit settings editor: chapter lead", () => {

  it("reports a refused save without losing the edit, and pages through many units", async () => {
    const api = {
      loadEditor: vi.fn().mockImplementation(async (_chapter, _unit, offset = 0) => leadWorkspace({ nextUnitOffset: offset ? null : 30, units: offset ? [{ id: "z", name: "Zeta" }] : units })),
      saveChapter: vi.fn().mockRejectedValue(Object.assign(new Error("changed"), { code: "PT409" })),
    };
    mount(<UnitSettingsPanel api={api} chapterId="chapter" />);
    const forms = await screen.findByRole("group", { name: "Forms" });
    fireEvent.click(within(forms).getByRole("checkbox", { name: /Grievance intake/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings or access may have changed");
    fireEvent.click(screen.getByRole("button", { name: "Next units" }));
    await screen.findByRole("option", { name: "Zeta" });
    expect(api.loadEditor).toHaveBeenLastCalledWith("chapter", null, 30);
    fireEvent.click(screen.getByRole("button", { name: "Previous units" }));
    await screen.findByRole("option", { name: "North" });
    expect(api.loadEditor).toHaveBeenLastCalledWith("chapter", null);
  });
});

describe("unit settings editor: loading and access", () => {
  it("offers a retry after a failed load, and stays hidden for someone without editor access", async () => {
    const api = { loadEditor: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(leadWorkspace()) };
    const view = mount(<UnitSettingsPanel api={api} chapterId="chapter" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unit settings could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: "Workload categories" });
    view.unmount();
    const refused = { loadEditor: vi.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "42501" })) };
    const hidden = mount(<UnitSettingsPanel api={refused} chapterId="chapter" />);
    await waitFor(() => expect(refused.loadEditor).toHaveBeenCalled());
    await waitFor(() => expect(hidden.container).toBeEmptyDOMElement());
  });

});

describe("workflow unit choice", () => {
  it("retries a failed load and pages through a member's units", async () => {
    const context = (offset) => ({ actorId: "actor", chapterId: "chapter", organizationId: "org", unitCount: 31, needsChoice: true, unitId: null,
      units: offset ? [{ id: "z", name: "Zeta" }] : units, nextUnitOffset: offset ? null : 30, effective: null });
    const api = { load: vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(async (_unit, offset = 0) => context(offset)) };
    function Host() {
      const workflow = useUnitWorkflow(api, "actor:chapter:org", { id: "actor", chapterId: "chapter", organizationId: "org" });
      return <UnitWorkflowChoice workflow={workflow} />;
    }
    mount(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("option", { name: "North" });
    fireEvent.click(screen.getByRole("button", { name: "Next units" }));
    await screen.findByRole("option", { name: "Zeta" });
    expect(api.load).toHaveBeenLastCalledWith(null, 30);
    fireEvent.click(screen.getByRole("button", { name: "Previous units" }));
    await screen.findByRole("option", { name: "North" });
    expect(api.load).toHaveBeenLastCalledWith(null);
  });

  it("keeps a chosen unit that is on another page and names it", async () => {
    const api = { load: vi.fn().mockResolvedValue({ actorId: "actor", chapterId: "chapter", organizationId: "org", unitCount: 40, needsChoice: false,
      unitId: "far", unitName: "Far unit", units, nextUnitOffset: 30, effective: { forms: [] } }) };
    function Host() {
      const workflow = useUnitWorkflow(api, "actor:chapter:org", { id: "actor", chapterId: "chapter", organizationId: "org" });
      return <UnitWorkflowChoice workflow={workflow} />;
    }
    mount(<Host />);
    expect(await screen.findByRole("option", { name: "Far unit" })).toBeInTheDocument();
    expect(screen.getAllByText("Far unit").length).toBeGreaterThan(1);
  });
});

describe("workload history by unit", () => {
  const definition = { title: "Unit report", period: "week", statuses: ["logged"], fields: [
    { key: "cases", label: "Cases", type: "number", kind: "category", required: false, visible: true, retired: false, summary: "sum", options: [], unit: "cases" },
  ] };
  const entry = (id, snapshot, extra = {}) => ({ id, createdAt: "2026-11-09T12:00:00Z", dateLabel: "Nov 9", status: "logged", receipt: id, values: { cases: 2 },
    configurationSnapshot: { version: 1, organizationId: "org", definition, ...snapshot }, ...extra });

  it("labels each entry and summary by its unit, nothing for one without, and edits an old unbound entry under the chosen unit", async () => {
    const entries = [entry("bound", { unitId: "north", unitName: "North", settingsRevision: "north-1" }), entry("old", {})];
    const unitContext = { actorId: "actor", chapterId: "chapter", unitId: "south", effective: { configuration: { organizationId: "org", settingsRevision: "south-1" } } };
    const view = mount(<WorkloadConfiguredHistory entries={entries} onSave={vi.fn()} unitContext={null} requireUnitContext />);
    expect(screen.getAllByText("North").length).toBeGreaterThan(0);
    expect(screen.queryByText("Chapter settings")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit entry" }).every((button) => button.disabled)).toBe(true);
    view.rerender(<LanguageProvider lang="en"><WorkloadConfiguredHistory entries={entries} onSave={vi.fn()} unitContext={unitContext} requireUnitContext /></LanguageProvider>);
    const [boundEdit, oldEdit] = screen.getAllByRole("button", { name: "Edit entry" });
    fireEvent.click(oldEdit);
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(boundEdit);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("saves a unit-bound entry through the ordinary save while there is no unit context (held; gate stage 184 r3s4)", async () => {
    const onSave = vi.fn().mockResolvedValue({ updated: true });
    mount(<WorkloadConfiguredHistory entries={[entry("bound", { unitId: "north", unitName: "North", settingsRevision: "north-1" })]} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit entry" }));
    const form = (await screen.findByRole("button", { name: "Cancel" })).closest("form");
    await act(async () => { fireEvent.submit(form); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(onSave.mock.calls[0][0], "unitId")).toBe(false);
    expect(onSave.mock.calls[0][0]).toMatchObject({ entryId: "bound", organizationId: "org" });
  });

  it("edits an old entry under the unit its row was stamped with, not the unit chosen now (ledger 231)", async () => {
    const unitContext = { actorId: "actor", chapterId: "chapter", unitId: "south", effective: { configuration: { organizationId: "org", settingsRevision: "south-1" } } };
    const onSave = vi.fn().mockResolvedValue({ updated: true });
    // Snapshots from before units carry no unit; their rows were stamped on a
    // first edit, one for North and one for the chapter itself.
    const entries = [entry("north-row", {}, { unitId: "north", unitName: "North", unitPinned: true }), entry("chapter-row", {}, { unitId: null, unitPinned: true })];
    mount(<WorkloadConfiguredHistory entries={entries} onSave={onSave} unitContext={unitContext} requireUnitContext />);
    for (const index of [0, 1]) {
      fireEvent.click(screen.getAllByRole("button", { name: "Edit entry" })[index]);
      const form = (await screen.findByRole("button", { name: "Cancel" })).closest("form");
      await act(async () => { fireEvent.submit(form); });
    }
    expect(onSave.mock.calls.map(([payload]) => payload.entryId)).toEqual(["north-row", "chapter-row"]);
    expect(onSave.mock.calls[0][0]).toMatchObject({ organizationId: "org", unitId: "north" });
    // A row bound to the chapter itself keeps that binding through
    // the ordinary save (no unitId), because the unit save would read a null
    // unit as the member's current one and be refused; the database proof is
    // in tests/unit-settings-db.test.js.
    expect(Object.hasOwn(onSave.mock.calls[1][0], "unitId")).toBe(false);
    expect(onSave.mock.calls[1][0]).toMatchObject({ organizationId: "org" });
  });

  // A snapshot that itself carries unitId null (bound to
  // the chapter when it was saved) takes the same ordinary save as a stamp
  // that names no unit. Main already does this; the case pins it.
  it("saves an entry whose snapshot carries unitId null through the ordinary save, even with a unit chosen now", async () => {
    const unitContext = { actorId: "actor", chapterId: "chapter", unitId: "south", effective: { configuration: { organizationId: "org", settingsRevision: "south-1" } } };
    const onSave = vi.fn().mockResolvedValue({ updated: true });
    mount(<WorkloadConfiguredHistory entries={[entry("chapter-snapshot", { unitId: null, unitName: null })]} onSave={onSave} unitContext={unitContext} requireUnitContext />);
    fireEvent.click(screen.getByRole("button", { name: "Edit entry" }));
    const form = (await screen.findByRole("button", { name: "Cancel" })).closest("form");
    await act(async () => { fireEvent.submit(form); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(onSave.mock.calls[0][0], "unitId")).toBe(false);
    expect(onSave.mock.calls[0][0]).toMatchObject({ entryId: "chapter-snapshot", organizationId: "org" });
  });

  it("edits without a unit context when none is required", async () => {
    mount(<WorkloadConfiguredHistory entries={[entry("plain", {})]} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit entry" }));
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
