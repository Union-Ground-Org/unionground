// The provider rules the browser needs, and nothing that names a sibling
// product. The browser bundle imports only this module: a live client exists
// solely for the one project the build pins (VITE_UNIONGROUND_SUPABASE_REF),
// and vite.config.mjs refuses a build whose pin or URL is a sibling target
// (src/lib/providerContract.js), so the deny lists never need to ship.

// The only hosts a local development backend may use. No other loopback
// spelling qualifies.
const LOCAL_PROVIDER_HOSTS = Object.freeze(["127.0.0.1", "localhost"]);

export function parsedProviderUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  return url;
}

export function isLocalProviderHost(hostname) {
  return LOCAL_PROVIDER_HOSTS.includes(String(hostname || "").toLowerCase());
}

export function normalizedProjectRef(expectedRef) {
  const ref = String(expectedRef || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,63}$/.test(ref)) {
    throw new Error("Union Ground Supabase project ref is required");
  }
  return ref;
}

// The URL is a bare hosted Supabase origin whose project is exactly
// `expectedRef`, or, with allowLocal, a bare http:// origin on
// LOCAL_PROVIDER_HOSTS for the project ref `local`. Returns the parsed URL.
export function matchSupabaseProjectOrigin(value, expectedRef, { allowLocal = false } = {}) {
  const ref = normalizedProjectRef(expectedRef);
  const url = parsedProviderUrl(value, "Union Ground Supabase URL");
  if (url.pathname !== "/") throw new Error("Union Ground Supabase URL must be a bare origin");
  if (allowLocal && isLocalProviderHost(url.hostname) && url.protocol === "http:") {
    if (ref !== "local") throw new Error("Local Supabase requires project ref local");
    return url;
  }
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(".supabase.co")) {
    throw new Error("Union Ground Supabase URL must be a hosted Supabase origin");
  }
  const actualRef = url.hostname.slice(0, -".supabase.co".length).toLowerCase();
  if (!actualRef || actualRef !== ref) {
    throw new Error("Union Ground Supabase URL does not match the expected project ref");
  }
  return url;
}

export function isBrowserSafeSupabaseKey(value) {
  const key = String(value || "").trim();
  if (/^sb_secret_/i.test(key)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{12,}$/i.test(key)) return true;

  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;
  try {
    const encoded = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(globalThis.atob(padded));
    return payload?.role === "anon";
  } catch {
    return false;
  }
}
