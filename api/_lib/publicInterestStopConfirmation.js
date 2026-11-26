// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25, SINGLE-USE EMAIL CONFIRMATION): the public "stop contacting me"
// request suppresses nothing until the requester opens a single-use,
// 24-hour link mailed to the submitted address. This module owns the secret's
// lifecycle at the serverless boundary: it mints the token, derives the only
// form PostgreSQL ever sees (its SHA-256 digest), builds the fragment-only
// link and sends the bilingual confirmation through the same Resend
// transport the member invitation flow uses. The raw token is never stored.
import { createHash, randomBytes } from "node:crypto";
import { brandText } from "./brand.js";

// 32 random bytes, base64url: the same shape and entropy as an invitation
// secret, and the same fragment-only delivery (`/stop-updates#confirm=`) so
// the token never reaches a server log, a referrer or a query string.
export const STOP_CONFIRMATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function stopConfirmationToken() {
  return randomBytes(32).toString("base64url");
}

export function stopConfirmationDigest(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function stopConfirmationUrl(origin, token) {
  const url = new URL("/stop-updates", origin);
  url.hash = `confirm=${token}`;
  return url.toString();
}

const COPY = {
  en: {
    subject: "Confirm: stop Union Ground public updates",
    heading: "Confirm that you want to stop public updates",
    body: "Someone asked Union Ground to stop sending public updates to this address. Nothing changes until you confirm. Use this private link within 24 hours; it works once. If you did not make this request, you can ignore this email.",
    action: "Stop public updates",
  },
  es: {
    subject: "Confirma: detener las novedades públicas de Union Ground",
    heading: "Confirma que quieres detener las novedades públicas",
    body: "Alguien pidió a Union Ground que deje de enviar novedades públicas a este correo. Nada cambia hasta que confirmes. Usa este enlace privado dentro de 24 horas; funciona una sola vez. Si no hiciste esta solicitud, puedes ignorar este correo.",
    action: "Detener las novedades públicas",
  },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function stopConfirmationEmail(locale, link) {
  const lang = locale === "es" ? "es" : "en";
  const copy = brandText(COPY[lang]);
  const safeLink = escapeHtml(link);
  return {
    subject: copy.subject,
    text: `${copy.heading}\n\n${copy.body}\n\n${copy.action}: ${link}`,
    // Same audited raw token values as api/_lib/memberInvitations.js: email
    // clients do not support the app's CSS variables. Dark-on-white text and
    // the checked #241a08-on-#efa738 CTA pair.
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">${escapeHtml(brandText("UNION GROUND"))}</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.body)}</p><a href="${safeLink}" rel="noreferrer" style="display:inline-block;min-height:20px;padding:14px 24px;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;text-decoration:none">${escapeHtml(copy.action)}</a></td></tr></table></td></tr></table></body></html>`,
  };
}

// One Resend call keyed by the token digest, so a retried request cannot mail
// the same link twice. Returns whether the provider accepted the message.
export async function sendStopConfirmationEmail({ resendKey, from, to, locale, link, tokenHash }) {
  const template = stopConfirmationEmail(locale, link);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sg-stop-confirm-${String(tokenHash).slice(0, 40)}`,
    },
    body: JSON.stringify({ from, to: [to], ...template }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}
