// Open signup (REQ-UG-OPEN-SIGNUP-SELF-SERVE-ORGANIZATION-20260925).
//
// GoTrue self-signup stays disabled. A person proves a mailbox through a
// stateless, encrypted, 30-minute link minted here; only then does
// api/open-signup-confirm.js create the account through the admin API with no
// user metadata. Nothing in this module stores or logs an email address, a
// token, a password or a Turnstile token.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes,
} from "node:crypto";
import { isSaasHost, SAAS_HOSTS } from "../../src/lib/demoOrigin.js";
import { ageRuleFor } from "../../src/lib/residenceRegions.js";
import { isSampleSupabaseProject } from "../../src/lib/sampleBackend.js";
import { requestHostname } from "./http.js";
import { isPlaceholderSecret } from "./secretStrength.js";
import { brandText } from "./brand.js";

export const TOKEN_TTL_SECONDS = 30 * 60;
export { NEW_PASSWORD_MIN as PASSWORD_MIN, NEW_PASSWORD_MAX as PASSWORD_MAX } from "../../src/lib/passwordPolicy.js";
export const TURNSTILE_ACTION = "open-signup";
const SECRET_MIN = 32;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,2048})$/;

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : "";
}

export function emailDigest(email) {
  // The database compares sha256(lower(btrim(email))) hex; see
  // public.open_signup_email_available.
  return createHash("sha256").update(String(email)).digest("hex");
}

function derive(secret, info) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(String(secret)), Buffer.alloc(0), info, 32));
}

export function signupKeys(secret) {
  if (typeof secret !== "string" || secret.length < SECRET_MIN) return null;
  // A placeholder (api/_lib/secretStrength.js) can be long enough to pass the
  // length check; a deployment that copied one has no secret at all.
  if (isPlaceholderSecret(secret)) return null;
  return {
    token: derive(secret, "open-signup-token-v1"),
    scope: derive(secret, "open-signup-scope-v1"),
  };
}

// A 64-hex scope for the limiter table. `kind` separates the network and email
// namespaces so one value can never charge the other's bucket.
export function scopeHash(keys, kind, value) {
  return createHmac("sha256", keys.scope).update(`open-signup-${kind}-v1:${value}`).digest("hex");
}

// `s` is the state the person said they live in and `a` is when they
// confirmed, on the signup form, the age rule that state selects (owner
// decision of October 16, 2026: 18 or older in the app-store age-law states,
// the D-03 B band elsewhere). The sealed token carries both to the account
// creation, which records them.
export function mintSignupToken(keys, { email, locale, termsVersion, residenceState }, nowMs = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.token, iv);
  const payload = JSON.stringify({
    e: email,
    x: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS,
    l: locale === "es" ? "es" : "en",
    t: String(termsVersion || ""),
    s: String(residenceState || ""),
    a: Math.floor(nowMs / 1000),
  });
  const sealed = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

// Returns the payload, or null for any malformed, tampered, foreign-key or
// expired token. The caller answers every null with the same `link-invalid`.
export function readSignupToken(keys, token, nowMs = Date.now()) {
  const match = TOKEN.exec(String(token ?? ""));
  if (!match || !keys) return null;
  try {
    const iv = Buffer.from(match[1], "base64url");
    const sealed = Buffer.from(match[2], "base64url");
    if (iv.length !== 12 || sealed.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", keys.token, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    const payload = JSON.parse(plain.toString("utf8"));
    const email = normalizeEmail(payload?.e);
    if (!email || email !== payload.e) return null;
    if (!Number.isInteger(payload.x) || payload.x <= Math.floor(nowMs / 1000)) return null;
    // A token minted before the attestation existed carries no `a`, and one
    // minted before the state question carries no listed `s`; neither can
    // ever create an account.
    if (!Number.isInteger(payload.a) || payload.a <= 0) return null;
    const ageRule = ageRuleFor(payload.s);
    if (!ageRule) return null;
    return {
      email,
      locale: payload.l === "es" ? "es" : "en",
      termsVersion: String(payload.t || ""),
      residenceState: payload.s,
      ageRule,
      ageAttestedAt: new Date(payload.a * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

export function signupLink(appOrigin, token) {
  // A fragment never reaches a server log or a Referer header.
  return `${appOrigin}/signup/confirm#token=${token}`;
}

// Resend de-duplicates per key for 24 hours; a repeat request inside the same
// 30-minute window collapses onto one send. The key never carries the email.
export function resendIdempotencyKey(keys, email, nowMs = Date.now()) {
  const window = Math.floor(nowMs / (TOKEN_TTL_SECONDS * 1000));
  return `ug-signup-${createHmac("sha256", keys.scope).update(`${email}|${window}`).digest("hex").slice(0, 24)}`;
}

// Cloudflare's siteverify error codes that mean the check itself failed (our
// own request was refused, or Cloudflare erred), not that the visitor did.
const TURNSTILE_SERVICE_ERRORS = Object.freeze(["missing-input-secret", "invalid-input-secret", "bad-request", "internal-error"]);

// Cloudflare's siteverify: "pass", "fail" or "unavailable". Only "pass" lets
// signup continue, so any transport, shape, hostname or action mismatch, and
// 8 seconds without an answer, still fail closed. "unavailable" separates an
// unreachable, erroring or misconfigured check from a refused visitor token,
// so an outage is not mistaken for ordinary bot traffic.
export async function turnstileVerdict(secret, token, remoteIp, fetcher = fetch) {
  const value = String(token ?? "");
  if (!value || value.length > 2048) return "fail";
  let result;
  try {
    const form = new URLSearchParams({ secret, response: value });
    if (remoteIp) form.set("remoteip", remoteIp);
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response?.ok) return "unavailable";
    result = await response.json();
  } catch {
    return "unavailable";
  }
  // Siteverify always answers an object with a boolean success; anything
  // else is a broken check, not a refused visitor.
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.success !== "boolean") return "unavailable";
  if (result.success) {
    return SAAS_HOSTS.includes(String(result.hostname || "").toLowerCase()) && result.action === TURNSTILE_ACTION ? "pass" : "fail";
  }
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
  return codes.some((code) => TURNSTILE_SERVICE_ERRORS.includes(code)) ? "unavailable" : "fail";
}

const COPY = {
  en: {
    subject: "Confirm your email for Union Ground",
    heading: "Confirm your email",
    body: "Use this private link within 30 minutes to finish creating your account. If you did not ask for this, ignore this email.",
    action: "Finish creating my account",
  },
  es: {
    subject: "Confirma tu correo para Union Ground",
    heading: "Confirma tu correo",
    body: "Usa este enlace privado dentro de 30 minutos para terminar de crear tu cuenta. Si no lo pediste, ignora este correo.",
    action: "Terminar de crear mi cuenta",
  },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Same audited dark-on-white text and ink-on-gold action values as the
// invitation email, deliberately WITHOUT its chapter eyebrow line: the
// person has no organization yet and the platform must not attach any existing
// organization's name to a stranger's account.
export function confirmationEmail(locale, link) {
  const lang = locale === "es" ? "es" : "en";
  const copy = brandText(COPY[lang]);
  const safeLink = escapeHtml(link);
  return {
    subject: copy.subject,
    text: `${copy.heading}\n\n${copy.body}\n\n${copy.action}: ${link}`,
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.body)}</p><a href="${safeLink}" rel="noreferrer" style="display:inline-block;min-height:20px;padding:14px 24px;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;text-decoration:none">${escapeHtml(copy.action)}</a></td></tr></table></td></tr></table></body></html>`,
  };
}

export async function sendConfirmationEmail({ resendKey, from, to, locale, link, idempotencyKey }, fetcher = fetch) {
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], ...confirmationEmail(locale, link) }),
      signal: AbortSignal.timeout(8000),
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

// Every value the two handlers need, or null when any is missing or unsafe.
// A null answer is a 503 `signup-unavailable`: the owner switches signup off
// by removing OPEN_SIGNUP_SECRET or the Turnstile secret.
// REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: the owner's one switch is the
// database signup period (private.open_signup_period), read through the
// service-role-only public.open_signup_switch_open(). It ships off. Another
// host or surface, a missing backend, a database without the function, or any
// read failure all count as off, and while it is off the signup routes answer
// exactly as if they did not exist.
function signupBackendUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !isSampleSupabaseProject(value);
  } catch {
    return false;
  }
}

export async function openSignupSwitchOpen(request, backend, rpc) {
  if (!isSaasHost(requestHostname(request)) || backend?.surface !== "saas" || !backend.serviceRoleKey
      || !signupBackendUrl(backend.url)) return false;
  try {
    if ((await rpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, "open_signup_switch_open", {})) !== true) return false;
    // Explicitly require the recovery and operator-coverage migrations as
    // well. An older database's owner switch cannot silently bypass either
    // production prerequisite.
    if ((await rpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, "open_signup_recovery_ready", {})) !== true) return false;
    return (await rpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, "open_signup_coverage_active", {})) === true;
  } catch {
    return false;
  }
}

export function openSignupConfig(backend, env = process.env) {
  if (!signupBackendUrl(backend?.url)) return null;
  const appOrigin = String(env.INVITATION_APP_ORIGIN || "").trim().replace(/\/$/, "");
  const config = {
    supabaseUrl: backend.url,
    serviceKey: backend.serviceRoleKey || "",
    appOrigin,
    keys: signupKeys(String(env.OPEN_SIGNUP_SECRET || "")),
    turnstileSecret: String(env.TURNSTILE_SECRET_KEY || "").trim(),
    resendKey: String(env.RESEND_API_KEY || "").trim(),
    notifyFrom: String(env.NOTIFY_FROM_ADDRESS || "").trim(),
  };
  if (!Object.values(config).every(Boolean)) return null;
  try {
    const app = new URL(appOrigin);
    if (app.origin !== appOrigin || app.protocol !== "https:"
        || !isSaasHost(app.hostname) || app.port) return null;
  } catch {
    return null;
  }
  return config;
}

export function parseBody(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
