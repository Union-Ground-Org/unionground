// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014).
//
// Shared by the web slot and the native hook. The old app (de7df4b57c^
// lib/contextual-pulse/contexts.ts and components/contextual-pulse/
// contextual-pulse-slot.tsx) asked a staff-written quick check once a member
// had read a contract, rights, Q&A or issue-thread page for 20 seconds OR
// scrolled half of it, never on report, retaliation, grievance-filing or
// account-recovery pages, and at most once per browser session. The server
// (public.evaluate_contextual_pulse_in_context) enforces every rule; these
// helpers only decide when the client asks.
import { featureLimit, isFeatureEnabled } from "../../lib/featureSwitches.js";

const PULSE_SWITCH_KEY = "features.engagement_voice.contextual_pulses";
const PULSE_DWELL_LIMIT_KEY = "limits.engagement_voice.pulse_dwell_seconds";
const PULSE_SCROLL_LIMIT_KEY = "limits.engagement_voice.pulse_scroll_percent";

/** @typedef {{ enabled: boolean, dwellSeconds: number, scrollPercent: number }} PulseSettings */

// The registered definitions' defaults (old contexts.ts:17-20, 0258:2-9).
/** @type {Readonly<PulseSettings>} */
export const PULSE_DEFAULTS = Object.freeze({ enabled: false, dwellSeconds: 20, scrollPercent: 50 });

// Every screen a staff prompt may target, in picker order. Mirrors
// private.contextual_pulse_context_class(): "voice" is the Voice-page prompt
// that works today; "product" screens are the restored reading screens.
export const PULSE_CONTEXTS = Object.freeze([
  Object.freeze({ key: "voice.open", kind: "voice" }),
  Object.freeze({ key: "contract.page", kind: "product" }),
  Object.freeze({ key: "rights.page", kind: "product" }),
  Object.freeze({ key: "qa.detail", kind: "product" }),
  Object.freeze({ key: "issue-thread.detail", kind: "product" }),
]);

export const DEFAULT_PULSE_CONTEXT = "voice.open";

// Never a quick check here (old PULSE_CONTEXT_CLASSIFICATIONS 'blocked' plus
// today's case, report and step-up screens). The server refuses them too.
export const BLOCKED_PULSE_CONTEXTS = Object.freeze([
  "report-issue.form",
  "retaliation.report",
  "grievance.filing",
  "account.recovery",
  "case.detail",
  "case.updated",
  "mfa.challenge",
]);

// Product hub thread kinds that are reading screens. Case and intake threads
// carry casework and reports; task threads are work items.
export const PULSE_HUB_THREAD_KINDS = Object.freeze(["topic", "issue", "decision"]);

export const PULSE_SESSION_STORAGE_KEY = "contextual_pulse_session_key";
export const PULSE_SESSION_USED_STORAGE_KEY = "contextual_pulse_session_used";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPulseContextKey(key) {
  return PULSE_CONTEXTS.some((context) => context.key === key);
}

export function isProductPulseContext(key) {
  return PULSE_CONTEXTS.some((context) => context.key === key && context.kind === "product");
}

export function isBlockedPulseContext(key) {
  return BLOCKED_PULSE_CONTEXTS.includes(key);
}

// The i18n key for a context's readable label; unknown keys have none.
export function pulseContextLabelKey(key) {
  // i18n keys are [\w.] only, so the hyphen in issue-thread becomes "_".
  return isPulseContextKey(key) ? `engagement.pulseContext.${key.replaceAll("-", "_")}` : null;
}

/** @returns {PulseSettings} */
export function pulseSettings(configuration) {
  return {
    enabled: isFeatureEnabled(configuration, PULSE_SWITCH_KEY, PULSE_DEFAULTS.enabled),
    dwellSeconds: featureLimit(configuration, PULSE_DWELL_LIMIT_KEY, PULSE_DEFAULTS.dwellSeconds),
    scrollPercent: featureLimit(configuration, PULSE_SCROLL_LIMIT_KEY, PULSE_DEFAULTS.scrollPercent),
  };
}

// Old slot: evaluate once the dwell OR the scroll threshold is met.
/**
 * @param {{ dwellSeconds?: number, scrollPercent?: number }} [reading]
 * @param {{ dwellSeconds: number, scrollPercent: number }} [settings]
 */
export function pulseThresholdMet({ dwellSeconds = 0, scrollPercent = 0 } = {}, settings = PULSE_DEFAULTS) {
  return dwellSeconds >= settings.dwellSeconds || scrollPercent >= settings.scrollPercent;
}

// Percent of a scrollable surface already scrolled past, 0..100. A surface
// that cannot scroll reports 0 so the dwell time decides.
export function scrollPercentOf({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const scrollable = scrollHeight - clientHeight;
  if (!(scrollable > 0)) return 0;
  const percent = Math.round((Math.max(0, scrollTop) / scrollable) * 100);
  return Math.max(0, Math.min(100, percent));
}

function isPulseSessionKey(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// Keep failed storage writes for the page lifetime, across slot remounts.
// Storage adapters remain independent; absent storage shares one page state.
const pulseFallbacks = new WeakMap();
const absentStoragePulse = { key: null, used: false, memoryOnly: true };
function pulseFallback(storage) {
  if (!storage) return absentStoragePulse;
  if (!pulseFallbacks.has(storage)) pulseFallbacks.set(storage, { key: null, used: false, memoryOnly: false });
  return pulseFallbacks.get(storage);
}

// One key per browser tab session (old getSessionKey). Storage failures fall
// back to a key for this page life only.
export function pulseSessionKey(storage, randomUUID) {
  const fallback = pulseFallback(storage);
  let existing;
  let readFailed = !storage;
  try { existing = storage?.getItem(PULSE_SESSION_STORAGE_KEY) ?? null; } catch { readFailed = true; }
  if (isPulseSessionKey(existing)) { fallback.key = existing; return existing; }
  const next = (readFailed || fallback.memoryOnly) && fallback.key ? fallback.key : randomUUID();
  if (fallback.key !== next) fallback.used = false;
  fallback.key = next;
  try { storage?.setItem(PULSE_SESSION_STORAGE_KEY, next); } catch { fallback.memoryOnly = true; }
  return next;
}

export function pulseSessionUsed(storage) {
  const fallback = pulseFallback(storage);
  try { return storage?.getItem(PULSE_SESSION_USED_STORAGE_KEY) === "1" || (fallback.memoryOnly && fallback.used); } catch { return fallback.used; }
}

export function markPulseSessionUsed(storage) {
  const fallback = pulseFallback(storage);
  fallback.used = true;
  try { storage?.setItem(PULSE_SESSION_USED_STORAGE_KEY, "1"); } catch { fallback.memoryOnly = true; }
}

// The server answers { eligible, reason } or null (no organization). Only an
// eligible answer with a question and at least two options renders.
export function normalizePulseDecision(value) {
  if (!value || typeof value !== "object" || value.eligible !== true) {
    return { eligible: false, reason: typeof value?.reason === "string" ? value.reason : null, prompt: null };
  }
  const options = Array.isArray(value.options) ? value.options : [];
  if (typeof value.eventId !== "string" || typeof value.question !== "string" || options.length < 2) {
    return { eligible: false, reason: "malformed", prompt: null };
  }
  return {
    eligible: true,
    reason: null,
    prompt: { eventId: value.eventId, promptId: value.promptId ?? null, question: value.question, options, contextKey: value.contextKey ?? null },
  };
}

// A decision that ends asking for the rest of this session.
export function pulseDecisionEndsSession(decision) {
  return decision?.eligible === true || decision?.reason === "session_already_used";
}
