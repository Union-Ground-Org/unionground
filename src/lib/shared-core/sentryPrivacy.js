// Shared by browser, server and React Native. Build a new allowlisted event;
// a key blacklist cannot detect a person's name or grievance in arbitrary text.
const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
const LEVELS = new Set(["fatal", "error", "warning", "info", "debug", "log"]);
const PLATFORMS = new Set(["javascript", "node"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coordinate(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
}

function sanitizeFrame(frame) {
  if (!record(frame)) return null;
  const clean = {};
  if (coordinate(frame.lineno)) clean.lineno = frame.lineno;
  if (coordinate(frame.colno)) clean.colno = frame.colno;
  if (typeof frame.in_app === "boolean") clean.in_app = frame.in_app;
  // Paths, function names, source lines and local variables can contain user
  // data. Keep coarse stack positions, without a path or function identifier.
  if (Object.keys(clean).length) clean.filename = "app:///application";
  return Object.keys(clean).length ? clean : null;
}

function sanitizeException(exception) {
  if (!record(exception)) return null;
  const clean = {
    type: ERROR_TYPES.has(exception.type) ? exception.type : "Error",
    value: "Application error",
  };
  if (Array.isArray(exception.stacktrace?.frames)) {
    const frames = exception.stacktrace.frames.slice(-50).map(sanitizeFrame).filter(Boolean);
    if (frames.length) clean.stacktrace = { frames };
  }
  return clean;
}

export function sanitizeSentryBreadcrumb() {
  // Navigation, console, network and native UI breadcrumbs all carry member
  // content or record identifiers. This errors-only policy sends none of them.
  return null;
}

export function sanitizeSentryEvent(event) {
  try {
    if (!record(event) || (event.type !== undefined && event.type !== "error")) return null;
    const clean = { type: undefined, level: LEVELS.has(event.level) ? event.level : "error", message: "Application error" };
    if (typeof event.event_id === "string" && /^[a-f0-9]{32}$/.test(event.event_id)) clean.event_id = event.event_id;
    if (Number.isFinite(event.timestamp) && event.timestamp >= 0) clean.timestamp = event.timestamp;
    if (PLATFORMS.has(event.platform)) clean.platform = event.platform;
    if (Array.isArray(event.exception?.values)) {
      const values = event.exception.values.slice(0, 10).map(sanitizeException).filter(Boolean);
      if (values.length) clean.exception = { values };
    }
    // No spread: user, request, logentry, extra, contexts, tags, transaction,
    // fingerprint, threads, spans, debug_meta, exception mechanisms and future
    // SDK fields are absent, rather than trusting arbitrary keys or values.
    return clean;
  } catch {
    // Throwing getters, malformed SDK data or an unexpected shape fail closed.
    return null;
  }
}

export function sanitizeSentrySpan() {
  // Tracing is disabled and transaction/span envelope items are rejected.
  // Retain a content-free result for callers of the historical exported hook.
  return { span_id: "0000000000000000", trace_id: "00000000000000000000000000000000", start_timestamp: 0, timestamp: 0, op: "redacted", data: {} };
}

export function privateSentryOptions() {
  return {
    sendDefaultPii: false,
    sampleRate: 1,
    tracesSampleRate: 0,
    tracePropagationTargets: [],
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    enableLogs: false,
    enableMetrics: false,
    sendClientReports: false,
    autoSessionTracking: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: sanitizeSentryBreadcrumb,
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: () => null,
    beforeSendSpan: sanitizeSentrySpan,
  };
}

function sanitizeEnvelope(envelope, metadata, sdkName) {
  try {
    if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[1])) return null;
    const items = [];
    for (const item of envelope[1]) {
      if (!Array.isArray(item) || item[0]?.type !== "event") continue;
      const event = sanitizeSentryEvent(item[1]);
      if (!event) continue;
      // Release/environment/surface come from initialization, never user scope.
      if (/^[a-f0-9]{40}$/.test(metadata.release || "")) event.release = metadata.release;
      if (["production", "preview", "development"].includes(metadata.environment)) event.environment = metadata.environment;
      if (["web", "api", "ios", "android"].includes(metadata.surface)) event.tags = { surface: metadata.surface };
      // Relay looks up user.geo from the connection IP whenever user.geo is
      // absent, whatever infer_ip says (relay-event-normalization event.rs,
      // normalize_user_geoinfo). A present geo skips that lookup; its only key
      // is unknown to the schema, so Relay's remove-other pass then drops it
      // and the stored event carries no user at all.
      event.user = { geo: { lookup: "disabled" } };
      items.push([{ type: "event" }, event]);
    }
    const sdk = { name: sdkName, version: "1.0.0", settings: { infer_ip: "never" } };
    for (const [, event] of items) event.sdk = sdk;
    // Static SDK policy tells Relay not to infer an IP from the connection.
    // Relay replaces the event's ID with the header's, minting a new one when
    // absent, so the header carries the event's own ID. DSN and send time are
    // kept only in their expected shapes; scope-derived SDK metadata and
    // dynamic sampling context are discarded. Sessions, attachments, replay,
    // profiles, transactions, logs, metrics, feedback and client reports never
    // reach the underlying SDK transport.
    const header = { sdk };
    const source = record(envelope[0]) ? envelope[0] : {};
    if (items.length && items[0][1].event_id) header.event_id = items[0][1].event_id;
    if (typeof source.dsn === "string" && /^https:\/\/[a-f0-9]{32}@[a-z0-9.-]+\/\d+$/.test(source.dsn)) header.dsn = source.dsn;
    if (typeof source.sent_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(source.sent_at)) header.sent_at = source.sent_at;
    return items.length ? [header, items] : null;
  } catch {
    return null;
  }
}

function makePrivateTransport(makeTransport, metadata, sanitizeSentryEnvelope) {
  return (options) => {
    const transport = makeTransport(options);
    return {
      send(envelope) {
        const clean = sanitizeSentryEnvelope(envelope, metadata);
        return clean ? transport.send(clean) : Promise.resolve({});
      },
      flush: (timeout) => transport.flush(timeout),
    };
  };
}

// Only fixed SDK identities are accepted. Never copy a scope, event field or
// arbitrary caller string into the privacy-filtered envelope.
export function createSentryPrivacy(sdkName) {
  if (sdkName !== "sentry.javascript.unionground-private-errors") {
    throw new TypeError("Unsupported private Sentry SDK identity");
  }
  const sanitizeSentryEnvelope = (envelope, metadata = {}) => sanitizeEnvelope(envelope, metadata, sdkName);
  const privateSentryTransport = (makeTransport, metadata = {}) => makePrivateTransport(makeTransport, metadata, sanitizeSentryEnvelope);
  return Object.freeze({ sanitizeSentryEnvelope, privateSentryTransport });
}
