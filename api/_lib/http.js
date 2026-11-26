// Shared serverless helpers. Vercel treats any _-prefixed path under api/ as
// non-routable, so this module never becomes an endpoint.
//
// Every handler under api/ imports from here, so a change to
// json/supabaseRpc/supabaseAuthHeaders/unionGroundProvider or to the origin
// rules affects all of them.
// Rules that must be identical across handlers live here for exactly that
// reason. They did not stay identical when they were copied: the three
// CRON_SECRET surfaces ended up enforcing three different strengths, and two
// handlers grew two different constant-time comparisons.
import { createHash, timingSafeEqual } from "node:crypto";
import { TRUSTED_BACKEND_PORTALS } from "../../src/lib/trustedBackends.js";
import { captureServerFailure } from "./observability.js";
import { types } from "node:util";
import { approvedProductionBackend, productionProviderDecision } from "./providerBoundary.js";
import { SECRET_MIN_LENGTH, usableSecret } from "./secretStrength.js";
import { brandText } from "./brand.js";

// One floor for every CRON_SECRET-bearing surface. 32 characters is what
// api/connect.js already demanded before intake may collect anything; the
// dispatcher accepted any non-empty value and the purge accepted 24, so the
// weakest guard sat on the endpoint that can send mail to every member.
export const CRON_SECRET_MIN_LENGTH = SECRET_MIN_LENGTH;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Union Ground's own portal hosts, derived from the one provider table
// (src/lib/trustedBackends.js). The table is empty until the owner approves a
// dedicated provider, so no product host is trusted and every browser mutation
// that is not local development fails closed. A sibling product's host is never
// listed here.
const PRODUCT_HOSTS = new Set(
  Object.values(TRUSTED_BACKEND_PORTALS)
    .map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

export const STATIC_SHELL_SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Frame-Options": "SAMEORIGIN",
  // Mirrors the site-wide static shell policy in vercel.json exactly: no
  // analytics or error-reporting origin, because Union Ground has no
  // telemetry provider. tests/public-page-vercel-routing.test.js pins the match.
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-src 'self'; worker-src 'self' blob:; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests",
});

function headerValue(request, name) {
  const headers = request?.headers;
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  const direct = headers?.[name] ?? headers?.[name.toLowerCase()];
  return String(Array.isArray(direct) ? direct[0] || "" : direct || "");
}

// Vercel preserves the public deployment authority in Host. Treat it as the
// canonical source and use X-Forwarded-Host only for runtimes that omit Host;
// accepting the forwarded value first would let a conflicting header route
// one request across the production/sample backend boundary.
//
// The complete raw header value must be an authority and nothing else: one
// ASCII DNS name (RFC 1035 label bounds, at most 253 characters before an
// optional single trailing dot)
// or one bracketed IPv6 literal, with an optional port. It is checked before
// any normalization, so a comma list, surrounding whitespace, a second
// trailing dot, userinfo, a path, a query, a fragment or a non-ASCII character
// that would case-fold onto a product host (for example U+212A) is refused as
// an empty host rather than normalized onto a trusted portal host.
const RAW_AUTHORITY = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|(?=[^:]{1,253}\.?(?::|$))[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?)(?::\d{1,5})?$/;

// Reads one authority header without collapsing it: `undefined` when the
// header is absent, its single string value when it is present exactly once,
// and an empty string (which the grammar refuses) when a runtime delivers it
// as a multi-value array. A present-but-invalid Host never falls back to
// X-Forwarded-Host; the forwarded value is consulted only when Host is absent.
function authorityHeader(headers, name) {
  if (typeof headers?.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : String(value);
  }
  const direct = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (direct === undefined || direct === null) return undefined;
  if (Array.isArray(direct)) return direct.length === 1 ? String(direct[0] ?? "") : "";
  return String(direct);
}

function selectedAuthority(request) {
  const host = authorityHeader(request?.headers, "host");
  if (host !== undefined) return host;
  return authorityHeader(request?.headers, "x-forwarded-host") ?? "";
}

// Returns the canonical authority and its hostname, or null when the raw value
// is not one well-formed authority. ASCII by construction, so lowercasing is
// safe; the single optional trailing dot of the name is dropped so
// `Example.org.:443` canonicalizes to `example.org:443`; the URL parser only
// separates the port and still rejects a bracketed literal that is not a
// valid IPv6 address.
function parseAuthority(raw) {
  if (!RAW_AUTHORITY.test(raw)) return null;
  const host = raw.toLowerCase().replace(/\.(?=(?::\d{1,5})?$)/, "");
  try {
    return { host, hostname: new URL(`http://${host}`).hostname };
  } catch {
    return null;
  }
}

export function requestHost(request) {
  return parseAuthority(selectedAuthority(request))?.host || "";
}

export function requestHostname(request) {
  return parseAuthority(selectedAuthority(request))?.hostname || "";
}

function exactOrigin(value) {
  const candidate = String(value).trim();
  if (!candidate || candidate === "null") return "";
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    if (candidate !== parsed.origin) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

// Only a portal paired in src/lib/trustedBackends.js, or loopback outside
// production, is a trusted origin. Vercel preview hosts are deliberately not
// trusted on their own: a preview has no approved backend to protect, and the
// rule must stay closed until the provider table names one.
export function trustedOriginForRequest(request, env = process.env) {
  const { host, hostname } = parseAuthority(selectedAuthority(request)) || { host: "", hostname: "" };
  if (PRODUCT_HOSTS.has(hostname)) return host === hostname ? `https://${hostname}` : "";
  if (LOOPBACK_HOSTS.has(hostname) && String(env?.NODE_ENV || "").toLowerCase() !== "production") {
    return `http://${host}`;
  }
  return "";
}

export function secureHtml(response, status, html, options = {}) {
  for (const [name, value] of Object.entries(STATIC_SHELL_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", options.cacheControl || "no-store");
  response.end(options.head ? undefined : html);
}

function hasBrowserMetadata(request) {
  return Boolean(
    headerValue(request, "cookie")
    || headerValue(request, "referer")
    || headerValue(request, "sec-fetch-site")
    || headerValue(request, "sec-fetch-mode")
    || headerValue(request, "sec-fetch-dest"),
  );
}

export function validateMutationOrigin(request, env = process.env) {
  if (!MUTATION_METHODS.has(String(request?.method || "").toUpperCase())) return true;
  const originHeader = headerValue(request, "origin");
  if (originHeader) {
    const origin = exactOrigin(originHeader);
    return Boolean(origin) && origin === trustedOriginForRequest(request, env);
  }
  // Native applications and independently authenticated machine callers do
  // not run in a browser and therefore send neither Origin nor Fetch Metadata.
  // A bearer-only request is their narrow explicit exception. Any cookie,
  // Referer, or Sec-Fetch signal makes a missing Origin fail closed.
  return /^Bearer\s+\S/i.test(headerValue(request, "authorization"))
    && !hasBrowserMetadata(request);
}

// An error message that names the product ("Union Ground Guide is paused ...")
// is sent in this deployment's own name (api/_lib/brand.js). Only the
// server's own `error` string is rewritten; data passes through untouched.
export function json(response, status, payload) {
  captureServerFailure(status);
  response.status(status).setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  const branded = payload && typeof payload.error === "string" ? { ...payload, error: brandText(payload.error) } : payload;
  response.end(JSON.stringify(publicJsonValue(branded)));
}

function publicJsonValue(value, ancestors = new Set()) {
  // Build fresh JSON data before serialization. Never invoke a provider's
  // Error.toJSON: a replacer runs after that hook and is too late to stop it.
  // Node's native brand check includes foreign-realm Errors, not plain data
  // with error-like fields or a spoofed Symbol.toStringTag.
  if (value instanceof Error || types.isNativeError(value)) return { error: "internal-server-error" };
  if (value === null) return null;
  if (typeof value === "string") return value.toString();
  if (typeof value === "number") return Number(value.toString());
  if (typeof value === "boolean") return value === true;
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  if (typeof value !== "object") return undefined;
  if (types.isDate(value)) return Date.prototype.toJSON.call(value);
  if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(value);
  const result = Array.isArray(value) ? new Array(value.length) : Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    // Ordinary records may legitimately use stack/stacktrace as form keys.
    // Only the error objects classified above lose their private fields.
    if (typeof child === "function") continue;
    Object.defineProperty(result, key, {
      value: publicJsonValue(child, ancestors), enumerable: true, configurable: true, writable: true,
    });
  }
  ancestors.delete(value);
  return result;
}

// Method rejection and configuration gating are the same two decisions in every
// handler, but the WORDING is deliberately not shared: the calendar feed answers
// a calendar app in plain text, and client code matches the JSON error strings
// literally (src/lib/adminMfaApi.js keys off "partial-reset"/"not-permitted").
// So these helpers own the decision only and the caller passes the exact
// response it already emits.

// True when the method was rejected and the handler must stop.
export function methodGuard(request, allowed, reject) {
  if (allowed.includes(request.method)) return false;
  reject();
  return true;
}

// True when a required value is missing and the handler must stop. Takes the
// resolved values rather than variable names: guide.js gates on an AI gateway
// token that may come from OIDC instead of process.env.
export function requireEnv(values, reject) {
  if (values.every(Boolean)) return false;
  reject();
  return true;
}

export function bearerToken(request) {
  if (!validateMutationOrigin(request)) return "";
  const value = headerValue(request, "authorization");
  return /^Bearer /i.test(value) ? value.slice(7) : "";
}

// Constant-time secret comparison. Both sides are hashed first so the compare
// always runs over two 32-byte buffers: timingSafeEqual throws on a length
// mismatch, and comparing raw values would leak the secret's length through
// that throw.
export function safeSecretEqual(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(left, right);
}

// Boolean form of the cron rule in ./cronAuth.js (routes that need to tell a
// bad configuration from a bad caller use cronAuthorization there). Fails
// closed twice over: a missing, short or placeholder secret authorizes nobody
// (so an unset CRON_SECRET can never make "" the password, and a copied
// .env.example value is no password either), and the supplied token must then
// match it exactly.
export function authorizeCronRequest(request) {
  const secret = String(process.env.CRON_SECRET || "");
  if (!usableSecret(secret, CRON_SECRET_MIN_LENGTH)) return false;
  return safeSecretEqual(bearerToken(request), secret);
}

// The provider preamble every handler ran its own copy of. `ok` means the
// configured backend passed the one production provider rule
// (approvedProductionBackend() in ./providerBoundary.js, the same rule
// resolveSupabaseBackend() applies): source-approved with a matching project
// ref, or the explicit loopback development backend. A refused backend returns
// no URL and no key, so a caller that forgets to read `ok` still has nothing to
// send. Each caller still decides which of the returned values it requires: the
// calendar feed and the dispatcher are service-role-only, while guide and
// admin-mfa-reset also authorize the caller with the publishable key.
export function unionGroundProvider(env = process.env) {
  // `reason` is for operator logs only. It names environment variables and the
  // contract rule that rejected them — never a key — and no handler puts it in
  // a response body.
  const { ok, reason } = productionProviderDecision(env);
  const backend = approvedProductionBackend(env);
  return {
    ok,
    reason,
    supabaseUrl: backend.url,
    publishableKey: backend.publishableKey,
    serviceRoleKey: backend.serviceRoleKey,
  };
}

function authUserReply(supabaseUrl, publishableKey, token) {
  return fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
}

export async function authenticate(supabaseUrl, publishableKey, token) {
  const response = await authUserReply(supabaseUrl, publishableKey, token);
  if (!response.ok) return null;
  return response.json();
}

// `authenticate` cannot tell an operator WHY it produced no user: a rejected
// token, a 5xx from the Auth gateway and an unreadable reply all collapse to
// `null`, and a transport failure or the 8s timeout throws, which every caller
// then catches into the same `null`. A handler that must answer "unavailable"
// differently from "unauthenticated" resolves the caller through this instead.
// `outcome` is exactly one of:
//   `resolved`    — the gateway answered and named this user;
//   `rejected`    — the gateway answered that this token is not a session;
//   `unavailable` — the gateway could not be reached, timed out, or could not
//                   answer (5xx), and also 408/429, because a gateway that
//                   never evaluated the token has said nothing about it.
// It never throws, so a caller does not need a `.catch` that would erase the
// distinction again.
export async function authenticateCaller(supabaseUrl, publishableKey, token) {
  let response;
  try {
    response = await authUserReply(supabaseUrl, publishableKey, token);
  } catch {
    return { outcome: "unavailable", user: null };
  }
  const status = Number(response?.status || 0);
  if (status >= 500 || status === 408 || status === 429) return { outcome: "unavailable", user: null };
  if (!response.ok) return { outcome: "rejected", user: null };
  try {
    return { outcome: "resolved", user: await response.json() };
  } catch {
    // A 200 whose body the gateway could not serialize is a gateway fault, not
    // a verdict about this token.
    return { outcome: "unavailable", user: null };
  }
}

// Modern sb_publishable_/sb_secret_ API keys are opaque credentials, not
// JWTs. When the API key itself is the caller identity, send only `apikey` and
// let Supabase's gateway supply the role JWT. Legacy JWT keys still ride in
// both headers, while a real member access token always stays in Authorization.
export function supabaseHeaders(apiKey, token = apiKey, extra = {}) {
  const opaqueApiKeyOnly = token === apiKey && /^sb_(?:publishable|secret)_/.test(String(apiKey));
  const modernSecret = opaqueApiKeyOnly && String(apiKey).startsWith("sb_secret_");
  return {
    apikey: apiKey,
    ...(opaqueApiKeyOnly ? {} : { Authorization: `Bearer ${token}` }),
    // Supabase intentionally rejects secret keys presented by browser-like
    // clients. Make the backend caller explicit instead of relying on each
    // runtime's changing default User-Agent.
    ...(modernSecret ? { "User-Agent": "UnionGround-Server/1.0" } : {}),
    ...extra,
  };
}

// Kept for the handlers that build their own fetch: same opaque-key rule,
// without the caller-identity shortcut supabaseHeaders applies.
export function supabaseAuthHeaders(apiKey, token = "") {
  const headers = { apikey: apiKey };
  // New Supabase sb_secret_* keys are opaque API-gateway credentials, not JWTs.
  // Presenting one as a Bearer token is rejected. Legacy service-role JWTs and
  // member access tokens still belong in Authorization.
  if (token && !String(token).startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function supabaseRpc(supabaseUrl, publishableKey, token, name, body = {}, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: supabaseHeaders(publishableKey, token, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
  });
  // The status rides on the error so a caller can tell "this function does
  // not exist here" (PostgREST 404, e.g. code deployed ahead of a migration)
  // from a transient failure whose statement may have committed server-side.
  //
  // The status alone is not enough to act on that distinction: PostgREST also
  // answers 404 for a route that exists but matched nothing. The error body
  // carries the code that separates them — `PGRST202` when the function is not
  // in the schema cache, SQLSTATE `42883` when Postgres itself cannot resolve
  // it — so that code rides along too. Reading it is best effort by design: a
  // body that is absent, unreadable or not JSON must never replace the status
  // the caller is owed, and it must never turn a refusal into a crash.
  if (!response.ok) {
    let code = null;
    // PostgREST's `details` carries a function's RAISE ... DETAIL (the roster
    // invitation limit names itself and its retry time there). Same best-effort
    // rule as `code`.
    let details = null;
    try {
      const detail = await response.text();
      if (detail) {
        const parsed = JSON.parse(detail);
        if (parsed && typeof parsed.code === "string") code = parsed.code;
        if (parsed && typeof parsed.details === "string") details = parsed.details;
      }
    } catch {
      code = null;
      details = null;
    }
    throw Object.assign(new Error(`${name}-failed`), { status: response.status, code, details });
  }
  // A `RETURNS void` function answers 204 with no body, and response.json()
  // throws on empty input. Callers that ignore the return value would then see
  // a successful write as a failure.
  if (response.status === 204) return null;
  const text = await response.text();
  // A 200 with an empty body is NOT a successful void call — 204 is. Treating
  // it as `null` lets a malformed response impersonate a legitimate result:
  // the claim RPC would read as "no work to do" and the dispatcher would report
  // a healthy tick while the queue sat untouched, and the guide and calendar
  // routes would each map it onto a different, wrong status code. Fail instead.
  if (!text) throw new Error(`${name}-empty-response`);
  return JSON.parse(text);
}
