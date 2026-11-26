import { isDemoHost, isSaasHost, normalizeHost } from "../../src/lib/demoOrigin.js";
import { isForbiddenSampleBackend } from "../../src/lib/sampleBackend.js";
import { constantTimeEqual, cronSecretUsable } from "./cronAuth.js";
import { requestHostname } from "./http.js";
import { approvedProductionBackend } from "./providerBoundary.js";

export { requestHostname } from "./http.js";


function envValue(env, key) {
  return String(env?.[key] || "").trim();
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

export function isVercelCron(request, env = process.env) {
    // A Vercel cron tick is authenticated by the configured CRON_SECRET sent as
    // the bearer, exactly as api/account-deletion-reconcile.js and
    // api/notifications-dispatch.js check it. Vercel documents only that bearer,
    // the vercel-cron/1.0 user agent and x-vercel-cron-schedule; it sends no
    // x-vercel-cron marker. Only the raw Authorization string is read, and it
    // must equal `Bearer <CRON_SECRET>` exactly: no trimming, no other spacing,
    // and an array value never authorizes. No other header is read: every
    // header is client-suppliable, so none can authorize or, without the
    // bearer, override host-based key routing (a demo-host request cannot force
    // production keys). A missing, short or placeholder CRON_SECRET
    // (./cronAuth.js) is no secret.
    const authorization = request?.headers?.authorization;
    if (!cronSecretUsable(env) || typeof authorization !== "string") return false;
    return constantTimeEqual(authorization, `Bearer ${env.CRON_SECRET}`);
}

// The production backend, or a refusal with no URL and no key. The trust
// decision is approvedProductionBackend() in ./providerBoundary.js; this name
// stays for the scheduled jobs that resolve production without a request.
export function productionBackendFromEnv(env = process.env) {
  return approvedProductionBackend(env);
}

export function sampleBackendFromEnv(env = process.env) {
  const url = normalizeUrl(envValue(env, "SAMPLE_SUPABASE_URL") || envValue(env, "VITE_SAMPLE_SUPABASE_URL"));
  const publishableKey = envValue(env, "SAMPLE_SUPABASE_PUBLISHABLE_KEY")
    || envValue(env, "VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = envValue(env, "SAMPLE_SUPABASE_SERVICE_ROLE_KEY");
  if (!url || isForbiddenSampleBackend(url)) {
    return { surface: "demo", url: "", publishableKey: "", serviceRoleKey: "" };
  }
  return { surface: "demo", url, publishableKey, serviceRoleKey };
}

const DEMO_LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

export const DEMO_SURFACE_HOST_REFUSED = "demo-surface-host-not-recognized";

function isDemoSurface(env) {
  return envValue(env, "VITE_APP_SURFACE").toLowerCase() === "demo";
}

// Optional, exact-hostname allowlist of SAMPLE preview deployments
// (SAMPLE_PREVIEW_HOSTS, comma-separated). Only single-label `<name>.vercel.app`
// hostnames qualify:
// the SaaS hosts, the canonical demo host and loopback are decided before this
// list is consulted and can never be re-mapped through it.
const SAMPLE_PREVIEW_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/;

export function samplePreviewHosts(env = process.env) {
  return envValue(env, "SAMPLE_PREVIEW_HOSTS")
    .split(",")
    .map((value) => normalizeHost(value))
    .filter((host) => SAMPLE_PREVIEW_HOST_PATTERN.test(host) && !isSaasHost(host) && !isDemoHost(host));
}

export function isSamplePreviewHost(hostname, env = process.env) {
  const host = normalizeHost(hostname);
  return Boolean(host) && samplePreviewHosts(env).includes(host);
}

// A demo-surface build must never hand production credentials to an ordinary
// request on a host it does not recognise. The refusal carries no URL and no
// key, so no caller can reach production with it; each caller then answers
// with its own fail-closed response (most a 503 "not configured", some a
// 401/404/409 refusal or a database-free result). `refused` names the reason so
// operators can tell a refused host from a missing SAMPLE configuration.
export function refusedDemoSurfaceBackend(hostname) {
  return {
    surface: "demo",
    url: "",
    publishableKey: "",
    serviceRoleKey: "",
    refused: DEMO_SURFACE_HOST_REFUSED,
    hostname: normalizeHost(hostname),
  };
}

export function resolveSupabaseBackend(request, env = process.env) {
  const hostname = requestHostname(request);
  // The SaaS host is always production, never demo. Pin it explicitly so no
  // runtime surface setting can route production traffic to the SAMPLE backend.
  if (isSaasHost(hostname)) return productionBackendFromEnv(env);
  const demoSurface = isDemoSurface(env);
  // The demo loopback is decided before the cron check: a local SAMPLE preview
  // stays on SAMPLE even for an authenticated cron request.
  if (DEMO_LOOPBACK_HOSTS.includes(hostname) && demoSurface) return sampleBackendFromEnv(env);
  // A genuine Vercel cron tick (the CRON_SECRET bearer) on any remaining host
  // is production work.
  if (isVercelCron(request, env)) return productionBackendFromEnv(env);
  if (isDemoHost(hostname)) return sampleBackendFromEnv(env);
  if (demoSurface && isSamplePreviewHost(hostname, env)) return sampleBackendFromEnv(env);
  // BUG-UG-DEMO-SURFACE-PREVIEW-RESOLVES-PRODUCTION-BACKEND-20260908: an
  // ordinary demo-surface request on every other host (for example an
  // unlisted .vercel.app preview) fails closed instead of reaching production.
  if (demoSurface) return refusedDemoSurfaceBackend(hostname);
  return productionBackendFromEnv(env);
}
