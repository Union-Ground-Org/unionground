// Self-service password reset (REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006).
//
// Owner decision, October 8, 2026: "by a link to the verified email, with
// two-step enforced on recovery and staff reissue kept as the fallback."
//
// GoTrue's single-use recovery token (minted by the admin generate_link API,
// so only the newest link works) never appears in the email: the link carries
// a 15-minute ticket sealed around it that only this server can open, so the
// mailbox holder cannot exchange the token at Auth's public verify endpoint
// and set a password without the second factor. The browser never receives
// the recovery session either: api/password-reset.js exchanges the token
// server-side and hands back only an encrypted, 15-minute state that this
// server alone can open. Without the raw session the browser cannot call
// GoTrue's PUT /user itself, so the new password is set only after the second
// factor is verified (an existing authenticator, or one enrolled during the
// recovery), and GoTrue itself refuses a password change from a session
// below AAL2 once a verified factor exists.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { emailedAuthLink } from "../../src/lib/emailedAuthLink.js";
import { brandText } from "./brand.js";

export { NEW_PASSWORD_MIN as RESET_PASSWORD_MIN, NEW_PASSWORD_MAX as RESET_PASSWORD_MAX } from "../../src/lib/passwordPolicy.js";
export const STATE_TTL_SECONDS = 15 * 60;
export const TICKET_TTL_SECONDS = 15 * 60;
// Bounds the one step only a real account reaches, so the request route's
// timing floor can cover it.
export const RESET_EMAIL_TIMEOUT_MS = 2500;
// GoTrue's hashed_token is a hex SHA-224 digest.
export const RECOVERY_TOKEN = /^[a-f0-9]{56}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,8192})$/;
export const TICKET = /^t1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,512})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeResetEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : "";
}

// The state key is derived from the service-role secret the route already
// holds, under its own HKDF label, so no new deployment secret is needed and
// nothing derived here can be turned back into the service key.
function derivedKey(serviceKey, label) {
  if (typeof serviceKey !== "string" || serviceKey.length < 20) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(serviceKey), Buffer.alloc(0), label, 32));
}

export function resetStateKey(serviceKey) {
  return derivedKey(serviceKey, "password-reset-state-v1");
}

// A separate label, so a ticket and a state can never stand in for each other.
export function resetTicketKey(serviceKey) {
  return derivedKey(serviceKey, "password-reset-ticket-v1");
}

// BUG-UG-RESET-PENDING-RECORD-ACCOUNT-BINDING-20261021: an opaque
// per-account tag the client keeps with a saved reset, so a begin that changed
// one account's enrolment can only clear that account's saved reset. It is an
// HMAC of the user id under its own label: equal for the same account, and it
// never shows the user id to whoever holds the link.
export const RESET_ACCOUNT = /^a1\.[A-Za-z0-9_-]{22}$/;
export function resetAccountTag(serviceKey, userId) {
  const key = derivedKey(serviceKey, "password-reset-account-v1");
  if (!key || !UUID.test(String(userId || ""))) return null;
  return `a1.${createHmac("sha256", key).update(String(userId).toLowerCase()).digest().subarray(0, 16).toString("base64url")}`;
}

function seal(key, prefix, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${prefix}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

// The parsed payload, or null for any malformed, tampered, foreign-key or
// expired value.
function open(key, pattern, value, nowMs) {
  const match = pattern.exec(String(value ?? ""));
  if (!match || !key) return null;
  try {
    const iv = Buffer.from(match[1], "base64url");
    const sealed = Buffer.from(match[2], "base64url");
    if (iv.length !== 12 || sealed.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    const payload = JSON.parse(plain.toString("utf8"));
    if (!Number.isInteger(payload?.x) || payload.x <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sealResetTicket(key, token, nowMs = Date.now()) {
  return seal(key, "t1", { t: token, x: Math.floor(nowMs / 1000) + TICKET_TTL_SECONDS });
}

// GoTrue's recovery token, or null.
export function openResetTicket(key, ticket, nowMs = Date.now()) {
  const payload = open(key, TICKET, ticket, nowMs);
  return payload && RECOVERY_TOKEN.test(String(payload.t)) ? payload.t : null;
}

export function sealResetState(key, { accessToken, userId, factorId, mode }, nowMs = Date.now()) {
  return seal(key, "v1", {
    a: accessToken, u: userId, f: factorId, m: mode,
    x: Math.floor(nowMs / 1000) + STATE_TTL_SECONDS,
  });
}

export function openResetState(key, state, nowMs = Date.now()) {
  const payload = open(key, STATE, state, nowMs);
  if (!payload || typeof payload.a !== "string" || !payload.a || !UUID.test(String(payload.u))
      || !UUID.test(String(payload.f)) || !["challenge", "enroll"].includes(payload.m)) return null;
  return { accessToken: payload.a, userId: payload.u, factorId: payload.f, mode: payload.m };
}

export function resetLink(appOrigin, ticket) {
  // A fragment never reaches a server log or a Referer header.
  return emailedAuthLink(appOrigin, "passwordReset", ticket);
}

const COPY = {
  en: {
    subject: "Reset your Union Ground password",
    heading: "Choose a new password",
    body: "Someone asked to reset the password for the Union Ground account that uses this email address. Use this private link within 15 minutes. It works once, and only the newest reset link works. Before the new password takes effect you will enter a code from your authenticator app, or set one up if you have not yet.",
    ignore: "If you did not ask for this, ignore this email. Your password has not changed.",
    sent: "Sent {time}.",
    action: "Choose a new password",
  },
  es: {
    subject: "Restablece tu contraseña de Union Ground",
    heading: "Elige una contraseña nueva",
    body: "Alguien pidió restablecer la contraseña de la cuenta de Union Ground que usa este correo. Usa este enlace privado dentro de 15 minutos. Funciona una sola vez y solo funciona el enlace más reciente. Antes de que la contraseña nueva entre en vigor, escribirás un código de tu app de autenticación, o configurarás una si todavía no la tienes.",
    ignore: "Si no lo pediste, ignora este correo. Tu contraseña no ha cambiado.",
    sent: "Enviado el {time}.",
    action: "Elegir una contraseña nueva",
  },
};

// The same Eastern-time stamp the reissued-password email prints.
function sentAtText(lang, sentAt) {
  return sentAt.toLocaleString(lang === "es" ? "es-US" : "en-US", {
    timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Same audited dark-on-white text and ink-on-gold action as the signup email.
export function passwordResetEmail(locale, link, sentAt = new Date(), messageReference = randomUUID()) {
  const lang = locale === "es" ? "es" : "en";
  const copy = brandText(COPY[lang]);
  const time = sentAtText(lang, sentAt);
  const sent = copy.sent.replace("{time}", time);
  // Preserve the body while distinguishing overlapping sends and the repeated
  // Eastern fall-back hour. Retries reuse the same captured send instant.
  const instant = sentAt.toISOString().slice(0, 23).replace("T", " ");
  const safeLink = escapeHtml(link);
  return {
    subject: `${copy.subject} — ${time} (${instant} UTC) [${messageReference}]`,
    text: `${copy.heading}\n\n${copy.body}\n\n${copy.action}: ${link}\n\n${copy.ignore}\n\n${sent}`,
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.body)}</p><a href="${safeLink}" rel="noreferrer" style="display:inline-block;min-height:20px;padding:14px 24px;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;text-decoration:none">${escapeHtml(copy.action)}</a><p style="margin:22px 0 0;font-size:15px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.ignore)}</p><p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#3d4a44">${escapeHtml(sent)}</p></td></tr></table></td></tr></table></body></html>`,
  };
}

export async function sendPasswordResetEmail({ resendKey, from, to, locale, link, token, signal, sentAt, messageReference }, fetcher = fetch) {
  const timeout = AbortSignal.timeout(RESET_EMAIL_TIMEOUT_MS);
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        // One send per minted recovery token; the key never carries the email.
        "Idempotency-Key": `ug-reset-${createHash("sha256").update(token).digest("hex").slice(0, 24)}`,
      },
      body: JSON.stringify({ from, to: [to], ...passwordResetEmail(locale, link, sentAt, messageReference) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}
