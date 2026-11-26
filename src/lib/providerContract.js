import sampleBackend from "../../config/sample-backend.json" with { type: "json" };
import {
  isBrowserSafeSupabaseKey,
  isLocalProviderHost,
  matchSupabaseProjectOrigin,
  normalizedProjectRef,
  parsedProviderUrl,
} from "./providerShape.js";
import { deniedHostOf, digestSet, isDeniedValue } from "../../scripts/lib/denied-identity.mjs";

export { isBrowserSafeSupabaseKey };

// The server and tool validators. Browser code imports src/lib/providerShape.js
// instead, so the deny lists below stay out of the shipped bundle.
//
// The one maintained deny list is config/sample-backend.json. It keeps the
// sibling product's Supabase projects (forbiddenSupabaseRefSha256) and
// application hosts (forbiddenAppHostSha256) as digests
// (scripts/lib/denied-identity.mjs), so this repository refuses them without
// naming them. A host listed there is refused together with all of its
// subdomains.
export const FORBIDDEN_SUPABASE_REF_DIGESTS = digestSet(sampleBackend.forbiddenSupabaseRefSha256);
export const FORBIDDEN_APP_HOST_DIGESTS = digestSet(sampleBackend.forbiddenAppHostSha256);

export function isForbiddenSupabaseRef(ref) {
  return isDeniedValue(ref, FORBIDDEN_SUPABASE_REF_DIGESTS);
}

export function isForbiddenAppHost(hostname) {
  return deniedHostOf(hostname, FORBIDDEN_APP_HOST_DIGESTS) !== null;
}

export function validateUnionGroundAppUrl(value, { allowLocal = false, path = "/" } = {}) {
  const url = parsedProviderUrl(value, "Union Ground app URL");
  const local = isLocalProviderHost(url.hostname);
  if (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) {
    throw new Error("Union Ground app URL must use HTTPS");
  }
  // The HTTPS check above lets https://localhost through, so a loopback origin
  // would otherwise satisfy the "deployed target" contract the Browserbase
  // runner relies on. allowLocal is the ONE way to reach a local origin.
  if (local && !allowLocal) {
    throw new Error("Local Union Ground app URL is not an allowed deployed target");
  }
  if (isForbiddenAppHost(url.hostname)) {
    throw new Error("Sibling product host is forbidden");
  }
  if (url.pathname !== path) {
    throw new Error(`Union Ground app URL path must be ${path}`);
  }
  return url;
}

export function validateUnionGroundSupabase(value, expectedRef, { allowLocal = false } = {}) {
  // The expected ref is refused by name before the URL is read: an operator who
  // supplies a sibling project's ref together with its URL still gets nothing.
  if (isForbiddenSupabaseRef(normalizedProjectRef(expectedRef))) {
    throw new Error("Sibling product Supabase project is forbidden");
  }
  return matchSupabaseProjectOrigin(value, expectedRef, { allowLocal });
}

// A Supabase key that only a server may hold: a `sb_secret_` key, or a legacy
// JWT whose role is service_role or supabase_admin. Anything in a VITE_
// variable ships to every browser, so the build refuses these by shape under
// any VITE_ name, not only the one the app reads.
export function isServerOnlySupabaseKey(value) {
  const key = String(value || "").trim();
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;
  try {
    const encoded = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const role = JSON.parse(globalThis.atob(padded))?.role;
    return role === "service_role" || role === "supabase_admin";
  } catch {
    return false;
  }
}

// Names (never values) of the VITE_ variables that hold a server-only key.
export function browserExposedServerKeys(env) {
  return Object.entries(env || {})
    .filter(([name, value]) => name.startsWith("VITE_") && isServerOnlySupabaseKey(value))
    .map(([name]) => name)
    .sort();
}

// Throws before Vite can embed anything when a server-only Supabase key sits
// in any VITE_ variable, or when the SAMPLE browser key is set but is not a
// publishable or legacy anon key.
export function validateBrowserEnvironmentKeys(env) {
  const exposed = browserExposedServerKeys(env);
  if (exposed.length) {
    throw new Error(`${exposed.join(", ")} must not hold a Supabase secret or service_role key: every VITE_ value ships to browsers`);
  }
  const sampleKey = String(env?.VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (sampleKey && !isBrowserSafeSupabaseKey(sampleKey)) {
    throw new Error("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY must contain only a publishable or legacy anon key");
  }
  return true;
}

export function validateBrowserProviderEnvironment(env, { allowLocal = false } = {}) {
  const url = String(env?.VITE_SUPABASE_URL || "").trim();
  const key = String(env?.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim();
  const ref = String(env?.VITE_UNIONGROUND_SUPABASE_REF || "").trim();
  const configured = [url, key, ref].filter(Boolean).length;
  if (configured === 0) return false;
  if (configured !== 3) {
    throw new Error("Browser Supabase URL, publishable key, and expected project ref must be configured together");
  }
  validateUnionGroundSupabase(url, ref, { allowLocal });
  if (!isBrowserSafeSupabaseKey(key)) {
    throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY must contain only a publishable or legacy anon key");
  }
  return true;
}
