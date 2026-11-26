import {
  applyDemoAnalyticsPreferenceFromUrl,
  DEMO_ANALYTICS_PREFERENCE_KEY,
  defaultBrowserStorage,
  isDemoAnalyticsEnabled,
  notifyDemoAnalyticsListeners,
  recordAnalyticsChoice,
  setProductAnalyticsSignal,
} from "./analyticsPreference.js";
import { analyticsFlagValue } from "./posthogPrivacy.js";

export { isDemoAnalyticsEnabled, productAnalyticsSignal, subscribeDemoAnalytics } from "./analyticsPreference.js";

// PERF-UG-FIRST-PAINT-OBSERVABILITY-DEFER-AND-CSS-SPLIT-20261028: Sentry
// and PostHog (src/lib/observability.js and the vendor-observability chunk) are
// off the first paint. They load through a dynamic import once the
// authenticated shell commits, or when the browser is idle on a public page or
// after an error. Calls made before then wait here, at most
// OBSERVABILITY_QUEUE_LIMIT of them, and replay in order through the same
// functions, so every privacy scrub and consent check applies exactly as if
// they had run at once.
export const OBSERVABILITY_QUEUE_LIMIT = 100;

const CONTEXT = "syncObservabilityContext";
const ANALYTICS_CALLS = new Set(["captureProductAction", "captureDemoAction"]);

let runtime = null;
let loading = null;
let idleScheduled = false;
let earlyListeners = false;
const queue = [];
const flagListeners = new Set();

// Each entry is [kind, call]; call(runtime) makes the same call later.
function enqueue(name, call) {
  if (queue.length >= OBSERVABILITY_QUEUE_LIMIT) {
    // Drop the oldest capture rather than a context change, so the captures
    // that remain replay under the context they were raised in.
    const oldestCapture = queue.findIndex(([entry]) => entry !== CONTEXT);
    queue.splice(Math.max(oldestCapture, 0), 1);
  }
  queue.push([name, call]);
}

function forward(name, call) {
  if (runtime) return call(runtime);
  enqueue(name, call);
  return false;
}

export function startObservability() {
  loading ??= import("./observability.js").then(async (module) => {
    try { module.initObservability(); } catch { /* monitoring never breaks the page */ }
    module.subscribeMemberFeatureFlags(() => flagListeners.forEach((listener) => listener()));
    stopEarlyListeners();
    while (queue.length) {
      const [name, call] = queue.shift();
      // A member action needs the hashed identity its replayed context has
      // just requested; calls made meanwhile queue behind it, in order.
      if (name === "captureProductAction") await module.memberIdentitySettled();
      try { call(module); } catch { /* monitoring never breaks the page */ }
    }
    runtime = module;
    return true;
  }, () => {
    // A chunk that failed to load is tried again on the next trigger.
    loading = null;
    return false;
  });
  return loading;
}

function startWhenIdle() {
  if (loading || idleScheduled || typeof window === "undefined") return;
  idleScheduled = true;
  const start = () => {
    idleScheduled = false;
    startObservability();
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start, { timeout: 3000 });
  else window.setTimeout(start, 1);
}

// Uncaught errors before the SDK has installed its own handlers.
function captureEarlyError(event) {
  const error = event.type === "unhandledrejection" ? event.reason : event.error;
  if (error == null) return;
  enqueue("captureViewError", (module) => module.captureViewError(error));
  startWhenIdle();
}

// Another tab changed the Product analytics switch before the runtime (and its
// own storage listener) loaded: nothing queued under the earlier choice may be
// sent under a later one, so queued analytics is discarded either way.
function followStoredChoice(event) {
  if (event.key !== null && event.key !== DEMO_ANALYTICS_PREFERENCE_KEY) return;
  discardQueuedAnalytics();
  setProductAnalyticsSignal(isDemoAnalyticsEnabled());
  notifyDemoAnalyticsListeners();
}

function stopEarlyListeners() {
  if (!earlyListeners) return;
  window.removeEventListener("error", captureEarlyError);
  window.removeEventListener("unhandledrejection", captureEarlyError);
  window.removeEventListener("storage", followStoredChoice);
  earlyListeners = false;
}

// main.jsx, before the first render: the demo's ?sg_analytics= command is
// applied (and stripped from the address) now, as initObservability did.
export function bootObservability() {
  applyDemoAnalyticsPreferenceFromUrl();
  if (typeof window === "undefined" || earlyListeners || runtime) return;
  window.addEventListener("error", captureEarlyError);
  window.addEventListener("unhandledrejection", captureEarlyError);
  window.addEventListener("storage", followStoredChoice);
  earlyListeners = true;
}

export function syncObservabilityContext(context = {}) {
  if (runtime) return runtime.syncObservabilityContext(context);
  enqueue(CONTEXT, (module) => module.syncObservabilityContext(context));
  // A member's session waits for the shell (startObservability); a settled
  // page with no member session is public and loads when idle.
  if (!context.authPending && !context.userId) startWhenIdle();
}

export function captureProductAction(action) {
  if (!runtime && !isDemoAnalyticsEnabled()) return false;
  return forward("captureProductAction", (module) => module.captureProductAction(action));
}

export function captureDemoAction(action, view = null) {
  if (!runtime && !isDemoAnalyticsEnabled()) return false;
  return forward("captureDemoAction", (module) => module.captureDemoAction(action, view));
}

// Diagnostics and errors are worth loading the runtime for.
function report(name, call) {
  if (!runtime) startWhenIdle();
  return forward(name, call);
}

export function captureSanitizedDiagnostic(diagnostic) {
  return report("captureSanitizedDiagnostic", (module) => module.captureSanitizedDiagnostic(diagnostic));
}

export function captureViewError(error) {
  return report("captureViewError", (module) => module.captureViewError(error));
}

// Queued analytics and every context but the latest go; diagnostics stay.
function discardQueuedAnalytics() {
  let latestContextKept = false;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const [name] = queue[index];
    if (name === CONTEXT && !latestContextKept) latestContextKept = true;
    else if (ANALYTICS_CALLS.has(name) || name === CONTEXT) queue.splice(index, 1);
  }
}

// Returns the new switch state. Before the SDK loads the choice is saved here
// and initObservability reads it; queued analytics from before the change is
// discarded, and only the latest context is kept, so nothing raised under the
// previous choice is sent under the new one.
export function setDemoAnalyticsEnabled(enabled, options = {}) {
  if (runtime) return runtime.setDemoAnalyticsEnabled(enabled, options);
  const { storage = defaultBrowserStorage(), onSaved = null } = options;
  const saved = recordAnalyticsChoice(storage, !enabled);
  onSaved?.(saved);
  discardQueuedAnalytics();
  setProductAnalyticsSignal(enabled);
  notifyDemoAnalyticsListeners();
  return Boolean(enabled);
}

// Member feature flags (#6248): each flag reads its default until the runtime
// has loaded and PostHog has served this member a value. An exposure is only
// ever recorded for a served value, so none is owed before then.
export function memberFeatureFlag(key) {
  return runtime ? runtime.memberFeatureFlag(key) : analyticsFlagValue(null, key);
}

export function subscribeMemberFeatureFlags(listener) {
  flagListeners.add(listener);
  return () => { flagListeners.delete(listener); };
}

export function reportMemberFlagExposure(key) {
  return runtime ? runtime.reportMemberFlagExposure(key) : false;
}
