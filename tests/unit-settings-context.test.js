import { describe, expect, it, vi } from "vitest";
import { chooseWorkflowUnit, createUnitSettingsApi, unitSettingChoices } from "../src/lib/unitSettings.js";

describe("a unit is chosen for this workflow", () => {
  const units = [{ id: "a", name: "North" }, { id: "b", name: "South" }];
  it("uses chapter defaults without membership and the only unit without a prompt", () => {
    expect(chooseWorkflowUnit([], null)).toEqual({ unitId: null, needsChoice: false });
    expect(chooseWorkflowUnit([units[0]], null)).toEqual({ unitId: "a", needsChoice: false });
  });
  it("never picks a primary unit or merges memberships, in either ordering", () => {
    for (const rows of [units, [...units].reverse()]) {
      expect(chooseWorkflowUnit(rows, null)).toEqual({ unitId: null, needsChoice: true });
      expect(chooseWorkflowUnit(rows, "b")).toEqual({ unitId: "b", needsChoice: false });
      expect(chooseWorkflowUnit(rows, "revoked")).toEqual({ unitId: null, needsChoice: true });
    }
  });
  it("filters only new choices and leaves records across units alone", () => {
    const choices = [{ key: "grievance" }, { key: "leave" }];
    expect(unitSettingChoices(choices, ["leave"])).toEqual([choices[1]]);
    expect(unitSettingChoices(choices, [])).toEqual([]);
    expect(() => unitSettingChoices(choices, null)).toThrow();
  });
  it("sends the exact unit and optimistic version, and surfaces a live refusal", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { chapterId: "chapter", units, effective: null }, error: null }) };
    const api = createUnitSettingsApi(client);
    await api.load("b");
    expect(client.rpc).toHaveBeenLastCalledWith("get_my_unit_settings", { p_unit: "b" });
    await api.saveUnit("chapter", "b", { forms: [] }, 3, "actor");
    expect(client.rpc).toHaveBeenLastCalledWith("save_unit_settings", { p_chapter: "chapter", p_unit: "b", p_overrides: { forms: [] }, p_expected_version: 3, p_actor: "actor" });
    client.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "unit membership changed" } });
    await expect(api.load("b")).rejects.toMatchObject({ code: "42501" });
  });
  it("freezes the initiating token and suppresses a completed previous account read", async () => {
    let account = "actor", release;
    const pending = new Promise((resolve) => { release = resolve; });
    const setHeader = vi.fn().mockReturnValue(pending);
    const client = { auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: account }, access_token: `${account}-token` } } })) }, rpc: vi.fn(() => ({ setHeader })) };
    const request = createUnitSettingsApi(client).load("a");
    await vi.waitFor(() => expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer actor-token"));
    account = "other"; release({ data: { chapterId: "old", units }, error: null });
    expect(await request).toBeUndefined();
  });
  it("treats a held feature exactly like the missing migration: the chapter workflow, nothing about units", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { released: false }, error: null }) };
    expect(await createUnitSettingsApi(client).load()).toEqual({ legacy: true, units: [], effective: null, canManage: false });
  });
  it("falls back only for the named missing migration and passes the picker page explicitly", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "get_my_unit_settings absent" } }) };
    const api = createUnitSettingsApi(client);
    expect(await api.load()).toMatchObject({ legacy: true });
    client.rpc.mockResolvedValue({ data: { units }, error: null });
    await api.load(null, 30);
    expect(client.rpc).toHaveBeenLastCalledWith("get_my_unit_settings", { p_unit: null, p_offset: 30 });
    client.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "different_rpc absent" } });
    await expect(api.load()).rejects.toMatchObject({ code: "PGRST202" });
  });
});
