// Admin-page logic for the grouped "Feature switches & limits" page
// (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001). Pure helpers so the
// component, the SAMPLE demo desk and the tests share one set of rules. The
// database (private.setting_value_valid) stays the authority; validValue()
// mirrors it so the page can explain a bad value before the round trip.
import { customNavLinkSettingValid } from "./customNavLinks.js";

export const SETTING_CATEGORIES = Object.freeze([
  "general", "security", "engagement_voice", "guidance_onboarding", "home",
  "casework", "intelligence", "automation", "messaging", "governance",
  "integrations", "ai_assistant", "notifications", "data_retention",
  "analytics", "labels",
]);

export const TEXT_LIST_MAX_ITEMS = 50;
export const TEXT_LIST_ITEM_MAX = 80;

// Switches and limits the inert database still registers for
// features that Union Ground leaves out (passkey, PIN and SSO sign-in, the
// dues reminder job and its delay, ULP deadlines, grievance procedures, the
// membership card's Google Wallet pass). The admin page never offers them: a
// control for a feature the product does not have would only mislead.
export const LEFT_OUT_SETTING_KEYS = Object.freeze(new Set([
  "features.passkey_enrollment",
  "features.home.passkey_nudge",
  "features.security.member_pin_restricted_sessions",
  "features.security.member_pin_signin",
  "features.security.sso",
  "features.notifications.dues_reminders",
  "limits.notifications.dues_reminder_days_past_due",
  "features.casework.ulp_deadline",
  "features.casework.starter_procedure_template",
  "features.integrations.google_wallet_pass",
]));

export function isLeftOutSetting(item) {
  const key = String(item?.key ?? "");
  return LEFT_OUT_SETTING_KEYS.has(key) || key.startsWith("casework.ulp.");
}

export function settingCategory(item) {
  if (SETTING_CATEGORIES.includes(item?.category)) return item.category;
  return String(item?.key ?? "").startsWith("security.") || item?.key === "features.mfa_recovery_code_enrollment"
    ? "security"
    : "general";
}

// A setting that only acts beside a switch, by the switch it acts beside. The
// admin list leaves a switch out while it is held for its release day
// (docs/contracts/staged-feature-releases.md), so a row listed here leaves with
// it. Only the list changes: the row's own value and every server read of it
// stay as they are. Restricted PIN sessions is never held itself, because held
// it would read off and lift the restriction from live PIN sessions, and only
// a boolean can be held (BUG-UG-HELD-MEMBER-PIN-STILL-SHOWS-20261112).
// The SCIM invitations a day limit is read by private.scim_reconcile_user. A
// SCIM request reaches it only after public.scim_authenticate lets it through;
// public.set_scim_group_role also calls it, with no token hash, and that call
// cannot create an invitation. So the limit acts only beside directory sync
// (#9037).
export const SETTING_LISTED_WITH = Object.freeze({
  "features.security.member_pin_restricted_sessions": "features.security.member_pin_signin",
  "limits.security.member_pin_lockout_attempts": "features.security.member_pin_signin",
  "limits.security.member_pin_lockout_minutes": "features.security.member_pin_signin",
  "limits.integrations.scim_invitations_per_day": "features.integrations.scim",
});

// The rows the page lists: every row the server listed, less a row whose
// companion switch the server left out.
export function listedSettings(settings) {
  const rows = Array.isArray(settings) ? settings : [];
  const keys = new Set(rows.map((item) => item?.key));
  return rows.filter((item) => !Object.hasOwn(SETTING_LISTED_WITH, item?.key) || keys.has(SETTING_LISTED_WITH[item.key]));
}

// A text list whose every entry must come from a fixed set of values.
export function isChoiceList(item) {
  return item?.kind === "text_list" && Array.isArray(item.allowedValues) && item.allowedValues.length > 0;
}

export function isEnum(item) {
  return item?.kind === "text" && Array.isArray(item.allowedValues) && item.allowedValues.length > 0;
}

// Catalogue copy keyed by setting key, falling back to the database English.
function catalogueOr(t, key, fallback) {
  const value = t(key);
  return typeof value === "string" && value !== key ? value : fallback;
}

export function settingLabel(t, item) {
  return catalogueOr(t, `settings.def.${item.key}.label`, item.label || item.key);
}

export function settingDescription(t, item) {
  return catalogueOr(t, `settings.def.${item.key}.description`, item.description || "");
}

export function enumOptionLabel(t, item, option) {
  return catalogueOr(t, `settings.def.${item.key}.option.${option}`, option);
}

export function categoryLabel(t, category) {
  return catalogueOr(t, `settings.category.${category}`, category.replaceAll("_", " "));
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

export function groupSettings(settings, { t, query = "", category = "", changedOnly = false } = {}) {
  const needle = normalizedText(query).trim();
  const groups = new Map(SETTING_CATEGORIES.map((name) => [name, []]));
  for (const item of Array.isArray(settings) ? settings : []) {
    if (!item || typeof item.key !== "string" || isLeftOutSetting(item)) continue;
    const group = settingCategory(item);
    if (category && group !== category) continue;
    if (changedOnly && !item.overridden) continue;
    if (needle) {
      const haystack = normalizedText([
        item.key, item.label, item.description,
        t ? settingLabel(t, item) : "", t ? settingDescription(t, item) : "",
        t ? categoryLabel(t, group) : group,
      ].join(" "));
      if (!haystack.includes(needle)) continue;
    }
    groups.get(group).push(item);
  }
  return [...groups.entries()].filter(([, items]) => items.length > 0).map(([name, items]) => ({ category: name, items }));
}

export function validValue(item, value) {
  if (!item) return false;
  switch (item.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value)
        && (item.minimum == null || value >= item.minimum)
        && (item.maximum == null || value <= item.maximum);
    case "text":
      return typeof value === "string"
        && value.length <= 240
        && !/\p{Cc}/u.test(value)
        && (!Array.isArray(item.allowedValues) || item.allowedValues.includes(value))
        // REQ-UG-CUSTOM-NAV-LINKS-20261001: https:// addresses and short
        // labels only, as organization_setting_values_custom_nav_links checks.
        && customNavLinkSettingValid(item.key, value);
    case "text_list": {
      if (!Array.isArray(value)) return false;
      const max = Math.min(item.maximum ?? TEXT_LIST_MAX_ITEMS, TEXT_LIST_MAX_ITEMS);
      if (value.length < (item.minimum ?? 0) || value.length > max) return false;
      const seen = new Set();
      for (const entry of value) {
        if (typeof entry !== "string" || entry.length < 1 || [...entry].length > TEXT_LIST_ITEM_MAX) return false;
        if (entry !== entry.trim() || /[\p{Cc}<>]/u.test(entry)) return false;
        if (Array.isArray(item.allowedValues) && !item.allowedValues.includes(entry)) return false;
        const folded = entry.toLowerCase();
        if (seen.has(folded)) return false;
        seen.add(folded);
      }
      return true;
    }
    default:
      return false;
  }
}

// One text-list item per line: trimmed, blank lines dropped, case-insensitive
// duplicates folded to their first spelling.
export function parseTextList(text) {
  const seen = new Set();
  const items = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const entry = line.trim().replace(/\s+/gu, " ");
    if (!entry) continue;
    const folded = entry.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    items.push(entry);
  }
  return items;
}

export function draftFromValue(item, value) {
  if (item?.kind === "boolean") return value === true;
  if (item?.kind === "text_list") return Array.isArray(value) ? value.join("\n") : "";
  if (value == null) return "";
  return String(value);
}

export function valueFromDraft(item, draft) {
  if (item?.kind === "boolean") return draft === true;
  if (item?.kind === "integer") {
    const text = String(draft ?? "").trim();
    return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  }
  if (item?.kind === "text_list") return parseTextList(draft);
  return String(draft ?? "");
}

export function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function formatSettingValue(t, item, value) {
  if (value == null) return "—";
  if (item?.kind === "boolean" || typeof value === "boolean") return value ? t("admin.config.on") : t("admin.config.off");
  if (Array.isArray(value)) {
    if (!isChoiceList(item)) return value.join(", ");
    return value.length ? value.map((entry) => enumOptionLabel(t, item, String(entry))).join(", ") : "—";
  }
  if (isEnum(item)) return enumOptionLabel(t, item, String(value));
  return String(value);
}

export function boundsText(t, item) {
  if (item?.kind === "integer") {
    if (item.minimum != null && item.maximum != null) return t("admin.config.range", { min: item.minimum, max: item.maximum });
    if (item.minimum != null) return t("admin.config.min", { min: item.minimum });
    if (item.maximum != null) return t("admin.config.max", { max: item.maximum });
  }
  if (item?.kind === "text_list") {
    return t("admin.config.listBounds", {
      min: item.minimum ?? 0,
      max: Math.min(item.maximum ?? TEXT_LIST_MAX_ITEMS, TEXT_LIST_MAX_ITEMS),
      chars: TEXT_LIST_ITEM_MAX,
    });
  }
  return "";
}

// Keeps the signed-in session's member-safe configuration current after an
// admin save or reset: the switches map, plus the legacy member field the
// recovery-code screen still reads.
export function organizationConfigurationWithSetting(configuration, key, value) {
  const base = configuration ?? {};
  const next = { ...base };
  if (base.switches && typeof base.switches === "object" && Object.hasOwn(base.switches, key)) {
    next.switches = { ...base.switches, [key]: value };
  }
  if (key === "features.mfa_recovery_code_enrollment") next.recoveryCodeEnrollmentEnabled = value === true;
  return next;
}

// The member-safe switches map recomputed from an admin settings array, for
// the SAMPLE desk and for keeping the signed-in session current after a save.
export function memberSwitchesFromSettings(settings) {
  const switches = {};
  for (const item of Array.isArray(settings) ? settings : []) {
    if (item?.memberVisible === true && typeof item.key === "string") switches[item.key] = item.value;
  }
  return switches;
}

// The member session loader's cached read of the member-safe organization
// configuration (get_member_organization_configuration), labels included.
export const MEMBER_ORGANIZATION_CONFIGURATION_RESOURCE = "rpc:get_member_organization_configuration";

// The admin plane's label save. The page follows the saved name at once, and
// the cached configuration read is dropped, so the next page load fetches the
// saved name instead of rebuilding the shell from the copy read before the
// save (REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103,
// gate finding r3s1). A save that answers after the session or scope changed
// leaves both alone.
export function liveOrganizationLabelApi({ save, guardRef, loaderRef, setData }) {
  return {
    updateOrganizationLabel: async (key, value) => {
      const operation = guardRef.current.captureOperation();
      const result = await save(key, value);
      if (!operation.isCurrent()) return undefined;
      loaderRef.current?.invalidateResources([MEMBER_ORGANIZATION_CONFIGURATION_RESOURCE]);
      setData((current) => {
        if (!current) return current;
        const labelOverrides = { ...(current.organizationConfiguration?.labelOverrides ?? {}) };
        if (result?.removed || result?.value == null) delete labelOverrides[key];
        else labelOverrides[key] = result.value;
        return {
          ...current,
          organizationConfiguration: {
            ...(current.organizationConfiguration ?? {}),
            labelOverrides,
          },
        };
      });
      return result;
    },
  };
}
