import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDemoCaseworkApi } from "../src/lib/demoCaseworkApi.js";

function setup() {
  const desk = { cases: [{ id: "case-1", chapterId: "ch-1", caseType: "Discipline", status: "active", deadline: "2026-09-18" }] };
  return { desk, api: createDemoCaseworkApi(async () => desk) };
}

describe("coordinator fixture casework parity", () => {
  // Union Ground issues have no grievance procedure, step advancement,
  // stage checklists or member procedural progress (owner decision,
  // 2026-10-13); the fixture must not offer any of them either.
  it("offers no procedure, step, holiday, checklist or member-progress command", () => {
    const { api } = setup();
    for (const name of [
      "listProcedures", "getCaseProcedure", "saveProcedure", "setHolidays", "getStarterProcedure", "loadStarterProcedure",
      "advanceCaseStep", "advanceCaseworkStep", "setChecklistItem", "loadMemberCasework",
    ]) expect(api, name).not.toHaveProperty(name);
  });

  it("opens an issue workspace without transitions or checklists and seeds its follow-up clock", async () => {
    const { api } = setup();
    const state = await api.loadCaseworkCase("case-1");
    expect(state).not.toHaveProperty("transitions");
    expect(state).not.toHaveProperty("checklists");
    expect(state.scope).toMatchObject({ id: "case-1", chapter_id: "ch-1", case_type: "Discipline", status: "active", is_restricted: false });
    expect(state.scope).not.toHaveProperty("step");
    expect(state.deadlines).toEqual([expect.objectContaining({ kind: "follow_up", due_at: "2026-09-18", status: "active", extensions: [] })]);
    // The returned workspace is a copy; the fixture keeps its own state.
    state.deadlines[0].due_at = "untrusted";
    expect((await api.loadCaseworkCase("case-1")).deadlines[0].due_at).toBe("2026-09-18");
    await expect(api.loadCaseworkCase("missing")).rejects.toThrow();
  });

  it("persists deadlines, extension decisions and alerts", async () => {
    const { api } = setup();
    const state = await api.loadCaseworkCase("case-1");
    const deadline = await api.createCaseDeadline(state.scope, { kind: "response", label: "Response", dueAt: "2026-09-24" });
    expect(deadline.status).toBe("active");
    const extension = await api.requestDeadlineExtension(deadline.id, "2026-09-28", "More time");
    await api.decideDeadlineExtension(extension.id, "approved", "Agreed");
    await expect(api.decideDeadlineExtension(extension.id, "denied", "Again")).rejects.toThrow();
    const alert = await api.createCaseAlert(state.scope, { kind: "deadline", severity: "high", message: "Due soon" });
    await api.acknowledgeAlert(alert.id);
    const updated = await api.loadCaseworkCase("case-1");
    expect(updated.deadlines.find((row) => row.id === deadline.id).due_at).toBe("2026-09-28");
    expect(updated.alerts[0].status).toBe("acknowledged");
  });

  it("bulk-updates status only and refuses a step change or a stale status", async () => {
    const { api, desk } = setup();
    await expect(api.bulkUpdateCases(["case-1"], "active", { step: "bypass" })).rejects.toThrow();
    expect(desk.cases[0]).not.toHaveProperty("step");
    await expect(api.bulkUpdateCases(["case-1"], "resolved", { status: "closed" })).rejects.toThrow();
    await api.bulkUpdateCases(["case-1"], "active", { status: "resolved" });
    expect(desk.cases[0].status).toBe("resolved");
  });

  it("wires production and fixture coordinator operations without any step or procedure route", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    const live = source.slice(source.indexOf("const coordinatorApi ="), source.indexOf("const demoCoordinatorApi ="));
    for (const method of ["loadCaseworkCase", "createCaseDeadline", "requestDeadlineExtension", "decideDeadlineExtension", "createCaseAlert", "acknowledgeAlert", "bulkUpdateCases"]) expect(live).toContain(`${method}:`);
    for (const method of ["advanceCaseStep", "setChecklistItem", "getCaseProcedure", "listProcedures", "saveProcedure", "setHolidays"]) expect(live).not.toContain(`${method}:`);
    const demo = source.slice(source.indexOf("const demoCoordinatorApi ="), source.indexOf("const demoVpApi ="));
    expect(demo).toContain("...createDemoCaseworkApi(current, { lang: () => demoCaseworkLangRef.current })");
    expect(demo).not.toContain("step: fields.step");
    // Workers on the web read no procedural progress, live or in the fixture.
    expect(source).not.toContain("demoMemberCaseworkApi");
    expect(source).not.toContain("loadMemberCasework");
    expect(source).toContain("caseworkApi={demoActive ? null : memberCaseworkApi}");
  });
});
