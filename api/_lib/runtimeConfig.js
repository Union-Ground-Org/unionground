import { isDemoHost, isSaasHost, isPreviewHost } from "../../src/lib/demoOrigin.js";
import { productionBackendFromEnv, sampleBackendFromEnv } from "./backend.js";
import { requestHostname } from "./http.js";
import { TRUSTED_BACKEND_PORTALS } from "../../src/lib/trustedBackends.js";
import { pinnedSampleSupabaseOrigin } from "../../src/lib/sampleBackend.js";
import { isServerOnlySupabaseKey } from "../../src/lib/providerContract.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The pinned Supabase origins a browser may be handed, from Union Ground's
// provider sources only: the backends of the owner-approved pairs in
// src/lib/trustedBackends.js for production, and the pinned SAMPLE project in
// src/lib/sampleBackend.js (config/sample-backend.json) for the demo. Both are
// empty until a dedicated Union Ground project exists, so every named host
// answers configured: false and the browser fails closed.
function pinnedSupabaseOrigins(surface) {
  if (surface === "demo") {
    const origin = pinnedSampleSupabaseOrigin();
    return origin ? [origin.replace(/\/$/, "")] : [];
  }
  return Object.keys(TRUSTED_BACKEND_PORTALS).map((origin) => origin.replace(/\/$/, ""));
}

function exactSupabaseOrigin(value, surface) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.hostname.endsWith(".supabase.co")
      && pinnedSupabaseOrigins(surface).includes(url.origin);
  } catch {
    return false;
  }
}

function selectedSurface(hostname, env) {
  if (isDemoHost(hostname)) return "demo";
  if (isSaasHost(hostname)) return "saas";
  if (isPreviewHost(hostname)) {
    return String(env?.VITE_APP_SURFACE || "").trim().toLowerCase() === "demo"
      ? "demo"
      : "saas";
  }
  return null;
}

function explicitLocalHarness(hostname, backendUrl, env) {
  const enabled = String(env?.VITE_E2E_HARNESS || "").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname) || (enabled !== "1" && enabled !== "true")) return false;
  try {
    const url = new URL(String(backendUrl || "").trim());
    return (url.protocol === "http:" || url.protocol === "https:")
      && LOOPBACK_HOSTS.has(url.hostname)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

export function runtimeConfigForRequest(request, env = process.env) {
  const hostname = requestHostname(request);
  const surface = selectedSurface(hostname, env);
  if (!surface) return { schema: 1, surface: null, configured: false };

  const backend = surface === "demo"
    ? sampleBackendFromEnv(env)
    : productionBackendFromEnv(env);
  // Browser assurance deliberately uses a dead loopback Supabase endpoint so
  // it can exercise the signed-out product without contacting external data.
  // Keep that seam explicit and loopback-only; named and Vercel hosts always
  // require their pinned HTTPS project.
  const originAllowed = explicitLocalHarness(hostname, backend.url, env)
    || exactSupabaseOrigin(backend.url, surface);
  // A server-only key (sb_secret_ or a service_role JWT) configured in the
  // publishable slot by mistake leaves the browser unconfigured instead of
  // shipping the admin key to every visitor. The browser client separately
  // accepts only a publishable or legacy anon key (src/lib/supabase.js).
  const publishableKey = String(backend.publishableKey || "").trim();
  const configured = originAllowed
    && Boolean(publishableKey)
    && !isServerOnlySupabaseKey(publishableKey);

  if (!configured) return { schema: 1, surface, configured: false };
  return {
    schema: 1,
    surface,
    configured: true,
    supabaseUrl: backend.url,
    supabasePublishableKey: backend.publishableKey,
    ...(surface === "saas" && publicHeatmapsSwitchOn(env) ? { publicHeatmaps: true } : {}),
  };
}

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248),
// MAIN 121 ruling: public-page heatmaps stay off until the owner sets this
// server switch, after the privacy text that describes them is published.
// Anything but the exact value "on" is off.
export function publicHeatmapsSwitchOn(env = process.env) {
  return String(env?.POSTHOG_PUBLIC_HEATMAPS ?? "").trim() === "on";
}

export function serializeRuntimeConfig(config) {
  const json = JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `globalThis.__UNIONGROUND_RUNTIME_CONFIG__=Object.freeze(${json});\n`;
}
