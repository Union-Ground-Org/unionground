import { MemberApiError } from "./memberApiError.js";

// Unit choice belongs to a workflow. Array order never chooses a primary unit.
export function chooseWorkflowUnit(units, selected) {
  if (!Array.isArray(units)) throw new Error("Unit memberships unavailable");
  if (!units.length) return { unitId: null, needsChoice: false };
  if (units.length === 1) return { unitId: units[0].id, needsChoice: false };
  return units.some((unit) => unit.id === selected)
    ? { unitId: selected, needsChoice: false }
    : { unitId: null, needsChoice: true };
}

export function unitSettingChoices(rows, allowed) {
  if (!Array.isArray(allowed)) throw new Error("Unit choices unavailable");
  return rows.filter((row) => allowed.includes(row.key));
}

export function createUnitSettingsApi(client, isCurrent = () => true) {
  if (!client) return null;
  const call = async (send) => {
    const initiating = client.auth?.getSession ? (await client.auth.getSession()).data?.session : null;
    if (client.auth?.getSession && !initiating?.user?.id) throw Object.assign(new Error("Session changed"), { code: "42501" });
    let request = send();
    if (initiating?.access_token && typeof request.setHeader === "function") request = request.setHeader("Authorization", `Bearer ${initiating.access_token}`);
    const { data, error } = await request;
    if (initiating && (await client.auth.getSession()).data?.session?.user?.id !== initiating.user.id) return undefined;
    if (!isCurrent()) return undefined;
    if (error) throw new MemberApiError("Unit settings", { ...error, message: error.message || "unavailable" });
    if (!data || typeof data !== "object") throw new Error("Unit settings unavailable");
    return data;
  };
  return {
    load: async (unit = null, offset = 0) => {
      try {
        const context = await call(() => client.rpc("get_my_unit_settings", { p_unit: unit, ...(offset ? { p_offset: offset } : {}) }));
        // Held on the release calendar: the chapter workflow, with nothing about units shown.
        return context?.released === false ? { legacy: true, units: [], effective: null, canManage: false } : context;
      }
      catch (error) {
        // Deploying the client before this migration must preserve the old
        // chapter workflow. An access refusal or broken installed RPC never
        // falls back; the database's write guards remain authoritative.
        if (error.code === "PGRST202" && error.message.includes("get_my_unit_settings")) return { legacy: true, units: [], effective: null, canManage: false };
        throw error;
      }
    },
    loadEditor: (chapter, unit = null, offset = 0) => call(() => client.rpc("get_unit_settings_workspace", { p_chapter: chapter, p_unit: unit, ...(offset ? { p_offset: offset } : {}) })),
    saveUnit: (chapter, unit, overrides, version, actor) => call(() => client.rpc("save_unit_settings", {
      p_chapter: chapter, p_unit: unit, p_overrides: overrides, p_expected_version: version, p_actor: actor,
    })),
    saveChapter: (chapter, defaults, allowed, version, actor) => call(() => client.rpc("save_chapter_unit_settings", {
      p_chapter: chapter, p_defaults: defaults, p_allowed: allowed, p_expected_version: version, p_actor: actor,
    })),
  };
}
