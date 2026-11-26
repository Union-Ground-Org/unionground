// SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001: RFC 8058 one-click
// unsubscribe for engagement email (broadcasts, welcome steps, surveys).
//
//   GET  ?t=<token>  a confirmation page only. Link scanners and preview bots
//                    fetch links, so a GET never changes anything; the page's
//                    button POSTs the same request a mail provider sends.
//   POST ?t=<token>  turns off the token's category ("announcements",
//                    "surveys" or "welcome") for the token's member. Mail providers POST
//                    "List-Unsubscribe=One-Click" from their own servers with
//                    no Origin and no session, so the signed token is the whole
//                    authority (classified in scripts/lib/api-origin-contract.mjs).
//
// The database mints and verifies the token (a 256-bit key no client role can
// read; see 20261002021000). Every refusal - malformed, forged, expired, or a
// member that no longer exists - is the same answer. The member can always
// change the choice back in Settings.
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { UNSUBSCRIBE_PATH, UNSUBSCRIBE_TOKEN } from "./_lib/engagementEmail.js";
import { json, methodGuard, secureHtml, supabaseRpc } from "./_lib/http.js";
import { brandText } from "./_lib/brand.js";

const COPY = {
  confirm: {
    title: "Stop these emails? / ¿Dejar de recibir estos correos?",
    announcements: [
      "Confirm that you no longer want union announcement emails. You will still see announcements in the app.",
      "Confirma que ya no quieres correos de anuncios del sindicato. Seguirás viendo los anuncios en la app.",
    ],
    surveys: [
      "Confirm that you no longer want survey emails. Open surveys stay available in the app.",
      "Confirma que ya no quieres correos de encuestas. Las encuestas abiertas siguen disponibles en la app.",
    ],
    welcome: [
      "Confirm that you no longer want welcome emails from your union.",
      "Confirma que ya no quieres correos de bienvenida de tu sindicato.",
    ],
    action: "Unsubscribe / Cancelar suscripción",
  },
  done: {
    title: "You are unsubscribed / Suscripción cancelada",
    announcements: [
      "Union announcement emails are off. You can turn them back on in Settings.",
      "Los correos de anuncios del sindicato están desactivados. Puedes volver a activarlos en Configuración.",
    ],
    surveys: [
      "Survey emails are off. You can turn them back on in Settings.",
      "Los correos de encuestas están desactivados. Puedes volver a activarlos en Configuración.",
    ],
    welcome: [
      "Welcome emails are off. You can turn them back on in Settings.",
      "Los correos de bienvenida están desactivados. Puedes volver a activarlos en Configuración.",
    ],
  },
  invalid: {
    title: "This link does not work / Este enlace no funciona",
    body: [
      "This unsubscribe link is not valid or has expired. You can change your email choices in Settings.",
      "Este enlace para cancelar la suscripción no es válido o ya venció. Puedes cambiar tus opciones de correo en Configuración.",
    ],
  },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function page(title, paragraphs, extra = "") {
  const body = paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>`
    + `<body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px">`
    + `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">${escapeHtml(brandText("UNION GROUND"))}</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25">${escapeHtml(title)}</h1>`
    + `${body}${extra}<p><a href="/m/settings" rel="noreferrer" style="color:#14201c">Settings / Configuración</a></p></main></body></html>`;
}

function tokenFrom(request) {
  const direct = request.query?.t;
  if (typeof direct === "string") return direct;
  try {
    return new URL(String(request.url || ""), "http://localhost").searchParams.get("t") || "";
  } catch {
    return "";
  }
}

function wantsHtml(request) {
  const headers = request.headers || {};
  return String(headers["sec-fetch-mode"] || "") === "navigate" || String(headers.accept || "").includes("text/html");
}

function refuse(request, response) {
  if (request.method === "GET" || wantsHtml(request)) return secureHtml(response, 400, page(COPY.invalid.title, COPY.invalid.body));
  return json(response, 400, { error: "invalid-unsubscribe-link" });
}

export default async function handler(request, response) {
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "Method not allowed." }))) return;
  const backend = resolveSupabaseBackend(request);
  // The links point at production; a SAMPLE host never holds a real choice.
  if (backend.surface === "demo") return json(response, 404, { error: "not-available" });
  const token = tokenFrom(request);
  if (!UNSUBSCRIBE_TOKEN.test(token)) return refuse(request, response);
  const category = token.split(".")[1];

  if (request.method === "GET") {
    const action = `${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
    const form = `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="min-height:48px;padding:12px 24px;border:0;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;font-size:16px">${escapeHtml(COPY.confirm.action)}</button></form>`;
    return secureHtml(response, 200, page(COPY.confirm.title, COPY.confirm[category], form));
  }

  if (!backend.url || !backend.serviceRoleKey) return json(response, 503, { error: "unsubscribe-unavailable" });
  let result;
  try {
    result = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "apply_engagement_email_unsubscribe",
      { p_token: token },
    );
  } catch {
    return json(response, 503, { error: "unsubscribe-unavailable" });
  }
  if (result?.applied !== true) return refuse(request, response);
  if (wantsHtml(request)) return secureHtml(response, 200, page(COPY.done.title, COPY.done[category]));
  return json(response, 200, { unsubscribed: true });
}
