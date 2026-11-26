// REQ-UG-ENGAGEMENT-EMAIL-RESEND-BRIDGE-20261121: the receiver for
// api/engagement-delivery.js. That cron route posts one request per due
// engagement row (welcome step, broadcast, survey invitation or reminder) to
// ENGAGEMENT_EMAIL_WEBHOOK_URL with ENGAGEMENT_EMAIL_WEBHOOK_TOKEN as the
// bearer and the delivery uuid as Idempotency-Key
// .
// This endpoint of the same deployment checks that bearer, accepts only that
// request shape, and hands one message to Resend. Owner word "webhook ok",
// Sat Nov 21, 2026.
//
// Its answer drives the route's retry rules: 2xx records the row sent; 429
// retries in 15 minutes; any other status retries in 5 minutes with the SAME
// Resend idempotency key, so a message that did go out is never sent twice.
// Nothing here logs, and no answer carries an address, subject or body.
import { createHash, timingSafeEqual } from "node:crypto";
import { isDemoHost, isSaasHost, namedDemoOrigin } from "../src/lib/demoOrigin.js";
import {
  engagementEmailClass,
  UNSUBSCRIBE_ORIGIN,
  UNSUBSCRIBE_PATH,
  UNSUBSCRIBE_TOKEN,
  unsubscribeHeaders,
} from "./_lib/engagementEmail.js";
import { organizationFooterAddress } from "./_lib/emailTemplate.js";
import { json, methodGuard, requestHostname } from "./_lib/http.js";
import { serverCaller } from "./_lib/serverCaller.js";

export const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 8000; // inside the route's 12 s provider timeout
const MIN_TOKEN_LENGTH = 32;
const MAX_SAMPLE_RECIPIENTS = 5;
const SUBJECT_MAX = 300;
const TEXT_MAX = 100000;
const ACTION_PATH_MAX = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/;
// The deployment's own public origin (PUBLIC_SITE_APP_ORIGIN in .env.example).
const SAAS_ORIGIN = String(process.env.PUBLIC_SITE_APP_ORIGIN || "").replace(/\/$/, "");
const SAMPLE_ORIGIN = namedDemoOrigin();

const envValue = (env, key) => String(env?.[key] || "").trim();

const isControl = (character) => {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
};

function hasControl(text) {
  return [...text].some(isControl);
}

// A pasted form feed or other stray control character in an author's words
// must not make a row fail on every attempt. The body keeps its line breaks
// and tabs; a subject gets a space for them; anything else is dropped.
function bodyWithoutControls(text) {
  return [...text].filter((character) => character === "\n" || character === "\t" || !isControl(character)).join("");
}

function subjectWithoutControls(text) {
  return [...text].map((character) => (/[\r\n\t]/.test(character) ? " " : character))
    .filter((character) => !isControl(character)).join("");
}

function senderMailbox(value) {
  if (!value || /[\r\n,;]/.test(value)) return "";
  const named = /^[^<>]*<([^<>]+)>$/.exec(value);
  return ADDRESS.test((named ? named[1] : value).trim()) ? value : "";
}

// Both sides are hashed first, so the comparison takes the same time whatever
// the presented token's length or content.
function sameToken(presented, expected) {
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function presentedBearer(request) {
  const value = request?.headers?.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

// The SaaS host sends to the recipient the database chose. The SAMPLE host
// sends only to the operator test inbox list, and to nobody while that list is
// empty. Every other host (previews, loopback) is refused.
export function bridgeSurface(request, env = process.env) {
  const hostname = requestHostname(request);
  if (isSaasHost(hostname)) return { name: "saas", origin: SAAS_ORIGIN, recipients: null };
  if (!isDemoHost(hostname)) return null;
  const recipients = envValue(env, "ENGAGEMENT_EMAIL_BRIDGE_SAMPLE_RECIPIENTS").split(",")
    .map((address) => address.trim().toLowerCase()).filter(Boolean);
  const usable = recipients.length <= MAX_SAMPLE_RECIPIENTS
    && recipients.every((address) => address.length <= 254 && ADDRESS.test(address));
  return { name: "sample", origin: SAMPLE_ORIGIN, recipients: usable ? recipients : [] };
}

export function bridgeConfig(env = process.env) {
  const token = envValue(env, "ENGAGEMENT_EMAIL_WEBHOOK_TOKEN");
  const resendKey = envValue(env, "ENGAGEMENT_EMAIL_RESEND_API_KEY");
  const from = senderMailbox(envValue(env, "NOTIFY_FROM_ADDRESS"));
  return {
    token: token.length >= MIN_TOKEN_LENGTH ? token : "",
    // A separate send-only key that can be revoked on its own: the account's
    // existing key is never accepted in its place.
    resendKey: resendKey && resendKey !== envValue(env, "RESEND_API_KEY") ? resendKey : "",
    from,
    // Only for a request with no postalAddress key (a database the #9507
    // migration has not reached yet); removed in a later cleanup.
    postalAddress: envValue(env, "ORG_POSTAL_ADDRESS"),
  };
}

function parsedBody(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch { // swallow-ok: a body that is not JSON is the caller's error, answered 400
    return null;
  }
}

function sameHeaders(actual, expected) {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) => actual[key] === expected[key]);
}

function actionLink(path, origin) {
  if (typeof path !== "string" || path.length > ACTION_PATH_MAX) return "";
  if (!/^\/m(?:[/?#]|$)/.test(path) || /[\s\\]/.test(path) || hasControl(path)) return "";
  const url = new URL(path, origin);
  // Checked again after parsing: "/m/../admin" normalizes to "/admin".
  return url.origin === origin && /^\/m(?:\/|$)/.test(url.pathname) ? url.toString() : "";
}

// The route's request, checked field by field. Anything else is refused, so
// this endpoint can only ever send engagement-shaped mail with a working
// one-click unsubscribe link.
export function bridgeMessage(body, idempotencyKey, origin) {
  if (!body) return null;
  const deliveryId = body.metadata?.deliveryId;
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey) || deliveryId !== idempotencyKey) return null;
  const kind = body.metadata?.kind;
  const classification = engagementEmailClass(kind);
  if (!classification || body.category !== classification.category) return null;
  let unsubscribe;
  try {
    unsubscribe = new URL(String(body.unsubscribeUrl || ""));
  } catch { // swallow-ok: an unsubscribe link that is not a URL is the caller's error, answered 400
    return null;
  }
  const token = unsubscribe.searchParams.get("t") || "";
  if (unsubscribe.origin !== UNSUBSCRIBE_ORIGIN || unsubscribe.pathname !== UNSUBSCRIBE_PATH
      || [...unsubscribe.searchParams.keys()].length !== 1 || unsubscribe.hash
      || !UNSUBSCRIBE_TOKEN.test(token) || token.split(".")[1] !== classification.category
      || unsubscribe.toString() !== body.unsubscribeUrl) return null;
  const headers = unsubscribeHeaders(body.unsubscribeUrl);
  if (!sameHeaders(body.headers, headers)) return null;
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to || to.length > 254 || !ADDRESS.test(to)) return null;
  const subject = typeof body.subject === "string" ? subjectWithoutControls(body.subject).trim() : "";
  if (!subject || [...subject].length > SUBJECT_MAX) return null;
  const text = typeof body.text === "string" ? bodyWithoutControls(body.text.replace(/\r\n?/g, "\n")).trim() : "";
  if (!text || [...text].length > TEXT_MAX) return null;
  const link = actionLink(body.actionPath, origin);
  if (!link) return null;
  return {
    deliveryId,
    kind,
    category: classification.category,
    locale: body.locale === "es" ? "es" : "en",
    to,
    subject,
    text,
    link,
    unsubscribeUrl: body.unsubscribeUrl,
    headers,
    // #9507: the sending organization's own office address as the delivery
    // route forwards it; "" (no line) when it has none on file. Undefined
    // only when the request carries no key at all.
    postalAddress: Object.hasOwn(body, "postalAddress") ? organizationFooterAddress(body.postalAddress) : undefined,
  };
}

const COPY = Object.freeze({
  en: {
    eyebrow: { announcements: "UNION ANNOUNCEMENT", surveys: "SURVEY", welcome: "WELCOME" },
    action: { broadcast: "Read it in Union Ground", welcome: "Open Union Ground", survey_invitation: "Answer the survey", survey_reminder: "Answer the survey" },
    why: {
      announcements: "You get this because union announcement emails are on in your Union Ground settings.",
      surveys: "You get this because survey emails are on in your Union Ground settings.",
      welcome: "You get this because welcome emails are on in your Union Ground settings.",
    },
    unsubscribe: "Unsubscribe from these emails",
    settings: "Email settings",
    sample: "SAMPLE test send: only the operator test inbox receives this.",
  },
  es: {
    eyebrow: { announcements: "ANUNCIO DEL SINDICATO", surveys: "ENCUESTA", welcome: "BIENVENIDA" },
    action: { broadcast: "Leerlo en Union Ground", welcome: "Abrir Union Ground", survey_invitation: "Responder la encuesta", survey_reminder: "Responder la encuesta" },
    why: {
      announcements: "Recibes esto porque los correos de anuncios del sindicato están activados en tus ajustes de Union Ground.",
      surveys: "Recibes esto porque los correos de encuestas están activados en tus ajustes de Union Ground.",
      welcome: "Recibes esto porque los correos de bienvenida están activados en tus ajustes de Union Ground.",
    },
    unsubscribe: "Cancelar la suscripción a estos correos",
    settings: "Ajustes de correo",
    sample: "Envío de prueba de SAMPLE: solo la bandeja de prueba del operador recibe esto.",
  },
});

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// The author's subject and body inside a fixed Union Ground frame in the
// recipient's language. Raw hex values: email clients drop CSS variables (the
// same audited pairs as api/_lib/emailTemplate.js and intakeTopicEmail.js).
export function engagementEmail(message, { origin, postalAddress = "", sample = false }) {
  const copy = COPY[message.locale];
  const subject = sample ? `[SAMPLE] ${message.subject}` : message.subject;
  const action = copy.action[message.kind];
  const settingsUrl = `${origin}/m/settings`;
  const text = [
    message.text,
    "",
    `${action}: ${message.link}`,
    "",
    "--",
    copy.why[message.category],
    `${copy.unsubscribe}: ${message.unsubscribeUrl}`,
    `${copy.settings}: ${settingsUrl}`,
    ...(sample ? [copy.sample] : []),
    ...(postalAddress ? [postalAddress] : []),
  ].join("\n");
  const paragraphs = message.text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
    .map((block) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const footer = (content) => `<p style="margin:0 0 6px">${content}</p>`;
  const link = (href, label) => `<a href="${escapeHtml(href)}" rel="noreferrer" style="color:#14201c;font-weight:700;text-decoration:underline">${escapeHtml(label)}</a>`;
  const html = `<!doctype html><html lang="${message.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px">`
    + `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">UNION GROUND · ${escapeHtml(copy.eyebrow[message.category])}</p>`
    + `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(subject)}</h1>${paragraphs}`
    + `<a href="${escapeHtml(message.link)}" rel="noreferrer" style="display:inline-block;margin-top:8px;padding:14px 24px;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;text-decoration:none">${escapeHtml(action)}</a>`
    + `</td></tr></table>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.6;color:#4b5851">`
    + footer(`${escapeHtml(copy.why[message.category])} ${link(message.unsubscribeUrl, copy.unsubscribe)} · ${link(settingsUrl, copy.settings)}`)
    + (sample ? footer(escapeHtml(copy.sample)) : "")
    + (postalAddress ? footer(escapeHtml(postalAddress)) : "")
    + `</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// Resend keeps an idempotency key for 24 hours; the queue's 20 attempts at 5
// or 15 minute steps end well inside that, so every retry of one delivery
// reuses the first attempt's key.
export function resendIdempotencyKey(deliveryId) {
  return `ug-engagement-${deliveryId}`;
}

export default async function handler(request, response) {
  // Not validateMutationOrigin: Node's fetch, the only caller, sends
  // Sec-Fetch-Mode, which that check counts as a browser (R-9410).
  if (!serverCaller(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "Method not allowed." }))) return;
  const surface = bridgeSurface(request);
  if (!surface) return json(response, 403, { error: "untrusted-host" });
  const config = bridgeConfig();
  if (!config.token) return json(response, 503, { error: "Engagement email bridge is not configured." });
  if (!sameToken(presentedBearer(request), config.token)) return json(response, 401, { error: "Unauthorized." });
  if (!config.resendKey || !config.from) return json(response, 503, { error: "Engagement email bridge is not configured." });
  const message = bridgeMessage(parsedBody(request.body), request.headers?.["idempotency-key"], surface.origin);
  if (!message) return json(response, 400, { error: "invalid-request" });
  if (surface.recipients && !surface.recipients.includes(message.to.toLowerCase())) {
    return json(response, 403, { error: "recipient-not-allowed" });
  }
  const email = engagementEmail(message, {
    origin: surface.origin,
    postalAddress: message.postalAddress ?? config.postalAddress,
    sample: surface.name === "sample",
  });
  let resend;
  try {
    resend = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": resendIdempotencyKey(message.deliveryId),
      },
      body: JSON.stringify({ from: config.from, to: [message.to], ...email, headers: message.headers }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch { // swallow-ok: no answer may still mean sent; a 503 retries under the same idempotency key
    return json(response, 503, { error: "provider-unavailable" });
  }
  if (resend.ok) return json(response, 200, { sent: true });
  if (resend.status === 429) return json(response, 429, { error: "provider-rate-limited" });
  // 409 is a key still in flight (or reused): try later under the same key.
  if (resend.status === 409 || resend.status >= 500) return json(response, 503, { error: "provider-unavailable" });
  // Any other refusal (key, sender, validation) is an upstream problem for
  // the operator, kept apart from this endpoint's own 4xx refusals.
  return json(response, 502, { error: "provider-refused" });
}
