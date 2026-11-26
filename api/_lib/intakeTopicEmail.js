// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: the one update
// email a platform operator writes for a landing topic. This module renders
// it (the operator's subject and body inside a fixed Union Ground frame in the
// recipient's language), builds its unsubscribe link and headers, and sends it
// through the same Resend transport and sender (NOTIFY_FROM_ADDRESS) the
// landing's stop confirmation uses.
//
// Unsubscribe goes through the existing stop path: every delivery carries its
// own single-use stop token, whose SHA-256 digest the database records as a
// stop confirmation, and api/public-interest-unsubscribe.js confirms it with
// public.confirm_public_interest_stop. The raw token exists only in the email.
import { PUBLIC_POSTAL_ADDRESS } from "../../src/lib/publicContact.js";
import { stopConfirmationDigest, stopConfirmationToken } from "./publicInterestStopConfirmation.js";

export const TOPIC_UPDATE_TOPICS = Object.freeze(["chapter_updates", "public_meetings", "union_news"]);
export const TOPIC_UPDATE_SUBJECT_MAX = 150;
export const TOPIC_UPDATE_BODY_MAX = 5000;
export const UNSUBSCRIBE_ROUTE = "/api/public-interest-unsubscribe";

// The mailing address printed in these update emails: the deployment's own
// published postal address (src/lib/publicContact.js), or none. A deployment
// that sends bulk updates must publish one first; until then this is "".
const POSTAL = PUBLIC_POSTAL_ADDRESS;
export const TOPIC_UPDATE_MAILING_ADDRESS = POSTAL ? [
  POSTAL.name, ...(POSTAL.lines || []), `${POSTAL.city}, ${POSTAL.state} ${POSTAL.zip}`, POSTAL.country,
].filter(Boolean).join(", ") : "";

// The landing form's own names for the topics (landing.interest* in
// src/lib/i18n/locales/{en,es}/public.js).
const TOPIC_NAMES = Object.freeze({
  chapter_updates: { en: "Chapter updates", es: "Novedades de capítulos" },
  public_meetings: { en: "Public meetings", es: "Reuniones públicas" },
  union_news: { en: "Union news", es: "Noticias sindicales" },
});

const COPY = Object.freeze({
  en: {
    why: (topic) => `You are getting this because you asked Union Ground to keep you updated about ${topic} on this site.`,
    unsubscribe: "Unsubscribe",
    unsubscribeLine: "Unsubscribe from Union Ground public updates",
    test: "Test send: only you received this. In the real email this link is each person's own unsubscribe link.",
  },
  es: {
    why: (topic) => `Recibes este correo porque pediste a Union Ground que te mantenga al día sobre ${topic} en este sitio.`,
    unsubscribe: "Cancelar suscripción",
    unsubscribeLine: "Cancelar las novedades públicas de Union Ground",
    test: "Envío de prueba: solo tú lo recibiste. En el correo real, este enlace es el enlace personal de cada persona para cancelar la suscripción.",
  },
});

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function topicName(topic, locale = "en") {
  const names = TOPIC_NAMES[topic];
  if (!names) return "";
  return names[locale === "es" ? "es" : "en"];
}

// Mirrors private.intake_topic_update_content: CRLF and CR become LF, the
// subject is trimmed and single-line, the body trimmed; null when invalid.
export function cleanTopicUpdate({ topic, subject, body } = {}) {
  if (!TOPIC_UPDATE_TOPICS.includes(topic)) return null;
  if (typeof subject !== "string" || typeof body !== "string") return null;
  const cleanSubject = subject.trim();
  const cleanBody = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^[ \n\t]+|[ \n\t]+$/g, "");
  const control = (text, allowed) => [...text].some((character) => {
    if (allowed.includes(character)) return false;
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
  const subjectLength = [...cleanSubject].length;
  const bodyLength = [...cleanBody].length;
  if (subjectLength < 1 || subjectLength > TOPIC_UPDATE_SUBJECT_MAX || control(cleanSubject, "")) return null;
  if (bodyLength < 1 || bodyLength > TOPIC_UPDATE_BODY_MAX || control(cleanBody, "\n\t")) return null;
  return { topic, subject: cleanSubject, body: cleanBody };
}

export function unsubscribeToken() {
  const token = stopConfirmationToken();
  return { token, digest: stopConfirmationDigest(token) };
}

// RFC 8058: the visible link and the List-Unsubscribe target are one URL. A
// GET only shows a confirmation page; the POST (a mail provider's one-click,
// or the page's button) confirms the stop.
export function unsubscribeLink(origin, token) {
  const url = new URL(UNSUBSCRIBE_ROUTE, origin);
  url.searchParams.set("t", token);
  return url.toString();
}

export function topicUpdateHeaders(link) {
  return {
    "List-Unsubscribe": `<${link}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function paragraphs(body) {
  return body.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
}

/**
 * The email for one recipient (or the operator's test).
 * @param {object} o
 * @param {string} o.topic       chapter_updates | public_meetings | union_news
 * @param {string} o.subject     the operator's subject, already clean
 * @param {string} o.body        the operator's body, already clean
 * @param {"en"|"es"} o.locale   the frame's language (the recipient's form language)
 * @param {string} o.link        the unsubscribe link (a sample on a test)
 * @param {string} [o.address]   the mailing address line (Union Ground's own, by default)
 * @param {boolean} [o.test]     marks the operator's test send
 */
export function topicUpdateEmail({ topic, subject, body, locale, link, address = TOPIC_UPDATE_MAILING_ADDRESS, test = false }) {
  const lang = locale === "es" ? "es" : "en";
  const copy = COPY[lang];
  const name = topicName(topic, lang);
  const why = copy.why(name);
  const fullSubject = test ? `[Test] ${subject}` : subject;
  const text = [
    body,
    "",
    "--",
    why,
    `${copy.unsubscribeLine}: ${link}`,
    ...(test ? [copy.test] : []),
    address,
  ].join("\n");
  const bodyHtml = paragraphs(body)
    .map((block) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
  // The same audited raw token values as the stop confirmation email: email
  // clients do not support the app's CSS variables.
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(fullSubject)}</title></head>`
    + `<body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px">`
    + `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">UNION GROUND · ${escapeHtml(name.toUpperCase())}</p>`
    + `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(subject)}</h1>${bodyHtml}</td></tr></table>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.6;color:#4b5851">`
    + `<p style="margin:0 0 6px">${escapeHtml(why)} <a href="${escapeHtml(link)}" rel="noreferrer" style="color:#14201c;font-weight:700;text-decoration:underline">${escapeHtml(copy.unsubscribe)}</a></p>`
    + (test ? `<p style="margin:0 0 6px">${escapeHtml(copy.test)}</p>` : "")
    + `<p style="margin:0">${escapeHtml(address)}</p>`
    + `</td></tr></table></td></tr></table></body></html>`;
  return { subject: fullSubject, text, html };
}

/**
 * One Resend call. Answers "sent" when the provider accepted it, "retry" when
 * it declined it for now (429, so nothing went out), "failed" for a refusal
 * (any other 4xx), and "unknown" when there is no definite answer (no reply,
 * a timeout or a 5xx): the email may have gone out, so it is never resent
 * and its unsubscribe link must keep working.
 */
export async function sendTopicUpdateEmail({ resendKey, from, to, message, headers, idempotencyKey }) {
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], ...message, ...(headers ? { headers } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { // swallow-ok: an unanswered call may have been delivered; "unknown" records it without resending
    return "unknown";
  }
  // Only a definite answer decides: 2xx sent; 429 declined for now, retried;
  // any other 4xx refused. A 5xx says nothing about whether the email went
  // out, so it is "unknown": never resent, and its unsubscribe link stays valid.
  if (response.ok) return "sent";
  if (response.status === 429) return "retry";
  if (response.status >= 500) return "unknown";
  return "failed";
}
