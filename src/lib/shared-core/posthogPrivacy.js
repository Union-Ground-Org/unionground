// PostHog error tracking under the same content-free policy as sentryPrivacy.js
// (owner order, October 27, 2026: PostHog error tracking replaces Sentry).
// Shared by browser, server and React Native. A `$exception` event is rebuilt
// from an allowlist; every other event on a diagnostics-only surface is dropped,
// because a key blacklist cannot detect a person's name or grievance in
// arbitrary text, a URL or a stack frame's function name.
const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
const LEVELS = new Set(["fatal", "error", "warning", "info", "debug", "log"]);
const SURFACES = new Set(["web", "api", "ios", "android"]);
const ENVIRONMENTS = new Set(["production", "preview", "development"]);
// The frame platforms PostHog's exception processor (cymbal) reads for the
// JavaScript SDKs this product runs: posthog-js and posthog-react-native off
// Hermes, posthog-node, and posthog-react-native on Hermes. Cymbal picks the
// frame schema from this tag, so a missing or other label fails the whole
// event; such a frame is dropped instead.
const FRAME_PLATFORMS = new Set(["web:javascript", "node:javascript", "hermes"]);
// Each of those schemas requires a function name and the Node and Hermes ones
// a file name (BUG-UG-POSTHOG-EXCEPTION-FRAMES-MISSING-FUNCTION-20261102,
// #6826: without them every event failed with "missing field function").
// Both are fixed placeholders, never derived from the frame.
const FRAME_FILENAME = "app:///application";
const FRAME_FUNCTION = "?";
const SDK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SDK_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{0,32})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const API_KEY = /^[A-Za-z0-9_]{1,80}$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
// Only these ingest paths carry events; flags, remote config, surveys and
// engage requests never leave a diagnostics-only surface.
const INGEST_PATH = /^\/(?:batch|capture|e)\/?$/;

// Every `$exception` carries one person, the surface itself, so no visitor,
// member or device identity is minted for an error.
export const DIAGNOSTICS_DISTINCT_ID = "diagnostics";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coordinate(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
}

function sanitizeFrame(frame) {
  if (!record(frame) || !FRAME_PLATFORMS.has(frame.platform)) return null;
  const clean = {};
  if (coordinate(frame.lineno)) clean.lineno = frame.lineno;
  if (coordinate(frame.colno)) clean.colno = frame.colno;
  if (typeof frame.in_app === "boolean") clean.in_app = frame.in_app;
  if (!Object.keys(clean).length) return null;
  // Paths, function names, source lines, module names and local variables can
  // carry user data. Keep coarse positions under the fixed file and function
  // placeholders; keep the SDK's frame platform label so PostHog parses it.
  clean.filename = FRAME_FILENAME;
  clean.function = FRAME_FUNCTION;
  clean.platform = frame.platform;
  return clean;
}

function sanitizeException(entry) {
  if (!record(entry)) return null;
  const clean = { type: ERROR_TYPES.has(entry.type) ? entry.type : "Error", value: "Application error" };
  if (record(entry.mechanism) && typeof entry.mechanism.handled === "boolean") clean.mechanism = { handled: entry.mechanism.handled };
  const frames = Array.isArray(entry.stacktrace?.frames) ? entry.stacktrace.frames.slice(-50).map(sanitizeFrame).filter(Boolean) : [];
  if (frames.length) clean.stacktrace = { type: "raw", frames };
  return clean;
}

function timestampOf(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return typeof value === "string" && ISO_TIME.test(value) ? value : undefined;
}

// A `$exception` event rebuilt from the allowlist, or null for anything else.
// The result carries the same shape every PostHog SDK sends: the event name,
// a fixed distinct id, an optional uuid and timestamp, and properties holding
// only the exception list, its level, the SDK identity, the surface metadata
// given at initialization, and the flags that stop person profiles and
// network-address geolocation. No URL, referrer, screen, browser, device,
// session, window, pageview, person, group, feature-flag or caller property
// survives, whatever the SDK or a caller added.
export function sanitizePostHogExceptionEvent(event, metadata = {}) {
  try {
    if (!record(event) || event.event !== "$exception" || !record(event.properties)) return null;
    const source = event.properties;
    const list = Array.isArray(source.$exception_list) ? source.$exception_list.slice(0, 10).map(sanitizeException).filter(Boolean) : [];
    if (!list.length) return null;
    const properties = {
      $exception_list: list,
      $exception_level: LEVELS.has(source.$exception_level) ? source.$exception_level : "error",
      $process_person_profile: false,
      $geoip_disable: true,
      distinct_id: DIAGNOSTICS_DISTINCT_ID,
    };
    if (typeof source.$exception_handled === "boolean") properties.$exception_handled = source.$exception_handled;
    // The project token is public and the browser SDK drops an event whose
    // properties lose it after before_send; it names the project, not a person.
    if (typeof source.token === "string" && API_KEY.test(source.token)) properties.token = source.token;
    if (typeof source.$lib === "string" && SDK_NAME.test(source.$lib)) properties.$lib = source.$lib;
    if (typeof source.$lib_version === "string" && SDK_VERSION.test(source.$lib_version)) properties.$lib_version = source.$lib_version;
    if (SURFACES.has(metadata.surface)) properties.surface = metadata.surface;
    if (ENVIRONMENTS.has(metadata.environment)) properties.deployment_environment = metadata.environment;
    if (/^[a-f0-9]{40}$/.test(metadata.release || "")) properties.release = metadata.release;
    const clean = { event: "$exception", distinct_id: DIAGNOSTICS_DISTINCT_ID, properties };
    const uuid = typeof event.uuid === "string" && UUID.test(event.uuid) ? event.uuid : undefined;
    if (uuid) clean.uuid = uuid;
    const timestamp = timestampOf(event.timestamp);
    if (timestamp) clean.timestamp = timestamp;
    return clean;
  } catch {
    // Throwing getters, malformed SDK data or an unexpected shape fail closed.
    return null;
  }
}

// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
// (#6247): pseudonymous product analytics, rebuilt from an allowlist like the
// exception events. A member event carries only a one-way hash of the user
// identifier as its distinct id, a one-way hash of the organization identifier
// as its group, a view label and, for an action, one allowlisted label; never a
// name, email, free text, real URL, device or person property. A public-page
// view carries PostHog's cookieless marker and a path, and nothing that could
// identify the visitor. Everything else is dropped.
export const ANALYTICS_ACTIONS = Object.freeze(["save", "queued_offline"]);
const ANALYTICS_ACTION_SET = new Set(ANALYTICS_ACTIONS);
const ANALYTICS_EVENTS = new Set(["$pageview", "$screen", "product_action", "$feature_flag_called", "$$heatmap"]);
const PSEUDONYM = /^[a-f0-9]{64}$/;
const VIEW_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_PATH = /^\/[a-z0-9/_-]{0,120}$/;
export const COOKIELESS_DISTINCT_ID = "$posthog_cookieless";

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// the feature flags the web client, the server API and the mobile apps may
// read. Each names its default, which every surface returns when PostHog is
// unreachable, analytics is off or the flag answers anything else, and the
// only values that may leave in an exposure event. member-coach-mark is the
// experiment-ready flag: "control" keeps the onboarding coach mark, "test"
// withholds it. member-default-view (REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030)
// is the web member default view: "control" keeps today's shell, "alt" lands
// a member in the alternate site shell.
export const ANALYTICS_FLAGS = Object.freeze({
  "member-coach-mark": Object.freeze({ default: "control", values: Object.freeze(["control", "test"]) }),
  "member-default-view": Object.freeze({ default: "control", values: Object.freeze(["control", "alt"]) }),
});

function flagAllowed(key, value) {
  return Object.prototype.hasOwnProperty.call(ANALYTICS_FLAGS, key) && ANALYTICS_FLAGS[key].values.includes(value);
}

// A flag's value from a map of evaluated values, or its default.
export function analyticsFlagValue(values, key) {
  if (!Object.prototype.hasOwnProperty.call(ANALYTICS_FLAGS, key)) return undefined;
  const value = record(values) && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
  return flagAllowed(key, value) ? value : ANALYTICS_FLAGS[key].default;
}

// The body of the one /flags request a client makes per identity: the project
// token, the same two hashes the analytics events carry, and the flag keys.
// No person or group property, device, URL or network location is sent.
export function analyticsFlagsRequest(token, identity) {
  if (typeof token !== "string" || !API_KEY.test(token) || !record(identity) || !PSEUDONYM.test(identity.distinctId ?? "")) return null;
  const body = { token, distinct_id: identity.distinctId, geoip_disable: true, flag_keys_to_evaluate: Object.keys(ANALYTICS_FLAGS) };
  if (PSEUDONYM.test(identity.organization ?? "")) body.groups = { organization: identity.organization };
  return body;
}

// The allowlisted values of a /flags (v1 or v2) response; anything else, or a
// response flagged as degraded, is absent, so every read falls to the default.
export function analyticsFlagsFromResponse(response) {
  const values = {};
  if (!record(response) || response.errorsWhileComputingFlags === true || response.quotaLimited?.length) return values;
  for (const key of Object.keys(ANALYTICS_FLAGS)) {
    const v2 = record(response.flags) ? response.flags[key] : undefined;
    const value = record(v2) ? (v2.enabled === true ? v2.variant ?? true : false) : record(response.featureFlags) ? response.featureFlags[key] : undefined;
    if (flagAllowed(key, value)) values[key] = value;
  }
  return values;
}

const HEATMAP_TYPES = new Set(["click", "rageclick", "deadclick", "mousemove"]);

function memberRoute(path) {
  return path === "/m" || path.startsWith("/m/");
}

// A public page's address on its own origin, or null: never a member route, a
// query, a fragment or an identifier-shaped segment.
function publicPageUrl(value, origin) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const path = url.pathname.toLowerCase();
  if (url.origin !== origin || !PUBLIC_PATH.test(path) || memberRoute(path) || /[0-9a-f]{8}-[0-9a-f]{4}/.test(path)) return null;
  return `${origin}${path}`;
}

// Heatmap points: positions, whether the target was fixed, and the kind of
// pointer event. The SDK records no text or element here; nothing else stays.
function heatmapData(source, origin) {
  if (!record(source)) return null;
  const data = {};
  let count = 0;
  for (const [address, points] of Object.entries(source).slice(0, 10)) {
    const url = publicPageUrl(address, origin);
    if (!url || !Array.isArray(points)) continue;
    const clean = points.slice(0, 200).filter((point) => record(point) && Number.isFinite(point.x) && Number.isFinite(point.y) && HEATMAP_TYPES.has(point.type))
      .map((point) => ({ x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)), target_fixed: point.target_fixed === true, type: point.type }));
    if (!clean.length) continue;
    data[url] = [...(data[url] ?? []), ...clean];
    count += clean.length;
  }
  return count ? data : null;
}

function viewLabel(value) {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VIEW_LABEL.test(label) ? label : null;
}

// Hex SHA-256 of a fixed prefix and the identifier; each platform supplies its
// own digest (Web Crypto, expo-crypto).
export const ANALYTICS_PSEUDONYM_PREFIX = "unionground-analytics:v1:";

// metadata.identity is { distinctId, organization } for a member, or null for a
// public-page visitor on a cookieless surface (metadata.cookieless).
export function sanitizePostHogAnalyticsEvent(event, metadata = {}) {
  try {
    if (!record(event) || !ANALYTICS_EVENTS.has(event.event) || !record(event.properties)) return null;
    const source = event.properties;
    const identity = metadata.identity;
    const properties = { $process_person_profile: false, $geoip_disable: true };
    let distinctId;
    if (record(identity) && PSEUDONYM.test(identity.distinctId ?? "")) {
      distinctId = identity.distinctId;
      const view = viewLabel(source.view);
      if (!view) return null;
      properties.app_surface = "member";
      properties.view = view;
      if (event.event === "$$heatmap") return null;
      if (event.event === "product_action") {
        if (!ANALYTICS_ACTION_SET.has(source.action)) return null;
        properties.action = source.action;
      }
      // An experiment exposure (#6248): the flag key and the value served, and
      // only for a flag and value on the allowlist.
      if (event.event === "$feature_flag_called") {
        const key = source.$feature_flag;
        if (!flagAllowed(key, source.$feature_flag_response)) return null;
        properties.$feature_flag = key;
        properties.$feature_flag_response = source.$feature_flag_response;
        properties[`$feature/${key}`] = source.$feature_flag_response;
      }
      if (PSEUDONYM.test(identity.organization ?? "")) properties.$groups = { organization: identity.organization };
    } else if (metadata.cookieless === true && identity == null && (event.event === "$pageview" || event.event === "$$heatmap")) {
      // Cookieless: PostHog derives a daily, salted visitor hash on its servers.
      distinctId = COOKIELESS_DISTINCT_ID;
      properties.$cookieless_mode = true;
      properties.app_surface = "public_site";
      const origin = ORIGIN.test(String(metadata.origin ?? "")) ? metadata.origin : null;
      if (!origin) return null;
      if (event.event === "$$heatmap") {
        // Public-page heatmaps (#6248): pointer positions on public pages only,
        // with the window size PostHog needs to place them.
        const data = heatmapData(source.$heatmap_data, origin);
        if (!data) return null;
        properties.$heatmap_data = data;
        for (const key of ["$viewport_width", "$viewport_height"]) if (coordinate(source[key])) properties[key] = source[key];
        const page = new URL(Object.keys(data)[0]);
        properties.$pathname = page.pathname;
        properties.$host = page.host;
        properties.$current_url = page.href;
      } else {
        const path = typeof source.$pathname === "string" ? source.$pathname.toLowerCase() : "";
        if (!PUBLIC_PATH.test(path) || /[0-9a-f]{8}-[0-9a-f]{4}/.test(path)) return null;
        properties.$pathname = path;
        properties.$host = new URL(origin).host;
        properties.$current_url = `${origin}${path}`;
      }
    } else {
      return null;
    }
    properties.distinct_id = distinctId;
    if (typeof source.token === "string" && API_KEY.test(source.token)) properties.token = source.token;
    if (typeof source.$lib === "string" && SDK_NAME.test(source.$lib)) properties.$lib = source.$lib;
    if (typeof source.$lib_version === "string" && SDK_VERSION.test(source.$lib_version)) properties.$lib_version = source.$lib_version;
    if (SURFACES.has(metadata.surface)) properties.surface = metadata.surface;
    if (ENVIRONMENTS.has(metadata.environment)) properties.deployment_environment = metadata.environment;
    if (/^[a-f0-9]{40}$/.test(metadata.release || "")) properties.release = metadata.release;
    const clean = { event: event.event, distinct_id: distinctId, properties };
    if (typeof event.uuid === "string" && UUID.test(event.uuid)) clean.uuid = event.uuid;
    const timestamp = timestampOf(event.timestamp);
    if (timestamp) clean.timestamp = timestamp;
    return clean;
  } catch {
    return null;
  }
}

// The events of one batch request that may leave a diagnostics-only surface.
// With metadata.analyticsIdentity (a function returning the member identity,
// or null while analytics is off or no member is signed in), the allowlisted
// analytics events pass too. Each such event carries the identity it was
// captured under ($ug_member, $ug_organization, $ug_generation); a queued or
// retried event whose capture identity or consent generation no longer
// matches the current one is dropped, never sent under another member,
// organization or consent period (#6432 round 3).
export function sanitizePostHogDiagnosticsBatch(batch, metadata = {}) {
  if (!Array.isArray(batch)) return [];
  const analytics = typeof metadata.analyticsIdentity === "function" ? metadata.analyticsIdentity : null;
  let identity;
  return batch.slice(0, 100).map((event) => {
    if (!analytics || event?.event === "$exception") return sanitizePostHogExceptionEvent(event, metadata);
    if (identity === undefined) {
      try { identity = analytics() ?? null; } catch { identity = null; }
    }
    if (!identity || !capturedUnder(event, identity)) return null;
    return sanitizePostHogAnalyticsEvent(event, { ...metadata, identity });
  }).filter(Boolean);
}

function capturedUnder(event, identity) {
  const source = record(event) && record(event.properties) ? event.properties : {};
  return typeof source.$ug_member === "string" && source.$ug_member === identity.distinctId
    && (source.$ug_organization ?? null) === (identity.organization ?? null)
    && typeof identity.generation === "string" && source.$ug_generation === identity.generation;
}

function bodyText(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return null;
}

const emptyResponse = () => ({ status: 200, ok: true, text: async () => "{}", json: async () => ({}) });

// A fetch for the Node and React Native SDKs that rewrites every request on its
// way out: only ingest paths pass, each body is rebuilt around the sanitized
// batch, a compressed or unparsable body is discarded, and a batch with no
// `$exception` left is never sent. The SDK's other endpoints (feature flags,
// remote config, surveys) are answered locally with an empty document. The
// relay (workers/posthog-proxy) refuses an event POST without an Origin from
// a product host, which browsers send and these runtimes do not, so
// metadata.origin names the product the surface belongs to.
export function privatePostHogFetch(fetchImpl, metadata = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("privatePostHogFetch needs a fetch implementation");
  if (metadata.origin !== undefined && !ORIGIN.test(String(metadata.origin))) throw new TypeError("privatePostHogFetch needs an https origin without a path or port");
  return async (url, options = {}) => {
    let request;
    try {
      const target = new URL(String(url));
      if (target.protocol !== "https:" || !INGEST_PATH.test(target.pathname)) return emptyResponse();
      const headers = record(options.headers) ? options.headers : {};
      const encoding = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-encoding")?.[1];
      if (encoding) return emptyResponse();
      const parsed = JSON.parse(bodyText(options.body) ?? "");
      const batch = sanitizePostHogDiagnosticsBatch(Array.isArray(parsed?.batch) ? parsed.batch : [parsed], metadata);
      if (!batch.length || typeof parsed?.api_key !== "string" || !API_KEY.test(parsed.api_key)) return emptyResponse();
      const body = { api_key: parsed.api_key, batch };
      const sentAt = timestampOf(parsed.sent_at);
      if (sentAt) body.sent_at = sentAt;
      request = [`${target.origin}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(metadata.origin ? { Origin: metadata.origin } : {}) },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      }];
    } catch {
      // A body this wrapper cannot read or sanitize stays on the device and
      // is answered locally, so the SDK drops it instead of retrying it.
      return emptyResponse();
    }
    // The real send is outside that catch: an offline device, a DNS failure,
    // a timeout or an abort rejects through to the SDK, which keeps its retry
    // handling and never records a report as delivered when it was not.
    return fetchImpl(...request);
  };
}
