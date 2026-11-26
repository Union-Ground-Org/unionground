// @vitest-environment node
// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 / REQ-UG-CONFIGURABLE-THRESHOLDS-20261001
import { afterEach, describe, expect, it, vi } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { featureLimit, featureText, featureTextList, isFeatureEnabled } from "../src/lib/featureSwitches.js";
import {
  boundsText, draftFromValue, groupSettings, memberSwitchesFromSettings, organizationConfigurationWithSetting,
  parseTextList, settingCategory, settingLabel, validValue, valueFromDraft,
} from "../src/lib/organizationSettingsAdmin.js";
import {
  deadlineColorThresholds, deadlineColorTier, deadlineLookaheadDays, deadlineRiskSeverity, deadlineRiskThresholds,
  healthBand, healthBandThresholds, managementBehaviorCategories, managementBehaviorWindowDays, managementCategoryMessageKey,
} from "../src/lib/configurableThresholds.js";
import { readOrganizationSettings } from "../api/_lib/organizationSettings.js";
import { t } from "../src/lib/i18n.js";

const member = {
  switches: {
    "features.passkey_enrollment": false,
    "limits.casework.deadline_red_days": 3,
    "lists.casework.management_behavior_categories": ["Intimidation", "Other"],
    "limits.proof.mode": "fast",
  },
};
const admin = {
  settings: [
    { key: "features.passkey_enrollment", kind: "boolean", value: true },
    { key: "limits.casework.deadline_red_days", kind: "integer", value: 9 },
  ],
};

describe("featureSwitches readers", () => {
  it("read the member switches map and the admin settings array", () => {
    expect(isFeatureEnabled(member, "features.passkey_enrollment", true)).toBe(false);
    expect(isFeatureEnabled(admin, "features.passkey_enrollment")).toBe(true);
    expect(featureLimit(member, "limits.casework.deadline_red_days", 5)).toBe(3);
    expect(featureLimit(admin, "limits.casework.deadline_red_days", 5)).toBe(9);
    expect(featureTextList(member, "lists.casework.management_behavior_categories")).toEqual(["Intimidation", "Other"]);
    expect(featureText(member, "limits.proof.mode", "steady")).toBe("fast");
  });

  it("fall back for a missing configuration, a missing key or a wrongly typed value", () => {
    expect(isFeatureEnabled(null, "features.anything")).toBe(false);
    expect(isFeatureEnabled(undefined, "features.anything", true)).toBe(true);
    expect(isFeatureEnabled(member, "features.unknown", true)).toBe(true);
    expect(isFeatureEnabled({ switches: { "features.x": "true" } }, "features.x")).toBe(false);
    expect(featureLimit(member, "limits.unknown", 7)).toBe(7);
    expect(featureLimit({ switches: { "limits.x": 2.5 } }, "limits.x", 1)).toBe(1);
    expect(featureTextList(null, "lists.x")).toEqual([]);
    expect(featureTextList({ switches: { "lists.x": [1] } }, "lists.x", ["a"])).toEqual(["a"]);
    // Own properties only.
    expect(isFeatureEnabled({ switches: {} }, "constructor", false)).toBe(false);
  });

  it("returns copies so a caller cannot mutate the session configuration", () => {
    const list = featureTextList(member, "lists.casework.management_behavior_categories");
    list.push("Mutated");
    expect(member.switches["lists.casework.management_behavior_categories"]).toEqual(["Intimidation", "Other"]);
  });
});

describe("organization settings admin logic", () => {
  const integer = { key: "limits.casework.deadline_red_days", kind: "integer", minimum: 0, maximum: 90 };
  const list = { key: "lists.casework.management_behavior_categories", kind: "text_list", minimum: 1, maximum: 50 };
  const enumItem = { key: "limits.proof.mode", kind: "text", allowedValues: ["steady", "fast"] };

  it("mirrors private.setting_value_valid", () => {
    expect(validValue(integer, 0)).toBe(true);
    expect(validValue(integer, 90)).toBe(true);
    expect(validValue(integer, 91)).toBe(false);
    expect(validValue(integer, 2.5)).toBe(false);
    expect(validValue(integer, Number.NaN)).toBe(false);
    expect(validValue({ kind: "boolean" }, "true")).toBe(false);
    expect(validValue(enumItem, "fast")).toBe(true);
    expect(validValue(enumItem, "slow")).toBe(false);
    expect(validValue(list, ["Intimidation"])).toBe(true);
    expect(validValue(list, [])).toBe(false);
    expect(validValue(list, ["Same", "same"])).toBe(false);
    expect(validValue(list, [" padded"])).toBe(false);
    expect(validValue(list, ["<b>"])).toBe(false);
    expect(validValue(list, ["x".repeat(81)])).toBe(false);
    expect(validValue(list, Array.from({ length: 51 }, (_, index) => `Item ${index}`))).toBe(false);
  });

  it("round-trips drafts for every kind", () => {
    expect(parseTextList(" Intimidation \n\nintimidation\nOther  item ")).toEqual(["Intimidation", "Other item"]);
    expect(valueFromDraft(list, draftFromValue(list, ["A", "B"]))).toEqual(["A", "B"]);
    expect(valueFromDraft(integer, "12")).toBe(12);
    expect(valueFromDraft(integer, "1e3")).toBeNaN();
    expect(valueFromDraft({ kind: "boolean" }, true)).toBe(true);
    expect(draftFromValue(integer, 5)).toBe("5");
  });

  it("groups by the fixed category order and filters by search, category and changed state", () => {
    const settings = [
      { key: "limits.analytics.health_critical_max", category: "analytics", label: "Health score: critical up to", description: "x", overridden: false },
      { key: "security.failed_login_alert_threshold", label: "Failed sign-in attention threshold", description: "y", overridden: true },
      { key: "limits.casework.deadline_red_days", category: "casework", label: "Deadline red threshold (days)", description: "z", overridden: true },
    ];
    const translate = (key) => t("en", key);
    expect(groupSettings(settings, { t: translate }).map((group) => group.category)).toEqual(["security", "casework", "analytics"]);
    expect(groupSettings(settings, { t: translate, query: "deadline" }).map((group) => group.items.map((item) => item.key))).toEqual([["limits.casework.deadline_red_days"]]);
    expect(groupSettings(settings, { t: translate, category: "analytics" })).toHaveLength(1);
    expect(groupSettings(settings, { t: translate, changedOnly: true }).flatMap((group) => group.items).map((item) => item.key))
      .toEqual(["security.failed_login_alert_threshold", "limits.casework.deadline_red_days"]);
    expect(settingCategory({ key: "features.lane.thing", category: "not-a-category" })).toBe("general");
  });

  it("labels settings from the catalogue in both languages and falls back to the database English", () => {
    const item = { key: "limits.casework.deadline_red_days", label: "DB label" };
    expect(settingLabel((key) => t("es", key), item)).toBe("Umbral rojo de plazos (días)");
    expect(settingLabel((key) => t("en", key), { key: "limits.lane.unknown", label: "Lane label" })).toBe("Lane label");
    expect(boundsText((key, vars) => t("en", key, vars), integer)).toBe("Allowed 0–90");
  });

  it("keeps the member session's switches and legacy flags current", () => {
    const next = organizationConfigurationWithSetting({ recoveryCodeEnrollmentEnabled: false, switches: { "features.mfa_recovery_code_enrollment": false, "limits.a": 1 } }, "features.mfa_recovery_code_enrollment", true);
    expect(next).toEqual({ recoveryCodeEnrollmentEnabled: true, switches: { "features.mfa_recovery_code_enrollment": true, "limits.a": 1 } });
    // Union Ground has no passkey sign-in: the stored switch stays current,
    // but no passkey enrollment flag is derived from it.
    const passkey = organizationConfigurationWithSetting({ switches: { "features.passkey_enrollment": true } }, "features.passkey_enrollment", false);
    expect(passkey).toEqual({ switches: { "features.passkey_enrollment": false } });
    expect(passkey).not.toHaveProperty("passkeyEnrollmentEnabled");
    expect(organizationConfigurationWithSetting({ switches: {} }, "security.private", 3)).toEqual({ switches: {} });
    expect(memberSwitchesFromSettings([{ key: "a", value: 1, memberVisible: true }, { key: "b", value: 2, memberVisible: false }])).toEqual({ a: 1 });
  });
});

describe("configurable thresholds", () => {
  it("default to the old app's values", () => {
    expect(deadlineColorThresholds(null)).toEqual({ red: 5, amber: 14 });
    expect(deadlineRiskThresholds(null)).toEqual({ critical: 0, high: 7, medium: 14 });
    expect(deadlineLookaheadDays(null)).toBe(7);
    expect(healthBandThresholds(null)).toEqual({ criticalMax: 24, concerningMax: 44, moderateMax: 64, healthyMax: 84 });
    expect(managementBehaviorCategories(null)).toContain("Weingarten denial");
    expect(managementBehaviorWindowDays(null)).toBe(90);
  });

  it("clamp a misordered configuration monotonic", () => {
    const config = { switches: {
      "limits.casework.deadline_red_days": 20, "limits.casework.deadline_amber_days": 10,
      "limits.casework.deadline_risk_critical_days": 5, "limits.casework.deadline_risk_high_days": 2, "limits.casework.deadline_risk_medium_days": 1,
      "limits.analytics.health_critical_max": 50, "limits.analytics.health_concerning_max": 40,
    } };
    expect(deadlineColorThresholds(config)).toEqual({ red: 20, amber: 20 });
    expect(deadlineRiskThresholds(config)).toEqual({ critical: 5, high: 5, medium: 5 });
    expect(healthBandThresholds(config)).toMatchObject({ criticalMax: 50, concerningMax: 50, moderateMax: 64 });
  });

  it("grade deadlines and scores like the old tierFor / deadlineRiskSeverity / score dial", () => {
    expect([-1, 0, 5, 6, 14, 15].map((days) => deadlineColorTier(days))).toEqual(["overdue", "red", "red", "amber", "amber", "green"]);
    expect([-3, 0, 1, 7, 8, 14, 15].map((days) => deadlineRiskSeverity(days))).toEqual(["critical", "critical", "high", "high", "medium", "medium", "low"]);
    expect([0, 24, 25, 44, 45, 64, 65, 84, 85, 100].map((score) => healthBand(score))).toEqual([
      "critical", "critical", "concerning", "concerning", "moderate", "moderate", "healthy", "healthy", "excellent", "excellent",
    ]);
    expect(healthBand(null)).toBe("not_ready");
  });

  it("derives catalogue keys for categories and translates the defaults", () => {
    expect(managementCategoryMessageKey("Policy change (unilateral)")).toBe("casework.tools.category.policy_change_unilateral");
    for (const category of managementBehaviorCategories(null)) {
      const key = managementCategoryMessageKey(category);
      expect(t("en", key), category).not.toBe(key);
      expect(t("es", key), category).not.toBe(key);
    }
  });
});

describe("api readOrganizationSettings", () => {
  afterEach(() => vi.unstubAllGlobals());
  const backend = { url: "https://example.supabase.co", serviceRoleKey: "service-secret" };
  const org = "50000000-0000-4000-8000-000000000001";

  it("calls the service-role RPC with the exact keys and returns the effective values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ "features.a": true, "limits.b": 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readOrganizationSettings(backend, org, ["features.a", "limits.b", "features.a"])).resolves.toEqual({ "features.a": true, "limits.b": 3 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.supabase.co/rest/v1/rpc/get_organization_settings_for_service");
    expect(JSON.parse(init.body)).toEqual({ p_organization_id: org, p_keys: ["features.a", "limits.b"] });
    expect(init.headers.apikey).toBe("service-secret");
  });

  it("refuses bad input before the network and a malformed answer after it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ "features.a": true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readOrganizationSettings({}, org, ["features.a"])).rejects.toThrow("organization-settings-backend-unavailable");
    await expect(readOrganizationSettings(backend, "not-a-uuid", ["features.a"])).rejects.toThrow("organization-settings-invalid-organization");
    await expect(readOrganizationSettings(backend, org, [])).rejects.toThrow("organization-settings-invalid-keys");
    await expect(readOrganizationSettings(backend, org, ["Bad Key"])).rejects.toThrow("organization-settings-invalid-keys");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readOrganizationSettings(backend, org, ["features.a", "limits.missing"])).rejects.toThrow("organization-settings-malformed");
  });
});
