import { SAMPLE_BACKEND } from "./sampleBackend.js";
import { TRUSTED_BACKEND_PORTALS } from "./trustedBackends.js";

// Hosts come only from Union Ground's provider sources. The SaaS hosts are
// the portals of the owner-approved backend pairs in ./trustedBackends.js
// (none today). The named SAMPLE host is the sample portal pinned in
// config/sample-backend.json (./sampleBackend.js), which is the reserved
// placeholder unionground.invalid until a real one is approved: it can
// never resolve, and the SAMPLE backend behind it refuses every project, so
// both decisions fail closed. The fixture tour stays reachable on Union
// Ground's own deployment through /m?demo=1.
function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export const DEFAULT_DEMO_ORIGIN = String(SAMPLE_BACKEND.samplePortalOrigin || "").replace(/\/$/, "");
export const DEFAULT_DEMO_HOST = hostOf(DEFAULT_DEMO_ORIGIN);
// A reserved .invalid origin is a placeholder, never a link anyone can open.
const DEMO_ORIGIN_LINKABLE = Boolean(DEFAULT_DEMO_HOST) && !DEFAULT_DEMO_HOST.endsWith(".invalid");
export const SAAS_HOSTS = Object.freeze(Object.values(TRUSTED_BACKEND_PORTALS).map(hostOf).filter(Boolean));

// Never pass the whole Vite environment through a default parameter. Vite
// materializes that object in the public bundle, which can expose unrelated
// VITE_* values from a deployment that was configured for another surface.
const BUILD_ENV = Object.freeze({
  MODE: import.meta.env?.MODE,
  VITEST: import.meta.env?.VITEST,
  VITE_APP_SURFACE: import.meta.env?.VITE_APP_SURFACE,
  VITE_E2E_HARNESS: import.meta.env?.VITE_E2E_HARNESS,
  VITE_VISUAL_AUDIT: import.meta.env?.VITE_VISUAL_AUDIT,
});

function envValue(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

export function namedDemoOrigin() {
  return DEFAULT_DEMO_ORIGIN;
}

export function namedDemoHost() {
  return DEFAULT_DEMO_HOST;
}

export function isSaasHost(hostname) {
  return SAAS_HOSTS.includes(normalizeHost(hostname));
}

export function isPreviewHost(hostname) {
  const host = normalizeHost(hostname);
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "[::1]"
    || host.endsWith(".vercel.app");
}

export function isDemoHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host || !DEFAULT_DEMO_HOST) return false;
  return host === DEFAULT_DEMO_HOST || host === `www.${DEFAULT_DEMO_HOST}`;
}

export function namedAppSurface(env = BUILD_ENV) {
  const value = envValue(env, "VITE_APP_SURFACE").toLowerCase();
  return value === "demo" || value === "saas" ? value : "";
}

export function isBuildTimeDemoSurface(env = BUILD_ENV) {
  return namedAppSurface(env) === "demo";
}

export function hasDemoQuery(search) {
  try {
    const query = typeof search === "string"
      ? search
      : search instanceof URLSearchParams
        ? search.toString()
        : "";
    return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).get("demo") === "1";
  } catch {
    return false;
  }
}

// Appends the ?demo=1 rider to an app path that lacks it. A path that already
// carries a query (an explicit ?shell= choice, a filter) gets "&demo=1"; a bare
// "?" there would read as part of the previous value ("shell=alt?demo=1") and
// drop both flags on the next load. A fragment stays last.
export function withDemoRider(path) {
  if (!path) return path;
  const [base, hash] = String(path).split(/#(.*)/s);
  const query = base.includes("?") ? base.slice(base.indexOf("?")) : "";
  if (hasDemoQuery(query)) return path;
  return `${base}${base.includes("?") ? "&" : "?"}demo=1${hash !== undefined ? `#${hash}` : ""}`;
}

export function isTestHarness(env = BUILD_ENV) {
  const e2eHarness = envValue(env, "VITE_E2E_HARNESS").toLowerCase();
  // Local SAMPLE visual-audit builds have no SAMPLE keys and must not set
  // VITE_E2E_HARNESS (that flag also opens Playwright-only window seams).
  const visualAudit = envValue(env, "VITE_VISUAL_AUDIT").toLowerCase();
  return envValue(env, "MODE").toLowerCase() === "test"
    || envValue(env, "VITEST").toLowerCase() === "true"
    || e2eHarness === "1"
    || e2eHarness === "true"
    || visualAudit === "1"
    || visualAudit === "true";
}

export function resolveAppSurface({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  search = typeof window === "undefined" ? "" : window.location.search,
  env = BUILD_ENV,
} = {}) {
  if (isSaasHost(hostname)) return "saas";
  if (isDemoHost(hostname, env)) return "demo";
  const named = namedAppSurface(env);
  if (named) return named;
  // Canonical SaaS hosts were returned above and can never enter SAMPLE mode.
  // Ordinary localhost and Vercel previews stay SaaS too. The query seam is
  // fixture-only and therefore requires an explicitly configured automated or
  // visual test harness; a URL alone may never change the backend surface.
  if (isPreviewHost(hostname) && isTestHarness(env) && hasDemoQuery(search)) return "demo";
  return "saas";
}

export function shouldEnterDemo(options) {
  return resolveAppSurface(options) === "demo";
}

export function allowsAnonymousDemoEntry({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  env = BUILD_ENV,
} = {}) {
  return isPreviewHost(hostname) && isTestHarness(env);
}

export function sampleTourHref(
  env = BUILD_ENV,
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
) {
  if (isPreviewHost(hostname) && isTestHarness(env)) return "/m?demo=1";
  return DEMO_ORIGIN_LINKABLE ? DEFAULT_DEMO_ORIGIN : "/m?demo=1";
}

export function liveBackendAllowed({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  env = BUILD_ENV,
} = {}) {
  return resolveAppSurface({ hostname, search: "", env }) !== "demo";
}

export function sampleBackendAllowed({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  env = BUILD_ENV,
} = {}) {
  return resolveAppSurface({ hostname, search: "", env }) === "demo";
}

// The one origin a server-built link, email link, or OAuth return may name for
// a surface: the portal of the owner-approved Union Ground backend pair in
// ./trustedBackends.js for SaaS, and nothing for SAMPLE (Union Ground has no
// public SAMPLE site). "" while none exists, so callers fall back to a
// same-origin relative path or refuse; no sibling product's site is ever named.
export function portalOrigin(surface) {
  if (surface === "demo") return "";
  const [origin] = Object.values(TRUSTED_BACKEND_PORTALS);
  return typeof origin === "string" ? origin.replace(/\/$/, "") : "";
}
