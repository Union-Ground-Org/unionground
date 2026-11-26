const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const POSTHOG_SENSITIVE_KEY_PATTERN = /(^|[._-])(access_token|refresh_token|authorization|cookie|password|secret|email|full_name|first_name|last_name|phone|address|message|body|content|answer|answers|query|fragment|response|request_data|user_data)($|[._-])/i;

export function redactSensitiveText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(JWT_PATTERN, "[redacted-token]");
}

export function stripUrlDetails(value) {
  if (typeof value !== "string" || !value) return value;
  try {
    const url = new URL(value, "https://union-base.invalid");
    url.search = "";
    url.hash = "";
    if (url.origin === "https://union-base.invalid") return url.pathname;
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSensitiveText(value.split(/[?#]/, 1)[0]);
  }
}

function sanitizeValue(value, keyPattern, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, keyPattern, depth + 1));
  if (typeof value !== "object") return String(value);

  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key)) continue;
    if (/url|uri|referrer|referer/i.test(key) && typeof item === "string") {
      clean[key] = stripUrlDetails(item);
    } else {
      clean[key] = sanitizeValue(item, keyPattern, depth + 1);
    }
  }
  return clean;
}

export function sanitizePostHogEvent(event) {
  if (!event || typeof event !== "object") return event;
  const properties = sanitizeValue(event.properties || {}, POSTHOG_SENSITIVE_KEY_PATTERN);
  return { ...event, properties };
}

export { sanitizeSentryBreadcrumb, sanitizeSentryEvent, sanitizeSentrySpan } from "./sentryPrivacy.js";
