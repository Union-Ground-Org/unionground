// Union Ground transactional email — the HTML layer the mailer never had.
//
// F1 (design review v5, part 2): api/notifications-dispatch.js sent `text:`
// only, so every one of the 38 bilingual email comps in the inherited design
// source (not part of this repository) was art nobody received. This module renders the comp shell from the
// same structure the comps use, so every mailer template (TEMPLATES in
// api/notifications-dispatch.js, one EYEBROW entry per kind below) can send a
// designed email without anyone hand-maintaining 38 HTML files. The mailer's
// copy stays the source of truth; this only gives it a shell.
//
// Email HTML cannot use --sg-* custom properties: Gmail strips <style> var()
// declarations and Outlook/Word never supported them. Every colour below is the
// raw hex of its token, named in the comment. Tables for layout, inline styles
// only, no shadows, no motion, Arial fallbacks after the brand families.
//
// Three deliberate departures from the comps and from the drop-in this file
// came from, each argued rather than assumed:
//
//   · Meta and footer text use SEC #4b5851 (7.46:1 on white), not MUTED
//     #8a938c (2.83:1). The comps use muted for the whole footer; the design
//     system rules muted decorative-only, and src/styles.css already repoints
//     --muted-foreground at --sg-color-sec for exactly this reason. F3.
//
//   · The logo is an absolute https URL, not `assets/logo-2x.png`. A relative
//     src in an email resolves against the mail client, i.e. nowhere. F2.
//
//   · NO webfont <link>. The drop-in loaded Archivo from fonts.googleapis.com,
//     which is a third-party request fired from the member's mail client on
//     open — a read receipt for Google on union mail, in an app that
//     deliberately self-hosts its two font files precisely so the web app makes
//     no such request. Most clients strip the link anyway, so the cost of
//     keeping it was privacy for nothing. The Arial stack below is what renders
//     in almost every client either way.
import { brandText } from "./brand.js";

const TOKEN = {
  canvas: "#f2f2f2",     // --sg-color-canvas (styles.css de-cream override)
  card: "#ffffff",       // --sg-color-card
  border: "#d1d1d1",     // --sg-color-border (styles.css de-cream override)
  ink: "#14201c",        // --sg-color-ink
  ink2: "#3d4a44",       // --sg-color-ink-2
  sec: "#4b5851",        // --sg-color-sec
  pine: "#0a2f26",       // --sg-color-pine
  green: "#0e4034",      // --sg-color-green
  gold: "#efa738",       // --sg-color-gold
  inkOnGold: "#241a08",  // --sg-color-ink-on-gold
  terraInk: "#a04a2c",   // --learn-terra-ink: accessible text on terraSoft (4.70:1)
  terraSoft: "#f4e0d7",  // --sg-color-terra-soft
  darkCanvas: "#101b16",
  darkInk: "#e6efe9",    // --rail-ink: the app's light-on-dark ink
  darkSec: "#93a79d",
  darkGold: "#efa738",
};

const DISPLAY = "'Archivo',Arial,Helvetica,sans-serif";
const BODY = "Arial,Helvetica,sans-serif";

// Per-locale chrome. Everything a member reads outside the message body lives
// here, so a new locale is one object, not a new file.
//
// GLOSSARY: a chapter is a "capítulo", never a "sección" — see the locked
// glossary at the top of src/lib/i18n.js (authority: the Bilingual design
// pass). An earlier sweep inverted this and rewrote the drop-in's correct
// "CAPÍTULO DDS" to "SECCIÓN DDS"; reverted 2026-07-31. This is the one
// surface a member cannot report a wording problem from, because it arrives
// in their inbox already sent — so the glossary test guards it.
//
// The header line names the product, never a specific organization: this is a
// multi-tenant product and, since open signup (D2e, 2026-09-25), mail can reach
// people in any tenant, so a hard-coded organization name would attach one
// real organization to everyone's mail.
const CHROME = {
  en: {
    org: "UNION GROUND",
    cta: "Open Union Ground",
    settings: "Notification settings",
    why: "You get this because you have Union Ground notifications on.",
  },
  es: {
    org: "UNION GROUND",
    cta: "Abrir Union Ground",
    settings: "Ajustes de notificaciones",
    why: "Recibes esto porque tienes activadas las notificaciones de Union Ground.",
  },
};

// Per-kind eyebrow. The keys are the mailer's TEMPLATES keys verbatim — plural.
// The drop-in used singular ones (`deadline`, `case`, `form`, `vote`, `event`),
// none of which the dispatcher ever passes, so every kind fell through to the
// `case` default and a deadline notice went out headed "CASE UPDATE". It looked
// right in review because the map read correctly on its own; only the join was
// wrong. tests/email-template.test.js asserts these keys against TEMPLATES so
// the two cannot drift again.
//
// Kept short: the eyebrow is a 10px all-caps chip, not a sentence.
// The words are Union Ground's organizing glossary (src/lib/i18n.js): an
// issue, a campaign meeting, a one-on-one, the workplace log. There is no dues
// kind: Union Ground leaves dues out (api/notifications-dispatch.js).
const EYEBROW = {
  deadlines: { en: "DEADLINE", es: "PLAZO" },
  cases: { en: "ISSUE UPDATE", es: "NOVEDAD DEL ASUNTO" },
  forms: { en: "FORM UPDATE", es: "NOVEDAD DEL FORMULARIO" },
  votes: { en: "VOTE", es: "VOTACIÓN" },
  events: { en: "CAMPAIGN MEETING", es: "REUNIÓN DE LA CAMPAÑA" },
  tasks: { en: "TASK UPDATE", es: "NOVEDAD DE TAREA" },
  appointments: { en: "ONE-ON-ONE", es: "REUNIÓN INDIVIDUAL" },
  workload: { en: "WORKPLACE LOG", es: "REGISTRO DEL CENTRO DE TRABAJO" },
  messages: { en: "CAMPAIGN CHANNELS", es: "CANALES DE LA CAMPAÑA" },
};

export { CHROME, EYEBROW };

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Preheader: what the inbox shows after the subject. Padded so the client does
// not pull the footer in after it.
function preheader(text) {
  const pad = "&zwnj;&nbsp;".repeat(40);
  return `<span style="display:none; font-size:1px; color:${TOKEN.canvas}; max-height:0; max-width:0; opacity:0; overflow:hidden;">${esc(text)}${pad}</span>`;
}

/**
 * The postal line, or nothing.
 *
 * Deliberately data-driven with NO default. The drop-in hardcoded a street
 * bulk-mail footer is worse than an absent one: it is a claim about a real
 * organisation, printed under its name, that the organisation did not make.
 *
 * The address is the sending organization's own (organizationFooterAddress
 * below), never another organization's (#9507). The deployment-wide
 * ORG_POSTAL_ADDRESS stands in only where the database does not yet return
 * the organization's address, until a later cleanup removes it.
 */
function postalLine(address) {
  if (!address) return "";
  return `<p style="font-family:${BODY}; font-size:11.5px; line-height:1.65; color:${TOKEN.sec}; margin:0;">${esc(address)}</p>`;
}

/**
 * The footer address of the organization that sends one message (#9507): its
 * own office address as stored with its local profile (at most 300
 * characters, no angle brackets, lines allowed), or "" when it has none or the
 * value is not a usable address. The lines of a multi-line address are joined
 * with commas so the footer stays one line in text and HTML.
 */
export function organizationFooterAddress(value) {
  if (typeof value !== "string" || value.length > 300) return "";
  const address = value.split(/\r\n|\r|\n/u).map((line) => line.trim()).filter(Boolean).join(", ");
  return address && !/[<>\p{Cc}]/u.test(address) ? address : "";
}

const trimSlash = (url) => String(url ?? "").replace(/\/$/, "");

/**
 * The app's settings route.
 *
 * APP_URL in the dispatcher is already `<portal origin>/m` — it ENDS in the
 * member prefix. The drop-in appended `/m/settings` to it, producing
 * `/m/m/settings`, a 404 in both the footer link and the List-Unsubscribe
 * header. Exported so the dispatcher builds the header from the same function
 * the body links to, rather than restating the path.
 */
export function settingsUrlFor(appUrl) {
  return `${trimSlash(appUrl)}/settings`;
}

/**
 * Render one transactional email.
 *
 * @param {object} o
 * @param {"deadlines"|"cases"|"forms"|"votes"|"events"|"tasks"|"appointments"|"workload"|"messages"} o.kind  mailer TEMPLATES key
 * @param {"en"|"es"} o.lang
 * @param {string} o.subject  reused as the <h1> and <title>
 * @param {string} o.body     the one paragraph the mailer already writes
 * @param {string} o.appUrl   absolute app URL (APP_URL in the mailer)
 * @param {string} [o.logoUrl] absolute logo; defaults to the app origin + /design/email-logo.png
 * @param {string} [o.address] postal line; omitted entirely when absent
 * @param {object} [o.chrome] per-message chrome for mail that is not a member
 *   notification (the organization-claim notices): any of `org`, `eyebrow`,
 *   `cta`, `why`, and `settings` (an empty `settings` drops the settings link).
 *   Absent keys keep the notification chrome above.
 * @returns {string} full HTML document
 */
export function renderEmail({ kind, lang, subject, body, appUrl, logoUrl, address, chrome }) {
  const L = CHROME[lang] ? lang : "en";
  const c = { ...brandText(CHROME[L]), ...(chrome || {}) };
  const eyebrow = chrome?.eyebrow || (EYEBROW[kind] || EYEBROW.cases)[L];
  // The logo lives at the site ROOT, not under /m. vercel.json already serves
  // /design outside the SPA catch-all.
  const origin = trimSlash(appUrl).replace(/\/m$/, "");
  const logo = logoUrl || `${origin}/design/email-logo.png`;
  const settings = settingsUrlFor(appUrl);

  return `<!DOCTYPE html>
<html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title><style>@media only screen and (max-width:480px){.sg-card{padding:24px 22px 22px !important;}.sg-h1{font-size:21px !important;}.sg-btn{width:100% !important;}.sg-btn a{text-align:center !important;}}@media (prefers-color-scheme:dark){body,.sg-canvas{background:${TOKEN.darkCanvas} !important;}.sg-wm{color:${TOKEN.darkInk} !important;}.sg-hdmeta{color:${TOKEN.darkSec} !important;}.sg-foot p{color:${TOKEN.darkSec} !important;}.sg-foot a{color:${TOKEN.darkGold} !important;}}[data-ogsc] .sg-wm{color:${TOKEN.darkInk} !important;}[data-ogsc] .sg-hdmeta{color:${TOKEN.darkSec} !important;}[data-ogsc] .sg-foot p{color:${TOKEN.darkSec} !important;}[data-ogsc] .sg-foot a{color:${TOKEN.darkGold} !important;}</style></head>
<body style="margin:0; padding:0; background:${TOKEN.canvas};" bgcolor="${TOKEN.canvas}">
${preheader(body)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sg-canvas" bgcolor="${TOKEN.canvas}"><tr><td align="center" style="padding:26px 14px 32px;"><!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;"><tr>
<td width="30" style="width:30px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="30" height="30" align="center" bgcolor="${TOKEN.pine}" style="border-radius:9px; line-height:0;"><img src="${esc(logo)}" width="30" height="30" alt="${esc(brandText("Union Ground"))}" style="display:block; border-radius:9px; border:0;"></td></tr></table></td>
<td class="sg-wm" style="padding-left:11px; font-family:${DISPLAY}; font-size:12.5px; font-weight:800; letter-spacing:.1em; color:${TOKEN.ink};">${brandText("UNION&nbsp;GROUND")}</td>
<td align="right" class="sg-hdmeta" style="font-family:${DISPLAY}; font-size:11px; font-weight:700; letter-spacing:.08em; color:${TOKEN.sec};">${esc(c.org)}</td>
</tr></table>
<div style="height:14px; line-height:14px; font-size:1px;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;"><tr><td bgcolor="${TOKEN.card}" class="sg-card" style="border:1px solid ${TOKEN.border}; border-radius:18px; padding:28px 32px 26px;">
<span style="display:inline-block; font-family:${DISPLAY}; font-size:11px; font-weight:800; letter-spacing:.08em; color:${TOKEN.terraInk}; background:${TOKEN.terraSoft}; padding:4px 9px; border-radius:6px;">${esc(eyebrow)}</span>
<h1 class="sg-h1" style="font-family:${DISPLAY}; font-size:24px; line-height:1.25; font-weight:800; letter-spacing:-0.3px; color:${TOKEN.ink}; margin:14px 0 12px;">${esc(subject)}</h1>
<p style="font-family:${BODY}; font-size:14.5px; line-height:1.62; color:${TOKEN.ink2}; margin:0 0 18px;">${esc(body)}</p>
<table role="presentation" class="sg-btn" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${TOKEN.gold}" style="border-radius:11px; mso-padding-alt:14px 30px;"><a href="${esc(appUrl)}" style="display:block; padding:14px 30px; font-family:${DISPLAY}; font-size:14px; font-weight:800; color:${TOKEN.inkOnGold}; text-decoration:none; border-radius:11px;">${esc(c.cta)}</a></td></tr></table>
</td></tr></table>
<div style="height:16px; line-height:16px; font-size:1px;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;"><tr><td class="sg-foot" style="padding:0 6px;">
<p style="font-family:${BODY}; font-size:11.5px; line-height:1.65; color:${TOKEN.sec}; margin:0 0 7px;">${esc(c.why)}${c.settings ? ` <a href="${esc(settings)}" style="color:${TOKEN.green}; font-weight:700; text-decoration:underline;">${esc(c.settings)}</a>` : ""}</p>
${postalLine(address)}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}

// The text part stays the source of truth for wording — the same string the
// mailer already sends, so HTML and text can never disagree about the message
// itself. Only the chrome (the CTA line, the why-line, the postal line) is
// added, and each one mirrors a block above.
export function renderText({ body, appUrl, lang, address, chrome }) {
  const c = { ...brandText(CHROME[CHROME[lang] ? lang : "en"]), ...(chrome || {}) };
  const lines = [body, "", `${c.cta}: ${appUrl}`, "", c.why];
  if (c.settings) lines.push(`${c.settings}: ${settingsUrlFor(appUrl)}`);
  if (address) lines.push(address);
  return lines.join("\n");
}
