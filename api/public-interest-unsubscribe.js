// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: RFC 8058
// one-click unsubscribe for the topic update emails a platform operator sends
// to the landing's opt-in list. Every email carries its own single-use stop
// token; the database holds only its SHA-256 digest, as a stop confirmation.
//
//   GET  ?t=<token>  a confirmation page only. Link scanners and preview bots
//                    fetch links, so a GET never changes anything; the page's
//                    button POSTs the same request a mail provider sends.
//   POST ?t=<token>  the existing stop: public.confirm_public_interest_unsubscribe
//                    charges its own per-network limit, refuses an unknown or
//                    expired token before any write, then runs
//                    public.confirm_public_interest_stop unchanged (suppress
//                    the address, delete every row for it). Mail providers
//                    POST "List-Unsubscribe=One-Click" from their own servers
//                    with no Origin and no session, so the token is the whole
//                    authority (classified in scripts/lib/api-origin-contract.mjs).
//
// Every refusal (malformed, unknown, expired or already used) is one answer,
// and no answer depends on whether the address is still subscribed.
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, secureHtml, supabaseRpc } from "./_lib/http.js";
import { UNSUBSCRIBE_ROUTE } from "./_lib/intakeTopicEmail.js";
import { publicInterestStopScope } from "./_lib/publicInterest.js";
import { STOP_CONFIRMATION_TOKEN, stopConfirmationDigest } from "./_lib/publicInterestStopConfirmation.js";

const COPY = {
  confirm: {
    title: "Stop these emails? / ¿Dejar de recibir estos correos?",
    body: [
      "Confirm that you want to stop all Union Ground public updates. Your address is removed from every update list and will not be added again.",
      "Confirma que quieres dejar de recibir todas las novedades públicas de Union Ground. Tu correo se quita de todas las listas de novedades y no se volverá a agregar.",
    ],
    action: "Unsubscribe / Cancelar suscripción",
  },
  done: {
    title: "You are unsubscribed / Suscripción cancelada",
    body: [
      "Union Ground will not send public updates to this address again.",
      "Union Ground no volverá a enviar novedades públicas a este correo.",
    ],
  },
  invalid: {
    title: "This link does not work / Este enlace no funciona",
    body: [
      "This unsubscribe link is not valid, has expired or was already used. To stop public updates, use the stop form on this site.",
      "Este enlace para cancelar la suscripción no es válido, ya venció o ya se usó. Para dejar de recibir novedades públicas, usa el formulario en este sitio.",
    ],
  },
  later: {
    title: "Try again in a few minutes / Inténtalo de nuevo en unos minutos",
    body: [
      "We could not finish this right now. Open the link again in a few minutes.",
      "No pudimos terminar esto ahora. Abre el enlace de nuevo en unos minutos.",
    ],
  },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function page({ title, body }, extra = "") {
  const paragraphs = body.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>`
    + `<body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px">`
    + `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">UNION GROUND</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25">${escapeHtml(title)}</h1>`
    + `${paragraphs}${extra}</main></body></html>`;
}

function tokenFrom(request) {
  const direct = request.query?.t;
  if (typeof direct === "string") return direct;
  try {
    return new URL(String(request.url || ""), "http://localhost").searchParams.get("t") || "";
  } catch { // swallow-ok: an unreadable URL carries no token, and the route refuses it
    return "";
  }
}

function wantsHtml(request) {
  const headers = request.headers || {};
  return String(headers["sec-fetch-mode"] || "") === "navigate" || String(headers.accept || "").includes("text/html");
}

function answer(request, response, status, copy, payload) {
  if (request.method === "GET" || wantsHtml(request)) return secureHtml(response, status, page(copy));
  return json(response, status, payload);
}

export default async function handler(request, response) {
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  // The links point at production; the SAMPLE host never holds the list.
  if (backend.surface === "demo") return json(response, 404, { error: "not-available" });
  const token = tokenFrom(request);
  if (!STOP_CONFIRMATION_TOKEN.test(token)) return answer(request, response, 400, COPY.invalid, { error: "invalid-unsubscribe-link" });

  if (request.method === "GET") {
    const action = `${UNSUBSCRIBE_ROUTE}?t=${encodeURIComponent(token)}`;
    const form = `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="min-height:48px;padding:12px 24px;border:0;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;font-size:16px">${escapeHtml(COPY.confirm.action)}</button></form>`;
    return secureHtml(response, 200, page(COPY.confirm, form));
  }

  const rateKey = String(process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET || "");
  if (!backend.url || !backend.serviceRoleKey || rateKey.length < 32) {
    return answer(request, response, 503, COPY.later, { error: "unsubscribe-unavailable" });
  }
  const scopeHash = publicInterestStopScope(request, rateKey);
  if (!scopeHash) return answer(request, response, 400, COPY.invalid, { error: "invalid-unsubscribe-link" });

  let result;
  try {
    result = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "confirm_public_interest_unsubscribe",
      { p_token_hash: stopConfirmationDigest(token), p_scope_hash: scopeHash },
    );
  } catch {
    return answer(request, response, 503, COPY.later, { error: "unsubscribe-unavailable" });
  }
  if (result?.confirmed === true) return answer(request, response, 200, COPY.done, { unsubscribed: true });
  if (result?.refusal === "rate-limited") return answer(request, response, 429, COPY.later, { error: "try-later" });
  return answer(request, response, 410, COPY.invalid, { error: "invalid-unsubscribe-link" });
}
