const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DOCUMENT_MARKER_PATTERN = /<meta\s+name=["']union-ground-build-sha["']\s+content=["']([0-9a-f]{40})["']\s*\/?\s*>/g;
const MAX_DOCUMENT_BYTES = 512 * 1024;

function fail(message) {
  throw new Error(message);
}

export function canonicalHttpsOrigin(value, label = "Origin") {
  if (typeof value !== "string" || /[^\x20-\x7e]/.test(value)) {
    fail(`${label} must be a printable HTTPS origin`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || value !== url.origin
    || url.hostname === "localhost"
    || url.hostname.startsWith("[")
    || /^\d+(?:\.\d+){3}$/.test(url.hostname)
  ) {
    fail(`${label} must be one canonical root HTTPS origin`);
  }
  return url.origin;
}

export function exactApprovedOrigin(value, expectedOrigin, label = "Origin") {
  const origin = canonicalHttpsOrigin(value, label);
  if (origin !== expectedOrigin) fail(`${label} is not the source-approved origin`);
  return origin;
}

export function canonicalSupabaseOrigin(value) {
  const origin = canonicalHttpsOrigin(value, "E2E_SUPABASE_URL");
  if (!/^[a-z0-9-]+\.supabase\.co$/.test(new URL(origin).hostname)) {
    fail("E2E_SUPABASE_URL is not an exact Supabase project origin");
  }
  return origin;
}

export function exactResponseTarget({ value, origin, pathname, method, actualMethod } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === origin
    && url.pathname === pathname
    && String(actualMethod ?? "").toUpperCase() === String(method ?? "").toUpperCase();
}

export function isTrustedPasswordTokenResponse(value, supabaseOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === supabaseOrigin
    && url.pathname === "/auth/v1/token"
    && url.hash === ""
    && url.searchParams.size === 1
    && url.searchParams.get("grant_type") === "password";
}

/**
 * A runner-provisioned identity is immutable. Existing-account mode may learn
 * an id only from the configured Supabase password-token response and only
 * when the response carries a syntactically valid user UUID.
 */
export function captureAuthenticatedMemberId({
  adminProvisionedByRunner,
  createdUserId,
  currentMemberUserId,
  responseUrl,
  payload,
  supabaseOrigin,
} = {}) {
  if (adminProvisionedByRunner) {
    if (!UUID_PATTERN.test(createdUserId ?? "")) fail("Runner-created member id is invalid");
    return createdUserId;
  }
  if (!isTrustedPasswordTokenResponse(responseUrl, supabaseOrigin)) return currentMemberUserId;
  return UUID_PATTERN.test(payload?.user?.id ?? "") ? payload.user.id : currentMemberUserId;
}

export function assertPageOrigin(value, expectedOrigin) {
  let actual;
  try {
    actual = new URL(value).origin;
  } catch {
    fail("Browser navigated to an invalid URL before credential entry");
  }
  if (actual !== expectedOrigin) {
    fail("Browser left the attested target origin before credential entry");
  }
  return actual;
}

/**
 * Bind the bytes Playwright actually loaded as the main document to the
 * expected build. A separate runner fetch of /build-info.json cannot prove
 * this when an alias changes or two edge locations temporarily disagree.
 */
export function assertLoadedBuildDocument({
  requestedUrl,
  responseUrl,
  status,
  contentType,
  body,
  redirectedFrom = false,
  expectedOrigin,
  expectedSha,
} = {}) {
  if (!SHA_PATTERN.test(expectedSha ?? "")) fail("Loaded document expected SHA is invalid");
  assertPageOrigin(requestedUrl, expectedOrigin);
  assertPageOrigin(responseUrl, expectedOrigin);
  if (redirectedFrom || requestedUrl !== responseUrl) {
    fail("Loaded main document must not follow a redirect");
  }
  if (status !== 200) fail("Loaded main document must return exact HTTP 200");
  if (String(contentType ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
    fail("Loaded main document must be HTML");
  }

  let bytes;
  let html;
  if (typeof body === "string") {
    bytes = new TextEncoder().encode(body);
    html = body;
  } else if (body instanceof Uint8Array) {
    bytes = body;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      fail("Loaded main document must be valid UTF-8");
    }
  } else {
    fail("Loaded main document body is missing");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
    fail("Loaded main document body size is invalid");
  }

  const matches = [...html.matchAll(DOCUMENT_MARKER_PATTERN)];
  if (matches.length !== 1 || matches[0][1] !== expectedSha) {
    fail("Loaded main document is not bound to the expected build SHA");
  }
  return Object.freeze({ url: responseUrl, sha: matches[0][1] });
}

/**
 * The build SHA a loaded main document carries in its single build marker,
 * or null when the marker is missing, repeated, malformed, or the body is not
 * a document this policy would read. Observation only: it binds nothing,
 * trusts nothing, and never replaces assertLoadedBuildDocument. A failed
 * visual-audit surface records it so the production supersession classifier
 * can resolve which build the surface actually loaded.
 */
export function loadedBuildDocumentSha(body) {
  let html;
  if (typeof body === "string") {
    html = body;
  } else if (body instanceof Uint8Array) {
    if (body.byteLength === 0 || body.byteLength > MAX_DOCUMENT_BYTES) return null;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (html.length === 0 || html.length > MAX_DOCUMENT_BYTES) return null;
  const matches = [...html.matchAll(DOCUMENT_MARKER_PATTERN)];
  return matches.length === 1 ? matches[0][1] : null;
}
