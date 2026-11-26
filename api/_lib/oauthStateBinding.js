// Ties an organization Google connect (calendar or Drive) to the browser that
// started it (SEC-UG-CALENDAR-AND-DRIVE-CONNECT-NOT-TIED-TO-THE-BROWSER-20261122).
// The start keeps a random binding in an HttpOnly cookie scoped to the return
// address and stores the hash of state plus binding; the callback claims that
// same pair. The state Google carries in the link is useless in any other
// browser, and the claim functions keep it single use and short lived.
import { createHash, randomBytes } from "node:crypto";
import { trustedOriginForRequest } from "./http.js";

const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_MAX_AGE_SECONDS = 600;
// vercel.json sends every request on these hosts to the bare domain before any
// function runs, so a cookie set on the bare domain reaches a return addressed
// to www.
// Union Ground names no host whose edge redirects a www name to the bare one.
const EDGE_REDIRECTED_TO_BARE = new Set();

export function newOAuthStateBinding() {
  return randomBytes(32).toString("base64url");
}

// What the callback claims: empty unless both halves are present and the
// binding has the shape the start wrote.
export function boundOAuthState(state, binding) {
  const value = String(binding || "");
  return state && BINDING_PATTERN.test(value) ? `${state}.${value}` : "";
}

export function boundOAuthStateHash(state, binding) {
  return createHash("sha256").update(boundOAuthState(state, binding)).digest("hex");
}

export function readOAuthStateBinding(headers, name) {
  for (const part of String(headers?.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === name && BINDING_PATTERN.test(value)) return value;
  }
  return "";
}

function returnAddressOrigin(redirectUri) {
  try {
    const url = new URL(redirectUri);
    const hostname = EDGE_REDIRECTED_TO_BARE.has(url.hostname) ? url.hostname.slice(4) : url.hostname;
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
  } catch { // swallow-ok: an unparseable return address names no site, and the start goes on to fail as before
    return "";
  }
}

// The binding cookie is host-only and never widened with a Domain attribute,
// so the start must run on the host the browser returns to (a deployment or
// preview host never shares cookies with the site address). Empty when it
// does; otherwise the site address to open the connect on instead.
export function startOnOtherSiteAddress(request, redirectUri) {
  const site = returnAddressOrigin(redirectUri);
  return site && trustedOriginForRequest(request) !== site ? site : "";
}

function cookiePath(redirectUri) {
  try {
    return new URL(redirectUri).pathname || "/";
  } catch { // swallow-ok: an unparseable return address gets the widest same-host path, never another host
    return "/";
  }
}

export function oauthStateBindingCookie(name, value, redirectUri, { clear = false } = {}) {
  const maxAge = clear ? 0 : BINDING_MAX_AGE_SECONDS;
  return `${name}=${clear ? "" : value}; Path=${cookiePath(redirectUri)}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
