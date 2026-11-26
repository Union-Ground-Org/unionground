import { waitUntil } from "@vercel/functions";
import { FIREWORKS_GATEWAY, MESH_GATEWAY, MESH_MODEL } from "./compassAiGovernance.js";

// Operator alerts for the platform AI answer path
// (REQ-UG-PLATFORM-AI-OUTAGE-ALERTS-AND-FAILOVER-TUNING-20261017).
//
// Two events reach the private ug-alerts Slack channel: Fireworks took over
// an answer because the mesh failed at the network boundary, and the answer
// path is down (the member got the search-only reply). A takeover returns
// HTTP 200, so nothing else in the stack can see it; this is the only signal.
//
// Boundaries, in order of importance:
//   * Metadata only. The text is built from closed vocabularies and integers
//     plus the reservation id. Never a question, an answer, a source, a user
//     or organization identifier, a credential or a URL.
//   * Never on the member's path. The post is scheduled with waitUntil and
//     every failure is swallowed; the response is sent exactly as before.
//   * Throttled, at least once. One post per event kind per ten minutes per
//     warm instance: the window is claimed before the request so overlapping
//     calls cannot both post, and released again when the post is rejected
//     or fails so nothing is silenced. A burst across cold instances may post
//     a few duplicates; silence is the failure mode this module refuses, so
//     there is no cross-instance election.
//   * Off by default. Without UG_ALERTS_SLACK_WEBHOOK_URL nothing happens.

export const ALERT_WEBHOOK_ENV_VAR = "UG_ALERTS_SLACK_WEBHOOK_URL";
export const ALERT_WEBHOOK_HOST = "hooks.slack.com";
export const ALERT_THROTTLE_MS = 10 * 60_000;
export const ALERT_KINDS = Object.freeze(["fireworks_takeover", "answer_path_down"]);
export const ALERT_ROUTES = Object.freeze(["guide", "civic-draft"]);
export const ALERT_ENVIRONMENTS = Object.freeze(["production", "sample"]);
// What the member got when the answer path failed: the question path degrades
// to the search-only reply; every other mode and route returns an error.
export const ALERT_OUTCOMES = Object.freeze(["error", "search_only"]);
// Causes the failover helper and the gateway diagnostic already emit, plus
// the two network classes. Anything else renders as `unknown`.
export const ALERT_CAUSES = Object.freeze([
  "temporary_http", "timeout", "transport",
  "gateway_error", "gateway_timeout", "no_credits", "unauthorized", "model_mismatch", "compliance_metadata_invalid",
  "fallback_refused", "governance_unavailable", "invalid_result",
]);
const RESERVATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FIREWORKS_MODEL = /^accounts\/fireworks\/models\/(?![a-z0-9.-]*contributor)[a-z0-9.-]{1,80}$/;
const FORBIDDEN_PAYLOAD_PATTERNS = Object.freeze([
  [/[a-z][a-z0-9+.-]*:\/\//i, "a URL"],
  [/[?&][\w.-]+=/, "a URL query parameter"],
  [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "an email address"],
  [/\bBearer\s+\S+/i, "a bearer credential"],
  [/\b(?:sk|fw|xox[abprs])[-_][A-Za-z0-9]/, "a token-shaped string"],
  [/<[a-z!/]/i, "markup from a response body"],
]);

const lastPostedAt = new Map();

export function resetPlatformAlertThrottle() {
  lastPostedAt.clear();
}

function closed(vocabulary, value, fallback = "unknown") {
  return vocabulary.includes(value) ? value : fallback;
}

function safeGateway(value) {
  return value === FIREWORKS_GATEWAY || value === MESH_GATEWAY ? value : "unknown";
}

function safeModel(value) {
  const model = String(value || "");
  return model === MESH_MODEL || /^union-ground\/compass-mesh:v[0-9]+$/.test(model) || FIREWORKS_MODEL.test(model) ? model : "unknown";
}

function easternTime(now) {
  return `${now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: true })} ET`;
}

// The complete payload. Every field passes through a closed vocabulary, a
// shape test or an integer check before it is rendered, so free text from a
// provider, a member or an exception can never be interpolated.
export function buildPlatformAlertText(event, now = new Date()) {
  const kind = closed(ALERT_KINDS, event?.kind, null);
  if (!kind) throw new Error("unknown platform alert kind");
  const environment = closed(ALERT_ENVIRONMENTS, event?.environment, "production");
  const route = closed(ALERT_ROUTES, event?.route);
  const cause = closed(ALERT_CAUSES, event?.cause);
  const gateway = safeGateway(event?.gateway);
  const model = safeModel(event?.model);
  const outcome = closed(ALERT_OUTCOMES, event?.outcome, "error");
  const reservation = RESERVATION_ID.test(String(event?.reservationId || "")) ? String(event.reservationId).toLowerCase() : "none";
  const headline = kind === "fireworks_takeover"
    ? "Fireworks took over a Compass answer: the mesh failed at the network boundary"
    : cause === "invalid_result"
      ? `Compass answer path down: the provider's completed ${route === "civic-draft" ? "draft" : "reply"} could not be used`
      : route === "civic-draft"
        ? "Compass answer path down: the member could not get a draft"
        : outcome === "search_only"
          ? "Compass answer path down: the member received the search-only reply"
          : "Compass answer path down: the member received an error instead of an answer";
  const lines = [
    `Union Ground platform AI — ${kind === "fireworks_takeover" ? "FAILOVER" : "OUTAGE"} (${environment})`,
    headline,
    `route: ${route} | cause: ${cause} | gateway: ${gateway} | model: ${model}`,
    `reservation: ${reservation} | observed: ${easternTime(now)} (${now.toISOString()})`,
    kind === "fireworks_takeover"
      ? "The mesh remains primary. Check mesh gateway health and recent network errors."
      : cause === "invalid_result"
        ? "The route rejected the provider reply. Check validation errors for the named route and model."
        : "Check provider health and whether the failed route permits failover for this cause.",
  ];
  return assertMetadataOnlyAlert(lines.join("\n"));
}

export function assertMetadataOnlyAlert(text) {
  const value = String(text);
  for (const [pattern, description] of FORBIDDEN_PAYLOAD_PATTERNS) {
    if (pattern.test(value)) throw new Error(`refusing to send an alert payload containing ${description}`);
  }
  return value;
}

export function parseAlertWebhookUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== ALERT_WEBHOOK_HOST) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

export function platformAlertThrottled(kind, now = new Date(), throttleMs = ALERT_THROTTLE_MS) {
  const previous = lastPostedAt.get(kind);
  return Number.isFinite(previous) && now.getTime() - previous < throttleMs;
}

// Classifies a failure of the governed answer path for the outage alert, or
// null when the failure is not an outage: a deliberate pause, a privacy
// refusal or a configuration refusal before any provider was contacted. A
// refused fallback after a mesh failure is an outage (the member got the
// degraded reply) and names the mesh provider; a failure of the Fireworks
// attempt itself names Fireworks, carried on the propagated error. A reply
// the provider completed but the route could not use (`invalidResult`,
// stamped by the caller with the provider that produced it) is an outage
// too: the member leaves without an answer, after a takeover or not.
export function answerPathOutage(error, provider) {
  if (error?.failoverRefused) {
    if (error.cause === "disabled") return null;
    return { cause: error.cause === "governance_unavailable" ? "governance_unavailable" : "fallback_refused", gateway: provider?.gateway, model: provider?.model };
  }
  if (error?.invalidResult === true) {
    const produced = error?.provider?.gateway ? error.provider : provider;
    return { cause: "invalid_result", gateway: produced?.gateway, model: produced?.model };
  }
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  if (!timedOut && !error?.gatewayCause && !error?.gatewayResponse) return null;
  const failed = error?.provider?.gateway ? error.provider : provider;
  return { cause: timedOut ? "gateway_timeout" : error?.gatewayCause || "gateway_error", gateway: failed?.gateway, model: failed?.model };
}

// Resolves to one of: posted, disabled, throttled, rejected, failed.
// It never throws and never logs the destination or the payload.
export async function postPlatformAlert(event, {
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  try {
    const webhook = parseAlertWebhookUrl(env[ALERT_WEBHOOK_ENV_VAR]);
    if (!webhook) return "disabled";
    const text = buildPlatformAlertText(event, now);
    if (platformAlertThrottled(event.kind, now)) return "throttled";
    // Claim the window before the request so two overlapping events on one
    // instance cannot both post; release it below when nothing was delivered.
    lastPostedAt.set(event.kind, now.getTime());
    let response;
    try {
      response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      lastPostedAt.delete(event.kind);
      throw error;
    }
    if (!response.ok) {
      // A rejected post must not silence the next event for ten minutes.
      lastPostedAt.delete(event.kind);
      console.error("[platform-alert] destination rejected the notification", { kind: event.kind, status: Number(response.status) || 0 });
      return "rejected";
    }
    return "posted";
  } catch {
    console.error("[platform-alert] notification failed", { kind: closed(ALERT_KINDS, event?.kind) });
    return "failed";
  }
}

// Fire-and-forget from a request handler. waitUntil keeps the function alive
// after the response on Vercel; anywhere else the promise simply runs
// detached. Returns the promise so tests can await the outcome.
export function schedulePlatformAlert(event, options = {}) {
  const pending = postPlatformAlert(event, options);
  try { (options.waitUntilImpl || waitUntil)(pending); } catch { /* outside the Vercel runtime */ }
  return pending;
}
