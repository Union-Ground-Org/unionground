import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { UnitSettingsPanel } from "../src/features/chapterAccess/UnitSettingsPanel.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const units = [{ id: "a", name: "North" }, { id: "b", name: "South" }];
const workspace = (unitId = null, canSetChapter = false) => ({
  actorId: "actor", chapterId: "campaign", units, unitId, canSetChapter, allowed: { forms: true },
  defaults: { workload: [], forms: ["grievance", "fmla_self"], templates: [], capabilities: {} },
  effective: {}, overrides: {}, chapterVersion: 2, unitVersion: 4, audit: [],
});
describe("unit settings editor", () => {
  it.each([["en", "Settings for", "South", "Forms", "Use campaign settings", "Save"], ["es", "Ajustes para", "South", "Formularios", "Usar los ajustes de la campaña", "Guardar"]])("asks a steward of several units, then saves only the selected unit (%s)", async (lang, label, south, forms, inherit, save) => {
    const api = { loadEditor: vi.fn().mockImplementation(async (_chapter, unit) => workspace(unit)), saveUnit: vi.fn().mockResolvedValue(workspace("b")) };
    render(<LanguageProvider lang={lang}><UnitSettingsPanel api={api} chapterId="campaign" /></LanguageProvider>);
    const select = await screen.findByLabelText(label);
    expect(select.value).toBe("");
    expect(screen.queryByRole("button", { name: save })).toBeNull();
    fireEvent.change(select, { target: { value: "b" } });
    const group = await screen.findByRole("group", { name: forms });
    expect(screen.getByLabelText(label).selectedOptions[0].textContent).toBe(south);
    fireEvent.click(within(group).getByLabelText(inherit));
    const choices = within(group).getAllByRole("checkbox");
    fireEvent.click(choices[1]); fireEvent.click(choices[2]);
    fireEvent.click(screen.getByRole("button", { name: save }));
    await waitFor(() => expect(api.saveUnit).toHaveBeenCalledWith("campaign", "b", { forms: [] }, 4, "actor"));
    expect(api.loadEditor).toHaveBeenCalledWith("campaign", "b");
  });
  it("keeps delegation out of the unit steward's form and disables undelegated groups", async () => {
    const api = { loadEditor: vi.fn().mockResolvedValue(workspace("a")), saveUnit: vi.fn() };
    render(<LanguageProvider lang="en"><UnitSettingsPanel api={api} chapterId="campaign" /></LanguageProvider>);
    fireEvent.change(await screen.findByLabelText("Settings for"), { target: { value: "a" } });
    await screen.findByRole("group", { name: "Officer permissions" });
    expect(screen.queryByLabelText("Allow unit committee members to customize these settings")).toBeNull();
    const inherited = within(screen.getByRole("group", { name: "Officer permissions" })).getByLabelText("Use campaign settings");
    expect(inherited.disabled).toBe(true);
  });
  it("discards a previous chapter's late reply", async () => {
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    const api = { loadEditor: vi.fn().mockImplementation((chapter) => chapter === "old" ? first : Promise.resolve({ ...workspace(), units: [{ id: "new", name: "New unit" }] })) };
    const { rerender } = render(<LanguageProvider lang="en"><UnitSettingsPanel api={api} chapterId="old" /></LanguageProvider>);
    rerender(<LanguageProvider lang="en"><UnitSettingsPanel api={api} chapterId="new" /></LanguageProvider>);
    await screen.findByRole("option", { name: "New unit" });
    release(workspace());
    await waitFor(() => expect(screen.queryByRole("option", { name: "North" })).toBeNull());
  });
});

// Record 8435: Save keeps focus while a unit's settings are saved, and a second
// activation in the same tick sends no second save for that unit.
describe("unit settings save while it runs", () => {
  const mountUnit = async () => {
    const api = { loadEditor: vi.fn().mockImplementation(async (_chapter, unit) => workspace(unit)), saveUnit: vi.fn(async () => workspace("b")) };
    render(<LanguageProvider lang="en"><UnitSettingsPanel api={api} chapterId="campaign" /></LanguageProvider>);
    fireEvent.change(await screen.findByLabelText("Settings for"), { target: { value: "b" } });
    const group = await screen.findByRole("group", { name: "Forms" });
    fireEvent.click(within(group).getByLabelText("Use campaign settings"));
    return api;
  };

  it("keeps Save focused while the unit's settings are saved, and saves them once", async () => {
    const api = await mountUnit();
    await expectHeldWriteFocus(api.saveUnit, screen.getByRole("button", { name: "Save" }));
    expect(api.saveUnit).toHaveBeenCalledTimes(1);
  });

  it("saves a unit's settings once when Save is activated twice in one tick", async () => {
    const api = await mountUnit();
    const save = screen.getByRole("button", { name: "Save" });
    await expectOneWriteFromOneTick(api.saveUnit, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });
});
