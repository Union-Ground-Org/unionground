// Browser half of open signup (REQ-UG-OPEN-SIGNUP-SELF-SERVE-ORGANIZATION-20260925).
// The browser never calls GoTrue signUp: accounts are created only by
// /api/open-signup-confirm, and organizations only by the authenticated
// public.create_my_organization RPC.
import { holdsPhoneNumber } from "./organizationNamePhoneRule.js";
import { isSaasHost } from "./demoOrigin.js";
import { setupSecurityPath } from "./setupSecurityReturn.js";

export { NEW_PASSWORD_MIN as SIGNUP_PASSWORD_MIN, NEW_PASSWORD_MAX as SIGNUP_PASSWORD_MAX } from "./passwordPolicy.js";
export const ORGANIZATION_NAME_MIN = 2;
const CATALOG_KEY = /^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$/;

// Where a new organization's creator goes next: Settings, to turn on two-step
// sign-in, then setup. A chapter picked in the union catalog goes through the
// Security section's setup detour (setupReturnTo), which survives the required
// two-step enrollment and then opens the build-a-chapter draft under that local
// (REQ-UG-SIGNUP-UNION-CATALOG-PICKER-20261109).
export function createdOrganizationNextHref(placement) {
  if (!CATALOG_KEY.test(placement?.unionKey ?? "")) return "/m/settings?next=setup-review";
  const key = encodeURIComponent(placement.unionKey);
  if (placement.scope === "chapter") return setupSecurityPath(`/m/admin/setup-review?union=${key}&build=chapter`);
  return "/m/settings?next=setup-review";
}
export const ORGANIZATION_NAME_MAX = 120;

// Read once at build time; an empty value keeps signup hidden everywhere.
export const TURNSTILE_SITE_KEY = String(import.meta.env?.VITE_TURNSTILE_SITE_KEY || "").trim();

// Open signup (the signup entry, the /signup pages and the no-organization
// first run) needs the canonical SaaS host, the SaaS surface, the live
// production backend, the Turnstile site key and the owner's switch
// (REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003). Demo, SAMPLE, previews and
// localhost never qualify. The switch ships off: until the owner opens the
// signup period the server says it is off and nothing here is shown
export function openSignupEligible({ hostname, surface, backendKind, siteKey } = {}) {
  return isSaasHost(hostname) && surface === "saas" && backendKind === "live" && Boolean(String(siteKey || "").trim());
}

export function openSignupAvailable({ switchOpen = false, ...surface } = {}) {
  return switchOpen === true && openSignupEligible(surface);
}

// The owner's switch as the server reports it. Any other answer, a 404 (the
// switch off), a network failure or a malformed body, is off.
export async function readOpenSignupSwitch(fetcher) {
  try {
    const response = await fetcher("/api/open-signup", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status !== 200) return false;
    const payload = await response.json().catch(() => null);
    return payload?.open === true;
  } catch {
    return false;
  }
}

async function postJson(fetcher, path, body) {
  const response = await fetcher(path, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload: payload || {} };
}

// Resolves to "accepted", "unavailable", "email-domain-blocked", "invalid" or "error".
// residenceState and ageAttested carry the state the person chose and their
// answer to the age attestation it selects (
// 2026); the route re-derives the rule from the state.
export async function requestOpenSignup(fetcher, { email, locale, turnstileToken, acceptedTerms, residenceState, ageAttested, website }) {
  try {
    const { status, payload } = await postJson(fetcher, "/api/open-signup", {
      email, locale, turnstileToken, acceptedTerms, residenceState, ageAttested, website,
    });
    if (status === 200 && payload.accepted === true) return "accepted";
    if (status === 503) return "unavailable";
    if (status === 400 && payload.error === "email-domain-blocked") return "email-domain-blocked";
    if (status === 400) return "invalid";
    return "error";
  } catch {
    return "error";
  }
}

const CONFIRM_ERRORS = new Set(["link-invalid", "password-rejected", "rate-limited", "email-domain-blocked"]);

// Resolves to { status: "accepted", email } or { status: <code> } where code is
// link-invalid, password-rejected, rate-limited, email-domain-blocked, unavailable or error.
export async function confirmOpenSignup(fetcher, { token, password, locale }) {
  try {
    const { status, payload } = await postJson(fetcher, "/api/open-signup-confirm", { token, password, locale });
    if (status === 200 && payload.accepted === true && typeof payload.email === "string") {
      return { status: "accepted", email: payload.email };
    }
    if (CONFIRM_ERRORS.has(payload.error)) return { status: payload.error };
    if (status === 503) return { status: "unavailable" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

// Signs the new account in through the same audited password proxy the
// sign-in screen uses, then hands the tokens to the Supabase client.
export async function signInAfterSignup(fetcher, client, email, password) {
  try {
    const { ok, payload } = await postJson(fetcher, "/api/auth-password-signin", { email, password });
    if (!ok || !payload.accessToken || !payload.refreshToken) return false;
    const { error } = await client.auth.setSession({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
    });
    return !error;
  } catch {
    return false;
  }
}

function missingFunction(error) {
  return error?.code === "PGRST202" || error?.code === "42883" || error?.status === 404;
}

const FIXED_22023 = new Map([
  ["invalid organization", "invalid-name"],
  ["organization membership exists", "has-organization"],
]);

// Resolves to { status: "created", organizationId, chapterId } or
// { status } with one of name_unavailable, limit_reached, unavailable,
// invalid-name, has-organization, not-permitted or error. A closed signup
// period answers as unavailable. The raw database
// message is never returned to the screen. The default chapter takes the
// organization's name and is renamed later in the setup review.
export async function createMyOrganization(client, name, idempotencyKey) {
  let result;
  try {
    result = await client.rpc("create_my_organization", {
      p_name: name,
      p_idempotency_key: idempotencyKey,
    });
  } catch {
    return { status: "error" };
  }
  const { data, error } = result || {};
  if (error) {
    if (missingFunction(error)) return { status: "unavailable" };
    if (error.code === "42501") return { status: "not-permitted" };
    if (error.code === "22023") return { status: FIXED_22023.get(String(error.message || "")) || "error" };
    return { status: "error" };
  }
  if (data?.status === "created" && data.organizationId) {
    return { status: "created", organizationId: data.organizationId, chapterId: data.chapterId || null };
  }
  if (data?.status === "closed") return { status: "unavailable" };
  if (["name_unavailable", "limit_reached", "unavailable"].includes(data?.status)) return { status: data.status };
  return { status: "error" };
}

export function newIdempotencyKey(cryptoApi = globalThis.crypto) {
  return cryptoApi.randomUUID();
}

// Mirrors the server name rule so an obvious mistake is caught before a
// request is spent; the database stays the authority. Order: NFKC, collapse
// whitespace, trim; length in code points; then the character rules.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// Invisible and bidi-control code points, as inclusive [from, to] ranges
// (compared by code point: several are combining marks, which a regular
// expression character class would misread).
const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
];

function hasInvisible(name) {
  for (const character of name) {
    const point = character.codePointAt(0);
    if (INVISIBLE_RANGES.some(([from, to]) => point >= from && point <= to)) return true;
  }
  return false;
}
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function normalizeOrganizationName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function organizationNameProblem(value) {
  // JavaScript's \s also matches U+FEFF, which the server does not collapse,
  // so invisible code points are checked before whitespace is collapsed.
  if (hasInvisible(String(value ?? "").normalize("NFKC"))) return "characters";
  const name = normalizeOrganizationName(value);
  const length = [...name].length;
  if (length < ORGANIZATION_NAME_MIN || length > ORGANIZATION_NAME_MAX) return "length";
  if (CONTROL.test(name)) return "characters";
  if (!LETTER_OR_DIGIT.test(name)) return "characters";
  if (name.includes("@") || name.includes("://")) return "characters";
  if (holdsPhoneNumber(name)) return "characters";
  return null;
}

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ACTION = "open-signup";

// Loads Cloudflare's widget script on /signup only. vercel.json allows
// challenges.cloudflare.com in script-src and frame-src for that one path, so
// the site-wide policy stays unchanged.
export function loadTurnstile(doc = document, win = window) {
  if (win.turnstile) return Promise.resolve(win.turnstile);
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => (win.turnstile ? resolve(win.turnstile) : reject(new Error("turnstile-missing")));
    script.onerror = () => reject(new Error("turnstile-load-failed"));
    doc.head.appendChild(script);
  });
}

// Reads `#token=` and removes it from the address bar before anything else
// happens, so the link never lingers in history, a bookmark or a screenshot.
export function takeSignupToken(win = window) {
  const fragment = win.location.hash.startsWith("#") ? win.location.hash.slice(1) : "";
  win.history.replaceState(win.history.state, "", "/signup/confirm");
  const params = new URLSearchParams(fragment);
  const token = params.get("token") || "";
  return /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,2048}$/.test(token) ? token : null;
}
