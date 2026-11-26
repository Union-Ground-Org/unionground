import { isDemoHost } from "./demoOrigin.js";

// The Product analytics switch, the demo's ?sg_analytics= command and the
// abort signal workspace page views wait on. Vendor-free, so the entry chunk
// honors the switch before src/lib/observability.js (Sentry and PostHog) has
// loaded; both modules share this one state.
export const DEMO_ANALYTICS_PREFERENCE_KEY = "sg-demo-analytics-disabled";
const DEMO_ANALYTICS_QUERY_KEY = "sg_analytics";

export function defaultBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: this browser's Product
// analytics switch governs every product-analytics producer on this website
// (workspace page views, and PostHog on the public demo). The stored key is the
// authority, shared by every tab; a choice the browser refused to save holds
// for this page; an unreadable store counts as off.
const unsavedChoices = new WeakMap();
let unsavedChoiceWithoutStorage = null;
let analyticsAbort = new AbortController();

function rememberChoice(storage, disabled, saved) {
  if (!storage) unsavedChoiceWithoutStorage = saved ? null : disabled;
  else if (saved) unsavedChoices.delete(storage);
  else unsavedChoices.set(storage, disabled);
}

function analyticsDisabled(storage) {
  const unsaved = storage ? unsavedChoices.get(storage) : unsavedChoiceWithoutStorage;
  if (typeof unsaved === "boolean") return unsaved;
  if (!storage) return true;
  try {
    return storage.getItem(DEMO_ANALYTICS_PREFERENCE_KEY) === "true";
  } catch {
    return true;
  }
}

function writeAnalyticsPreference(storage, disabled) {
  if (!storage) return false;
  try {
    if (disabled) storage.setItem(DEMO_ANALYTICS_PREFERENCE_KEY, "true");
    else storage.removeItem(DEMO_ANALYTICS_PREFERENCE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isDemoAnalyticsEnabled({ storage = defaultBrowserStorage() } = {}) {
  return !analyticsDisabled(storage);
}

// Returns whether the choice was saved; one the browser refused to save still
// holds for this page.
export function recordAnalyticsChoice(storage, disabled) {
  const saved = writeAnalyticsPreference(storage, disabled);
  rememberChoice(storage, disabled, saved);
  return saved;
}

// Aborted the moment analytics is turned off, so a page-view request still
// waiting on authentication never reaches the network.
export function productAnalyticsSignal() {
  return analyticsAbort.signal;
}

export function setProductAnalyticsSignal(enabled) {
  if (!enabled) analyticsAbort.abort();
  else if (analyticsAbort.signal.aborted) analyticsAbort = new AbortController();
}

// Settings follows the switch through this, so a change made in another tab
// shows on a Settings page that is already open.
const analyticsListeners = new Set();

export function subscribeDemoAnalytics(listener) {
  analyticsListeners.add(listener);
  return () => { analyticsListeners.delete(listener); };
}

export function notifyDemoAnalyticsListeners() {
  analyticsListeners.forEach((listener) => listener());
}

export function applyDemoAnalyticsPreferenceFromUrl({
  location = typeof window === "undefined" ? null : window.location,
  history = typeof window === "undefined" ? null : window.history,
  storage = defaultBrowserStorage(),
  hostname = null,
} = {}) {
  if (!location?.href) return null;

  let url;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }

  const requested = url.searchParams.get(DEMO_ANALYTICS_QUERY_KEY)?.trim().toLowerCase();
  if (requested !== "off" && requested !== "on") return null;

  // Only the public demo honors the URL command; elsewhere the parameter is
  // stripped and the member's Settings switch alone decides.
  const command = isDemoHost(hostname ?? url.hostname) ? requested : null;
  if (command) {
    recordAnalyticsChoice(storage, command === "off");
  }

  url.searchParams.delete(DEMO_ANALYTICS_QUERY_KEY);
  try {
    history?.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Analytics policy must not break navigation in storage/history-restricted browsers.
  }
  return command;
}
