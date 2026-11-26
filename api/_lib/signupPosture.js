// Accounts are invitation-only. Every account the app creates is made by the
// server through the Auth admin API (invitations, the owner's open-signup
// switch), so the hosted Supabase project must have public sign-ups turned
// off. supabase/config.toml turns them off for the local stack only; on a
// hosted project it is a dashboard setting, and a copy that left it on lets
// anyone holding the public key create an account and skip the invitation.
//
// This reads the project's public Auth settings (GET /auth/v1/settings with the
// publishable key) and answers whether the deployment may serve. It refuses
// while public sign-up or anonymous sign-in is on, unless the operator set
// ALLOW_OPEN_SIGNUP=true on purpose, and fails closed when the settings cannot
// be read. Local development and tests (NODE_ENV development/test, the
// explicit loopback backend, or a loopback Supabase URL) are not checked: the
// local stack's supabase/config.toml already turns sign-up off, and unit tests
// have no project to ask. Results are cached briefly per project so a page
// load does not pay for a request each time.
import { localDevelopmentSeamOpen } from "./providerBoundary.js";

const OK_TTL_MS = 60_000;
const REFUSED_TTL_MS = 15_000;
const FETCH_TIMEOUT_MS = 3_000;

const cache = new Map();

export const SIGNUP_OPEN_MESSAGE = "Public sign-up is enabled on this Supabase project, so anyone could create an account without an invitation. "
  + "Turn off \"Allow new users to sign up\" (and anonymous sign-ins) in the Supabase dashboard under Authentication, "
  + "or set ALLOW_OPEN_SIGNUP=true if open sign-up is intended.";
export const SIGNUP_UNREADABLE_MESSAGE = "The Supabase Auth settings could not be read, so this deployment cannot confirm public sign-up is off. "
  + "Check VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.";

export function openSignupAllowed(env = process.env) {
  return String(env?.ALLOW_OPEN_SIGNUP || "").trim().toLowerCase() === "true";
}

function isLoopbackBackend(url) {
  try {
    const host = new URL(String(url || "")).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

async function readSettings(url, publishableKey, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, "")}/auth/v1/settings`, {
      method: "GET",
      headers: { apikey: publishableKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// { ok: true } or { ok: false, reason: "signup-open" | "settings-unreadable", message }.
// `backend` is a resolved backend ({ url, publishableKey }); a backend with no
// URL is not this check's business (callers already answer not-configured).
export async function signupPosture(backend, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const url = String(backend?.url || "");
  if (!url || openSignupAllowed(env)) return { ok: true };
  if (localDevelopmentSeamOpen(env) || isLoopbackBackend(url)) return { ok: true };
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now()) return hit.result;

  const settings = await readSettings(url, String(backend?.publishableKey || ""), fetchImpl);
  let result;
  if (!settings || typeof settings.disable_signup !== "boolean") {
    result = { ok: false, reason: "settings-unreadable", message: SIGNUP_UNREADABLE_MESSAGE };
  } else if (settings.disable_signup !== true || settings.external?.anonymous_users === true) {
    result = { ok: false, reason: "signup-open", message: SIGNUP_OPEN_MESSAGE };
  } else {
    result = { ok: true };
  }
  cache.set(url, { result, expiresAt: now() + (result.ok ? OK_TTL_MS : REFUSED_TTL_MS) });
  if (!result.ok) console.error(`[signup-posture] ${result.reason}: ${result.message}`);
  return result;
}

// Tests only.
export function resetSignupPostureCache() {
  cache.clear();
}
