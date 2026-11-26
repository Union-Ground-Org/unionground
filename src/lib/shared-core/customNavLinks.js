// Admin-set custom navigation links (REQ-UG-CUSTOM-NAV-LINKS-20261001).
//
// Old app: supabase/migrations/0036_custom_links_config.sql and
// lib/settings/settings-keys.ts:265-301 (getCustomLinks, sanitizeCustomLinkUrl):
// two links, each shown only when both its label and its address are set and
// the address is safe. The organization settings are member-visible text
// values (get_member_organization_configuration().switches); the database
// refuses any address that is not https:// (organization_setting_values_
// custom_nav_links), and this module refuses it again before rendering, so a
// javascript:, data: or http: address can never become a link.
import { featureText } from "./featureSwitches.js";

export const CUSTOM_NAV_LINK_SLOTS = Object.freeze([
  Object.freeze({ slot: 1, labelKey: "text.navigation.custom_link_1_label", urlKey: "text.navigation.custom_link_1_url" }),
  Object.freeze({ slot: 2, labelKey: "text.navigation.custom_link_2_label", urlKey: "text.navigation.custom_link_2_url" }),
]);

export const CUSTOM_NAV_LINK_URL_KEYS = Object.freeze(CUSTOM_NAV_LINK_SLOTS.map((slot) => slot.urlKey));
export const CUSTOM_NAV_LINK_LABEL_KEYS = Object.freeze(CUSTOM_NAV_LINK_SLOTS.map((slot) => slot.labelKey));
export const CUSTOM_NAV_LINK_LABEL_MAX = 40;
export const CUSTOM_NAV_LINK_URL_MAX = 240;

// The same shape the database CHECK accepts: https://, a host name, an
// optional port, then an optional path, query or fragment without spaces,
// control characters, quotes, backslashes, backticks or angle brackets.
const URL_SHAPE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?([/?#][^\s\p{Cc}<>"'\\`]*)?$/u;

export function isAllowedCustomLinkUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > CUSTOM_NAV_LINK_URL_MAX) return false;
  if (!URL_SHAPE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isValidCustomLinkLabel(value) {
  return typeof value === "string"
    && [...value].length <= CUSTOM_NAV_LINK_LABEL_MAX
    && value === value.trim()
    && !/[\p{Cc}<>]/u.test(value);
}

// Admin-page check for one of the four settings; any other key passes.
export function customNavLinkSettingValid(key, value) {
  if (CUSTOM_NAV_LINK_URL_KEYS.includes(key)) return value === "" || isAllowedCustomLinkUrl(value);
  if (CUSTOM_NAV_LINK_LABEL_KEYS.includes(key)) return isValidCustomLinkLabel(value);
  return true;
}

// The links to render: a slot shows only with a label and an allowed address.
export function customNavLinks(configuration) {
  const links = [];
  for (const { slot, labelKey, urlKey } of CUSTOM_NAV_LINK_SLOTS) {
    const label = featureText(configuration, labelKey, "").trim();
    const url = featureText(configuration, urlKey, "").trim();
    if (label && isValidCustomLinkLabel(label) && isAllowedCustomLinkUrl(url)) {
      links.push({ key: `custom-link-${slot}`, label, url });
    }
  }
  return links;
}

// Display the actual destination host before opening a custom link.
export function customLinkHost(url) {
  try { return new URL(url).host; } catch { return ""; }
}
