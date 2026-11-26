// Organization feature switches and limits (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001).
//
// One reader for both organization configuration shapes:
//   - the member-safe read, get_member_organization_configuration():
//     { switches: { "<key>": value } } holding every member_visible definition;
//   - the admin read, get_admin_organization_configuration():
//     { settings: [{ key, value, ... }] } holding every definition.
// The server enforces each switch; these helpers only let the UI show or hide
// a feature honestly. A missing configuration (failed read, signed-out preview)
// or a key the server did not return yields the caller's fallback, which should
// be the definition default the caller registered.

function switchMap(configuration) {
  if (!configuration || typeof configuration !== "object") return null;
  const { switches, settings } = configuration;
  if (switches && typeof switches === "object" && !Array.isArray(switches)) return switches;
  if (Array.isArray(settings)) {
    const map = {};
    for (const item of settings) {
      if (item && typeof item.key === "string") map[item.key] = item.value;
    }
    return map;
  }
  return null;
}

function lookup(configuration, key) {
  const map = switchMap(configuration);
  if (!map || typeof key !== "string" || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  return map[key];
}

export function isFeatureEnabled(configuration, key, fallback = false) {
  const value = lookup(configuration, key);
  return typeof value === "boolean" ? value : Boolean(fallback);
}

export function featureLimit(configuration, key, fallback) {
  const value = lookup(configuration, key);
  return Number.isInteger(value) ? value : fallback;
}

export function featureText(configuration, key, fallback = "") {
  const value = lookup(configuration, key);
  return typeof value === "string" ? value : fallback;
}

export function featureTextList(configuration, key, fallback = []) {
  const value = lookup(configuration, key);
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [...fallback];
}
