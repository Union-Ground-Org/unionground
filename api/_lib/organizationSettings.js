// Server-side organization settings reader for api/ routes
// (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001).
//
// Calls the service-role-only public.get_organization_settings_for_service and
// returns { "<key>": <effective value> } for exactly the requested keys: the
// organization's stored value, else the platform definition default. An
// unknown key is refused by the database (22023), so a typo fails loudly.
//
// Use it only after the route has established which organization it acts for
// (for example from a verified member session or a claimed job row); the
// organization id is never taken from an unauthenticated request.

import { supabaseRpc } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTING_KEY = /^[a-z][a-z0-9_.-]{2,79}$/;

export async function readOrganizationSettings(backend, organizationId, keys, options = {}) {
  const url = String(backend?.url ?? backend?.supabaseUrl ?? "").replace(/\/$/, "");
  const serviceRoleKey = String(backend?.serviceRoleKey ?? "");
  if (!url || !serviceRoleKey) throw new Error("organization-settings-backend-unavailable");
  if (!UUID.test(String(organizationId ?? ""))) throw new Error("organization-settings-invalid-organization");
  const unique = [...new Set(Array.isArray(keys) ? keys : [])];
  if (unique.length === 0 || unique.length > 100 || unique.some((key) => typeof key !== "string" || !SETTING_KEY.test(key))) {
    throw new Error("organization-settings-invalid-keys");
  }
  const result = await supabaseRpc(url, serviceRoleKey, serviceRoleKey, "get_organization_settings_for_service", {
    p_organization_id: organizationId,
    p_keys: unique,
  }, options);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("organization-settings-malformed");
  for (const key of unique) {
    if (!Object.hasOwn(result, key)) throw new Error("organization-settings-malformed");
  }
  return result;
}
