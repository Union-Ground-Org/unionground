import { applySdkMetadata, captureException, createStackParser, createTransport, flush, initAndBind } from "@sentry/core";
import { ServerRuntimeClient, nodeStackLineParser } from "@sentry/core/server";
import { PostHog } from "posthog-node";
import { waitUntil } from "@vercel/functions";
import { privateSentryOptions, privateSentryTransport } from "../../src/lib/sentryPrivacy.js";
import { DIAGNOSTICS_DISTINCT_ID, privatePostHogFetch, sanitizePostHogExceptionEvent } from "../../src/lib/posthogPrivacy.js";

let initialized = false;
let posthogClient = null;
let posthogConfigured = false;

// PostHog error tracking beside Sentry (owner order, October 27, 2026; record
// OPS-UG-POSTHOG-ERROR-TRACKING-REPLACES-SENTRY-20261027). The same
// content-free policy applies twice: before_send rebuilds the event from the
// allowlist and the private fetch rebuilds the request body, so neither an SDK
// default nor a caller property reaches the relay. Feature flags, remote
// config and compression are off; nothing but /batch/ leaves the function.
export function initServerPosthog() {
  if (posthogConfigured) return posthogClient !== null;
  posthogConfigured = true;
  const token = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = process.env.POSTHOG_HOST?.trim();
  if (!token || !/^https:\/\/[a-z0-9.-]+$/.test(host || "")) return false;
  const environment = process.env.VERCEL_ENV === "preview" ? "preview" : "production";
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  const metadata = { surface: "api", environment, release, origin: process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined };
  posthogClient = new PostHog(token, {
    host,
    flushAt: 1,
    flushInterval: 0,
    disableCompression: true,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    featureFlagsPollingInterval: 0,
    fetch: privatePostHogFetch(fetch, metadata),
    before_send: (event) => sanitizePostHogExceptionEvent(event, metadata),
  });
  return true;
}

function captureServerFailureInPosthog() {
  try {
    if (!initServerPosthog()) return false;
    // The same fixed error: no request, response, tenant, member or backend
    // detail; the private fetch strips whatever the SDK adds around it.
    posthogClient.captureException(new Error("Application error"), DIAGNOSTICS_DISTINCT_ID, { surface: "api" });
    waitUntil(posthogClient.flush().catch(() => false));
    return true;
  } catch {
    return false;
  }
}

// The request the private transport hands on is already the sanitized
// envelope; this only posts it to the DSN's ingest URL and returns the rate
// limit headers the core transport reads. The status and headers are returned
// as soon as they arrive, so a slow or stalled body never delays the backoff
// (gate stage 203, r2s2); the body is cancelled without waiting, which
// releases the connection at once.
function makeFetchTransport(options) {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, { method: "POST", headers: options.headers, body: request.body });
    if (typeof response.body?.cancel === "function") response.body.cancel().catch(() => null); // swallow-ok: the body is discarded; the status is the answer
    return {
      statusCode: response.status,
      headers: {
        "retry-after": response.headers.get("retry-after"),
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
      },
    };
  });
}

export function initServerObservability() {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  const environment = process.env.VERCEL_ENV === "preview" ? "preview" : "production";
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  // The core server client, not @sentry/node: that SDK carries OpenTelemetry,
  // diagnostics-channel injection and its server utilities, which this
  // errors-only init switched off anyway, and Vercel traced all of them into
  // every function (record OPS-UG-SERVER-SENTRY-NODE-CORE-LIGHT-20261113).
  // No integrations: no process-wide request instrumentation or
  // cross-request scope data in the warm isolate. The Node SDK identity keeps
  // the ingest request's client query and user agent as they were; the
  // private transport still replaces the SDK block inside the envelope.
  const options = {
    dsn, ...privateSentryOptions(),
    integrations: [],
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    transport: privateSentryTransport(makeFetchTransport, { release, environment, surface: "api" }),
  };
  applySdkMetadata(options, "node");
  initAndBind(ServerRuntimeClient, options);
  initialized = true;
  return true;
}

export function captureServerFailure(status) {
  if (!Number.isInteger(status) || status < 500 || status > 599) return false;
  // PostHog reports independently of Sentry, so the Sentry DSN's absence
  // never silences PostHog and the reverse.
  const posthogReported = captureServerFailureInPosthog();
  try {
    if (!initServerObservability()) return posthogReported;
    // Never pass a request, response payload, tenant, member, or raw backend
    // error into scope. The stack identifies the shared helper's caller only.
    captureException(new Error("Application error"));
    waitUntil(flush(2000).catch(() => false));
    return true;
  } catch {
    // Monitoring must not change an API response or expose a transport error.
    return false;
  }
}
