import { waitUntil } from "@vercel/functions";
import { ALERT_WEBHOOK_ENV_VAR, assertMetadataOnlyAlert, parseAlertWebhookUrl } from "./platformAlerts.js";

// Private signals for signup and account mail failures
// (REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111).
//
// The signup and reset routes answer the same generic response whether or not
// a dependency failed, so this is the only place a failure shows. Each event:
//   * writes one content-free line to the private runtime log: a closed kind
//     and this instance's running count for it, nothing else;
//   * raises at most one alert per kind per window in the private ug-alerts
//     Slack channel, carrying how many events of that kind this instance saw
//     since its last alert. A sustained failure is one alert a window, never
//     one alert per event.
//
// Boundaries: no recipient, address, token, link, request body or provider
// response reaches the log or the alert (the text is built from the closed
// vocabulary below and integers, then checked by assertMetadataOnlyAlert).
// The post runs after the response through waitUntil, every failure is
// swallowed, and without UG_ALERTS_SLACK_WEBHOOK_URL only the log line is
// written. Counts and windows are per warm instance, like the platform AI
// alerts: a burst across cold instances may post a few duplicates.

export const ACCOUNT_MAIL_ALERT_WINDOW_MS = 30 * 60_000;
const HEADLINES = Object.freeze({
  signup_confirmation_send_failed: "A signup confirmation email could not be handed to the mail provider",
  signup_turnstile_unavailable: "The Turnstile check could not be completed during signup (service unreachable or refused the request)",
  reset_send_failed: "A password reset email could not be handed to the mail provider",
  reset_send_unconfirmed: "The answer deadline passed before the mail provider confirmed a password reset email, so whether it was sent is unknown",
  recovery_notice_send_failed: "The email telling a member that one of their recovery codes was used could not be handed to the mail provider",
  provider_bounced: "The mail provider reported a bounced email",
  provider_failed: "The mail provider reported an email it failed to send",
  provider_suppressed: "The mail provider suppressed an email to a previously bounced or complaining address",
  provider_complained: "The mail provider reported a spam complaint",
  provider_delivery_delayed: "The mail provider reported a delayed delivery",
});
export const ACCOUNT_MAIL_FAILURE_KINDS = Object.freeze(Object.keys(HEADLINES));

const counts = new Map();
const unreported = new Map();
const lastPostedAt = new Map();

export function resetAccountMailAlerts() {
  counts.clear();
  unreported.clear();
  lastPostedAt.clear();
}

function easternTime(now) {
  return `${now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: true })} ET`;
}

export function buildAccountMailAlertText(kind, events, environment, now = new Date()) {
  if (!ACCOUNT_MAIL_FAILURE_KINDS.includes(kind)) throw new Error("unknown account mail failure kind");
  const count = Number.isSafeInteger(events) && events > 0 ? events : 1;
  const lines = [
    `Union Ground signup and account mail — FAILURE (${environment === "production" ? "production" : "preview"})`,
    HEADLINES[kind],
    `kind: ${kind} | events on this instance since its last alert: ${count}`,
    `observed: ${easternTime(now)} (${now.toISOString()})`,
    "The visitor saw the same response. Check account-mail job logs and the mail provider status for this failure kind.",
  ];
  return assertMetadataOnlyAlert(lines.join("\n"));
}

async function postAlert(kind, { env, fetchImpl, now }) {
  try {
    const webhook = parseAlertWebhookUrl(env[ALERT_WEBHOOK_ENV_VAR]);
    if (!webhook) return "disabled";
    const previous = lastPostedAt.get(kind);
    if (Number.isFinite(previous) && now.getTime() - previous < ACCOUNT_MAIL_ALERT_WINDOW_MS) return "throttled";
    const events = unreported.get(kind) || 1;
    const text = buildAccountMailAlertText(kind, events, env.VERCEL_ENV, now);
    // Claim the window before the request so overlapping events on one
    // instance cannot both post; release it when nothing was delivered.
    lastPostedAt.set(kind, now.getTime());
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
    } catch {
      lastPostedAt.delete(kind);
      return "failed";
    }
    if (!response?.ok) {
      lastPostedAt.delete(kind);
      return "rejected";
    }
    unreported.set(kind, Math.max(0, (unreported.get(kind) || 0) - events));
    return "posted";
  } catch {
    return "failed";
  }
}

// Records one failure. Synchronous for the caller: it never throws, never
// waits on the network and never changes the caller's answer or timing.
// Returns the alert outcome promise (posted, disabled, throttled, rejected,
// failed) so tests can await it; null for a kind outside the vocabulary.
export function recordAccountMailFailure(kind, {
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  waitUntilImpl = waitUntil,
} = {}) {
  if (!ACCOUNT_MAIL_FAILURE_KINDS.includes(kind)) return null;
  const count = (counts.get(kind) || 0) + 1;
  counts.set(kind, count);
  unreported.set(kind, (unreported.get(kind) || 0) + 1);
  try { console.warn(JSON.stringify({ event: "account-mail-failure", kind, count })); } catch { /* logging must not fail the route */ }
  const pending = postAlert(kind, { env, fetchImpl, now });
  try { waitUntilImpl(pending); } catch { /* outside the Vercel runtime */ }
  return pending;
}
