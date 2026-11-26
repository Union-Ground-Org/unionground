import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appDownloadUrl, getAppPageUrl } from "../../src/lib/appDownloads.js";
import { authenticate, requestHostname, supabaseHeaders } from "./http.js";
import { requestNetworkBucket } from "./networkAddress.js";
import { qrPng } from "./qrPng.js";
import { emailedAuthLink } from "../../src/lib/emailedAuthLink.js";
import { brandText } from "./brand.js";

export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROOF_EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
// Union Ground has no sample backend, so the sample invitation proof is always off.
const SAMPLE_INVITATION_BACKEND = "";
const SAMPLE_INVITATION_ORIGIN = "https://demo.example.com";

function senderMailbox(value) {
  if (typeof value !== "string" || /[\r\n,;*]/.test(value)) return null;
  const singleFrom = /^[^<>]*<([^<>]+)>$/.exec(value.trim());
  const mailbox = (singleFrom ? singleFrom[1] : value).trim();
  if (/["\\]/.test(mailbox)) return null;
  return PROOF_EMAIL.test(mailbox) ? mailbox.toLowerCase() : null;
}

// Owner-approved acceptance proof only. Normal demo behavior stays unavailable;
// this opt-in is short-lived and never borrows SaaS mail, origin or auth keys.
export function invitationRuntimeConfig(request, backend, env = process.env) {
  if (backend.surface !== "demo") return {
    supabaseUrl: backend.url,
    publishableKey: backend.publishableKey,
    serviceKey: backend.serviceRoleKey,
    appOrigin: String(env.INVITATION_APP_ORIGIN || "").replace(/\/$/, ""),
    resendKey: env.RESEND_API_KEY,
    from: env.NOTIFY_FROM_ADDRESS,
    notifyFrom: env.NOTIFY_FROM_ADDRESS,
    rateKey: env.INVITATION_RATE_LIMIT_SECRET,
    sampleProof: false,
  };
  if (env.SAMPLE_INVITATION_PROOF_ENABLED !== "true"
      || !SAMPLE_INVITATION_BACKEND || backend.url !== SAMPLE_INVITATION_BACKEND
      || requestHostname(request) !== "demo.example.com"
      || request.headers?.origin !== SAMPLE_INVITATION_ORIGIN
      || env.SAMPLE_INVITATION_APP_ORIGIN !== SAMPLE_INVITATION_ORIGIN) return null;
  const expires = Date.parse(env.SAMPLE_INVITATION_PROOF_EXPIRES_AT || "");
  if (!Number.isFinite(expires) || expires <= Date.now()
      || expires > Date.now() + 24 * 60 * 60 * 1000) return null;
  const values = [backend.publishableKey, backend.serviceRoleKey,
    env.SAMPLE_INVITATION_RESEND_API_KEY, env.SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS,
    env.SAMPLE_INVITATION_RATE_LIMIT_SECRET];
  if (values.some((value) => typeof value !== "string" || !value.trim() || value !== value.trim())) return null;
  const proofSender = senderMailbox(env.SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS);
  const productionSender = senderMailbox(env.NOTIFY_FROM_ADDRESS);
  if (backend.publishableKey === String(env.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim()
      || backend.serviceRoleKey === String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
      || env.SAMPLE_INVITATION_RESEND_API_KEY === String(env.RESEND_API_KEY || "").trim()
      || (env.NOTIFY_FROM_ADDRESS !== undefined && !productionSender)
      || !proofSender || proofSender === productionSender
      || env.SAMPLE_INVITATION_RATE_LIMIT_SECRET === String(env.INVITATION_RATE_LIMIT_SECRET || "").trim()
      || env.SAMPLE_INVITATION_RATE_LIMIT_SECRET.length < 32
      || /[\r\n]/.test(env.SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS)) return null;
  const recipients = String(env.SAMPLE_INVITATION_ALLOWED_EMAILS || "").split(",")
    .map((email) => email.trim().toLowerCase());
  if (recipients.length > 5 || recipients.some((email) => email.length > 254
    || /[*;,]/.test(email) || !PROOF_EMAIL.test(email))) return null;
  return {
    supabaseUrl: backend.url,
    publishableKey: backend.publishableKey,
    serviceKey: backend.serviceRoleKey,
    appOrigin: SAMPLE_INVITATION_ORIGIN,
    resendKey: env.SAMPLE_INVITATION_RESEND_API_KEY,
    from: env.SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS,
    notifyFrom: env.SAMPLE_INVITATION_NOTIFY_FROM_ADDRESS,
    rateKey: env.SAMPLE_INVITATION_RATE_LIMIT_SECRET,
    sampleProof: true,
    allowedRecipients: recipients,
  };
}

export function invitationRecipientAllowed(config, email) {
  return !config.sampleProof || (typeof email === "string" && !/[\r\n,;<>]/.test(email)
    && config.allowedRecipients.includes(email.trim().toLowerCase()));
}

export function invitationSecret() {
  return randomBytes(32).toString("base64url");
}

export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function acceptanceScope(request, key) {
  const network = requestNetworkBucket(request);
  if (!network) return null;
  return createHmac("sha256", key).update(`member-invitation-accept-v1:${network}`).digest("hex");
}

export function invitationUrl(origin, token) {
  return emailedAuthLink(origin, "invitation", token);
}

const COPY = {
  en: {
    subject: "{organization}: your Union Ground invitation",
    heading: "Join {organization} on Union Ground",
    administrator: "Invitation sent by {inviter} through Union Ground.",
    scim: "This invitation was created by your organization's sign-in system.",
    founder: "Union Ground is inviting you to set up {organization} as its first administrator.",
    partner: "{chapter} asked Union Ground to invite you, so the two of you can work together here.",
    partnerOffer: "{chapter} also left a standing handshake offer for you: \"{offer}\". Once your organization is set up and verified on Union Ground, you can accept or decline it there. Nothing is accepted for you.",
    body: "Union Ground is a workspace for your organization's messages, resources and chapter work. Accept this invitation to join {organization}. If you're new to Union Ground, accepting creates your account and we'll email your sign-in password separately. Then sign in on the website or phone app with your email address and password. {lifetime} If you did not expect this invitation, you can ignore this email.",
    lifetime: "This private link expires in 15 minutes and works once.",
    rosterLifetime: "This private link expires in 7 days and works once.",
    organization: "your organization",
    inviter: "an administrator",
    // #8171: a member-sent invitation whose sender's name could not be read.
    memberInviter: "a member of {organization}",
    // #9046: Union Ground is the sender of a member's invitation; the member's
    // own profile name is labelled as a member's, never as an administrator's.
    member: "Union Ground sent this invitation on behalf of {inviter}.",
    memberNamed: "{name}, a member of {organization}",
    action: "Accept invitation",
  },
  es: {
    subject: "{organization}: tu invitación a Union Ground",
    heading: "Únete a {organization} en Union Ground",
    administrator: "Invitación enviada por {inviter} a través de Union Ground.",
    scim: "Esta invitación fue creada por el sistema de acceso de tu organización.",
    founder: "Union Ground te invita a configurar {organization} como su primera persona administradora.",
    partner: "{chapter} pidió a Union Ground que te invitara para que puedan trabajar juntos aquí.",
    partnerOffer: "{chapter} también dejó para ti una oferta de acuerdo permanente: \"{offer}\". Cuando tu organización esté configurada y verificada en Union Ground, podrás aceptarla o rechazarla allí. Nada se acepta en tu nombre.",
    body: "Union Ground es un espacio para los mensajes, los recursos y el trabajo de los capítulos de tu organización. Acepta esta invitación para unirte a {organization}. Si es tu primera vez en Union Ground, al aceptar se crea tu cuenta y te enviaremos tu contraseña de acceso en otro correo. Después, entra en el sitio web o en la app con tu correo y contraseña. {lifetime} Si no esperabas esta invitación, puedes ignorar este correo.",
    lifetime: "Este enlace privado vence en 15 minutos y funciona una sola vez.",
    rosterLifetime: "Este enlace privado vence en 7 días y funciona una sola vez.",
    organization: "tu organización",
    inviter: "una persona administradora",
    memberInviter: "una persona de {organization}",
    member: "Union Ground envió esta invitación en nombre de {inviter}.",
    memberNamed: "{name}, una persona de {organization}",
    action: "Aceptar invitación",
  },
};

const PASSWORD_COPY = {
  en: {
    subject: "Your Union Ground sign-in password",
    heading: "Your sign-in password",
    body: "Use your email address and this password to sign in on the website or the Union Ground phone app. Change it after you sign in. If you did not expect this email, contact your campaign administrator.",
    label: "Temporary password",
    reissueSubject: "Your new Union Ground sign-in password",
    replaces: "This password replaces any temporary password sent to you before. Sent {time}. If you have several of these emails, only the newest one works.",
  },
  es: {
    subject: "Tu contraseña de Union Ground",
    heading: "Tu contraseña de acceso",
    body: "Usa tu correo y esta contraseña para entrar en el sitio o en la app de Union Ground. Cámbiala después de entrar. Si no esperabas este correo, comunícate con la administración de tu campaña.",
    label: "Contraseña temporal",
    reissueSubject: "Tu nueva contraseña de Union Ground",
    replaces: "Esta contraseña reemplaza cualquier contraseña temporal que te hayamos enviado antes. Enviada el {time}. Si tienes varios de estos correos, solo funciona el más reciente.",
  },
};

// REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006 (reissue half): a
// member holding several administrator-sent passwords must be able to tell
// which one is current. Eastern time, labelled, as the invite-request email does.
// Preserve milliseconds from the staged instant: completed reissues can occur
// within one second, and members need to distinguish those emails.
// The UTC instant follows in parentheses: in the hour clocks fall back,
// 1:30:50 AM EDT comes before 1:30:10 AM EST, so the Eastern clock alone
// cannot order two emails, while "YYYY-MM-DD hh:mm:ss.sss UTC" always can.
function passwordSentAt(lang, sentAt) {
  const eastern = sentAt.toLocaleString(lang === "es" ? "es-US" : "en-US", {
    timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
    timeZoneName: "short",
  });
  return `${eastern} (${sentAt.toISOString().slice(0, 23).replace("T", " ")} UTC)`;
}

// The "Get Union Ground" block the invitation and first-password emails end
// with: a QR code that opens the public /get-app page on a phone, plus the website
// and phone-app links. The QR encodes only that public page, never the private
// invitation link. Mail sent without an app origin (a password reissue) omits it.
const APPS_COPY = {
  en: {
    heading: "Get Union Ground",
    invite: "After you accept, use Union Ground on the website or on your phone.",
    password: "Sign in on the website or on your phone.",
    scan: "Scan this code with your phone's camera, or use these links.",
    website: "Website",
    ios: "iPhone app",
    android: "Android app",
    phone: "On your phone",
    qrAlt: "QR code that opens the Union Ground phone page",
  },
  es: {
    heading: "Obtén Union Ground",
    invite: "Después de aceptar, usa Union Ground en el sitio web o en tu teléfono.",
    password: "Entra en el sitio web o en tu teléfono.",
    scan: "Escanea este código con la cámara de tu teléfono o usa estos enlaces.",
    website: "Sitio web",
    ios: "App para iPhone",
    android: "App para Android",
    phone: "En tu teléfono",
    qrAlt: "Código QR que abre la página de Union Ground para teléfonos",
  },
};

export const APP_QR_CONTENT_ID = "union-ground-app-qr";
const APP_QR_SIZE = 132;

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function appLinks(lang, appOrigin) {
  const copy = brandText(APPS_COPY[lang]);
  const origin = new URL(appOrigin);
  return [
    { label: copy.website, href: origin.toString(), text: origin.host },
    ...["ios", "android"].flatMap((platform) => {
      const href = appDownloadUrl(platform);
      return href ? [{ label: copy[platform], href, text: new URL(href).host }] : [];
    }),
    { label: copy.phone, href: getAppPageUrl(origin), text: `${origin.host}/get-app` },
  ];
}

function appsText(lang, kind, appOrigin) {
  if (!appOrigin) return "";
  const copy = brandText(APPS_COPY[lang]);
  const lines = appLinks(lang, appOrigin).map((link) => `${link.label}: ${link.href}`);
  return `\n\n${copy.heading}\n${copy[kind]}\n\n${lines.join("\n")}`;
}

function appsHtml(lang, kind, appOrigin) {
  if (!appOrigin) return "";
  const copy = brandText(APPS_COPY[lang]);
  const links = appLinks(lang, appOrigin).map((link) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#3d4a44">${escapeHtml(link.label)}: <a href="${escapeHtml(link.href)}" rel="noreferrer" style="color:#0e4034;font-weight:700">${escapeHtml(link.text)}</a></p>`).join("");
  // QR artwork is pure black on white (see CheckinQrCode.jsx); the text keeps
  // the template's checked dark-on-white pairs.
  return `<tr><td style="padding:0 32px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #d1d1d1"><tr><td width="${APP_QR_SIZE}" valign="top" style="padding:22px 18px 0 0"><img src="cid:${APP_QR_CONTENT_ID}" width="${APP_QR_SIZE}" height="${APP_QR_SIZE}" alt="${escapeHtml(copy.qrAlt)}" style="display:block;border:0;background:#ffffff"></td><td valign="top" style="padding-top:22px"><h2 style="margin:0 0 8px;font-size:18px;line-height:1.3;color:#14201c">${escapeHtml(copy.heading)}</h2><p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#3d4a44">${escapeHtml(`${copy[kind]} ${copy.scan}`)}</p>${links}</td></tr></table></td></tr>`;
}

/** The inline QR attachment the apps block references (Resend `content_id`). */
export function appQrAttachments(appOrigin) {
  if (!appOrigin) return {};
  return {
    attachments: [{
      filename: "union-ground-app.png",
      content: qrPng(getAppPageUrl(appOrigin)).png.toString("base64"),
      content_id: APP_QR_CONTENT_ID,
    }],
  };
}

// Only display names enter the copy. In particular, a profile whose display
// name is an email address must not disclose that address to an invitee.
function invitationName(value, { allowAt = false } = {}) {
  return typeof value === "string" && value.trim() && value.length <= 160
    && ![...value].some((character) => character.charCodeAt(0) < 32
      || character.charCodeAt(0) === 127 || (!allowAt && character === "@")) ? value.trim() : null;
}

async function invitationRead(supabaseUrl, key, token, path) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: supabaseHeaders(key, token), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("invitation-names-unavailable");
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invitation-names-unavailable");
  return rows[0];
}

// Called only after the invitation RPC authorized the desk action. Every read
// uses the caller's existing token/RLS, never the service key or request names.
export async function deskInvitationNames(supabaseUrl, key, token) {
  const user = await authenticate(supabaseUrl, key, token);
  if (!UUID.test(user?.id || "")) throw new Error("invitation-names-unavailable");
  const profile = await invitationRead(supabaseUrl, key, token,
    `member_profiles?select=full_name,chapters(organizations!chapters_organization_id_fkey(name))&id=eq.${user.id}&limit=1`);
  const organization = invitationName(profile.chapters?.organizations?.name, { allowAt: true });
  if (!organization) throw new Error("invitation-names-unavailable");
  return { organization, inviter: invitationName(profile.full_name), source: "administrator" };
}

// The id comes from SCIM authentication or the successful founder RPC, not
// from an invitation request's JSON. These paths already hold the service key.
async function invitationOrganizationName({ supabaseUrl, serviceKey, organizationId }) {
  if (!UUID.test(organizationId || "")) throw new Error("invitation-names-unavailable");
  const row = await invitationRead(supabaseUrl, serviceKey, serviceKey,
    `organizations?select=name&id=eq.${organizationId}&limit=1`);
  const name = invitationName(row.name, { allowAt: true });
  if (!name) throw new Error("invitation-names-unavailable");
  return name;
}

export function invitationEmail(locale, link, appOrigin, names = {}) {
  const lang = locale === "es" ? "es" : "en";
  const localized = brandText(COPY[lang]);
  const organization = invitationName(names.organization, { allowAt: true }) || localized.organization;
  const named = invitationName(names.inviter);
  const inviter = names.source === "member"
    ? (named ? localized.memberNamed : localized.memberInviter)
      .replace(/\{name\}|\{organization\}/g, (slot) => slot === "{name}" ? named : organization)
    : named || localized.inviter;
  // A roster-import invitation's link lasts 7 days (UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018);
  // every other invitation's lasts 15 minutes.
  const lifetime = names.rosterLink === true ? localized.rosterLifetime : localized.lifetime;
  const fill = (value) => value.replace(/\{organization\}|\{inviter\}|\{lifetime\}/g,
    (slot) => slot === "{organization}" ? organization : slot === "{lifetime}" ? lifetime : inviter);
  const source = ["scim", "founder", "member"].includes(names.source) ? names.source : "administrator";
  // A founder invitation a chapter asked for (REQ-UNIONGROUND-INVITE-AND-
  // STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031) names that
  // chapter and its standing offer, and nothing else about it.
  const partnerChapter = source === "founder" ? invitationName(names.partnerChapter) : null;
  const partnerOffer = partnerChapter ? invitationName(names.partnerOffer, { allowAt: true }) : null;
  const partner = partnerChapter ? [localized.partner, ...(partnerOffer ? [localized.partnerOffer] : [])]
    .map((line) => line.replace(/\{chapter\}|\{offer\}/g, (slot) => slot === "{chapter}" ? partnerChapter : partnerOffer)).join(" ") : "";
  const copy = {
    subject: fill(localized.subject), heading: fill(localized.heading), action: localized.action,
    body: [fill(localized[source]), partner, fill(localized.body)].filter(Boolean).join(" "),
  };
  const safeLink = escapeHtml(link);
  return {
    subject: copy.subject,
    text: `${copy.heading}\n\n${copy.body}\n\n${copy.action}: ${link}${appsText(lang, "invite", appOrigin)}`,
    // Email clients do not reliably support app CSS variables, so this small
    // transactional template uses the same audited raw token values as the
    // existing mail renderer. Text is dark-on-white and the CTA is
    // #241a08-on-#efa738 (the repository's checked ink-on-gold pair).
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">${escapeHtml(brandText("UNION GROUND"))}</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.body)}</p><a href="${safeLink}" rel="noreferrer" style="display:inline-block;min-height:20px;padding:14px 24px;border-radius:10px;background:#efa738;color:#241a08;font-weight:700;text-decoration:none">${escapeHtml(copy.action)}</a></td></tr>${appsHtml(lang, "invite", appOrigin)}</table></td></tr></table></body></html>`,
  };
}

export async function sendInvitationEmail({ resendKey, from, to, locale, link, appOrigin, invitationId, deliveryVersion, names, organizationLookup }) {
  const context = organizationLookup
    ? { ...names, organization: await invitationOrganizationName(organizationLookup) } : names;
  const template = invitationEmail(locale, link, appOrigin, context);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sg-invite-${invitationId}-${deliveryVersion}`,
    },
    body: JSON.stringify({ from, to: [to], ...template, ...appQrAttachments(appOrigin) }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

export function generateMemberPassword() {
  // 192 random bits, encoded without punctuation that email clients commonly
  // wrap or autocorrect. The value is never logged, stored in PostgreSQL, or
  // returned to a browser.
  return randomBytes(24).toString("base64url");
}

// `reissuedAt` (a Date) marks an administrator reissue: the email then says it
// replaces every earlier temporary password and when it was sent.
export function signInPasswordEmail(locale, password, appOrigin, { reissuedAt = null } = {}) {
  const lang = locale === "es" ? "es" : "en";
  const copy = brandText(PASSWORD_COPY[lang]);
  const replaces = reissuedAt ? copy.replaces.replace("{time}", passwordSentAt(lang, reissuedAt)) : "";
  return {
    subject: reissuedAt ? copy.reissueSubject : copy.subject,
    text: `${copy.heading}\n\n${copy.body}${replaces ? `\n\n${replaces}` : ""}\n\n${copy.label}: ${password}${appsText(lang, "password", appOrigin)}`,
    html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#14201c">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#3d4a44">${escapeHtml(copy.body)}</p>${replaces ? `<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#14201c;font-weight:700">${escapeHtml(replaces)}</p>` : ""}<p style="margin:0 0 6px;font:700 12px/1.4 Arial,Helvetica,sans-serif;color:#4b5851">${escapeHtml(copy.label)}:</p><p style="margin:0;padding:14px;border-radius:10px;background:#f5f3f6;font:700 17px/1.4 Consolas,monospace;color:#14201c;word-break:break-all">${escapeHtml(password)}</p></td></tr>${appsHtml(lang, "password", appOrigin)}</table></td></tr></table></body></html>`,
  };
}

export async function sendSignInPasswordEmail({ resendKey, from, to, locale, password, appOrigin, invitationId, reissuedAt = null }) {
  const template = signInPasswordEmail(locale, password, appOrigin, { reissuedAt });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
      // A delivery reference must not disclose even a partial password hash.
      // Like reset mail, each newly issued message has an independent ID.
      "Idempotency-Key": `ug-password-${invitationId}-${randomUUID()}`,
    },
    body: JSON.stringify({ from, to: [to], ...template, ...appQrAttachments(appOrigin) }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

export function authAdminHeaders(serviceKey) {
  return {
    ...supabaseHeaders(serviceKey),
    "Content-Type": "application/json",
    "User-Agent": "UnionGround-Server/1.0",
  };
}

export async function generateAuthLink(supabaseUrl, serviceKey, invitation, appOrigin) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      type: "magiclink",
      email: invitation.normalizedEmail,
      data: {
        full_name: invitation.fullName,
        first_name: invitation.firstName,
        initials: invitation.initials,
        chapter_id: invitation.chapterId,
        union_base_invitation_id: invitation.invitationId,
      },
      redirect_to: `${appOrigin}/m`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  try {
    const payload = await response.json();
    // GoTrue's wire response puts user fields at the top level. auth-js moves
    // those fields under `data.user`; accept either shape so a supported SDK
    // proxy does not change the security validation.
    return {
      ...payload,
      user: payload.user ?? {
        id: payload.id,
        email: payload.email,
        user_metadata: payload.user_metadata,
      },
    };
  } catch {
    return null;
  }
}

// The emailed password tells the member to change it. This user_metadata
// marker records when the emailed password was issued so the web Home can ask
// the member to choose their own; the member's password change clears it
// (src/views/SettingsView.jsx), and so does a completed self-service reset,
// with the service role (api/password-reset.js). It is a prompt only: user_metadata is
// member-writable, so nothing authorizes on it. The same key is read at
// src/features/memberHome/ChoosePasswordCard.jsx.
export const PASSWORD_ISSUED_KEY = "union_ground_password_issued_at";

export async function createPasswordAuthUser(supabaseUrl, serviceKey, invitation, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      email: invitation.normalizedEmail,
      password,
      email_confirm: true,
      ban_duration: "876000h",
      user_metadata: {
        full_name: invitation.fullName,
        first_name: invitation.firstName,
        initials: invitation.initials,
        chapter_id: invitation.chapterId,
        union_base_invitation_id: invitation.invitationId,
        [PASSWORD_ISSUED_KEY]: new Date().toISOString(),
      },
      app_metadata: { union_ground_provisioning: "pending" },
    }),
    signal: AbortSignal.timeout(8000),
  });
  // A timeout/server failure or an unreadable success reply may follow a
  // committed create, and a rate limit (429) is no answer at all. Throw so
  // acceptance keeps its lease for exact-user recovery, instead of clearing
  // the only token that can recover that user.
  if (!response.ok) {
    if ([408, 429].includes(response.status) || response.status >= 500) throw new Error("auth-create-unconfirmed");
    return null;
  }
  const payload = await response.json();
  const userId = payload?.user?.id ?? payload?.id;
  if (!UUID.test(String(userId || ""))) throw new Error("auth-create-unconfirmed");
  return payload;
}

export async function activatePasswordAuthUser(supabaseUrl, serviceKey, userId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      ban_duration: "none",
      app_metadata: { union_ground_provisioning: "active" },
    }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

export async function suspendPasswordAuthUser(supabaseUrl, serviceKey, userId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      ban_duration: "876000h",
      app_metadata: { union_ground_provisioning: "pending" },
    }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

export async function stageAuthUserPassword(supabaseUrl, serviceKey, user, password, operationId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      password,
      // Install the new credential while the provider-enforced recovery ban is
      // still active. The credential is not emailed until this update is
      // confirmed, so a later delivery failure cannot expose an unusable
      // password or leave an active account on an unknown credential.
      ban_duration: "876000h",
      // GoTrue merges user_metadata, so this adds the marker and keeps the rest.
      user_metadata: { [PASSWORD_ISSUED_KEY]: new Date().toISOString() },
      app_metadata: {
        ...(user.app_metadata || {}),
        union_ground_provisioning: "active",
        union_ground_password_reissue_operation_id: operationId,
        member_signin_recovery_operation_id: operationId,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

export async function activateStagedAuthUserPassword(supabaseUrl, serviceKey, user, operationId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: authAdminHeaders(serviceKey),
    body: JSON.stringify({
      ban_duration: "none",
      app_metadata: {
        ...(user.app_metadata || {}),
        union_ground_provisioning: "active",
        union_ground_password_reissue_operation_id: operationId,
        member_signin_recovery_operation_id: null,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

export async function deleteAuthUser(supabaseUrl, serviceKey, userId) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: authAdminHeaders(serviceKey),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

export function invitationOwnedGeneratedUser(payload, invitation) {
  const user = payload?.user;
  return UUID.test(String(user?.id || ""))
    && String(user?.email || "").toLowerCase() === invitation.normalizedEmail
    && user?.user_metadata?.union_base_invitation_id === invitation.invitationId
    && user?.user_metadata?.chapter_id === invitation.chapterId;
}

export function invitationOwnedPasswordUser(payload, invitation) {
  const user = payload?.user ?? payload;
  return UUID.test(String(user?.id || ""))
    && String(user?.email || "").toLowerCase() === invitation.normalizedEmail
    && user?.user_metadata?.union_base_invitation_id === invitation.invitationId
    && user?.user_metadata?.chapter_id === invitation.chapterId
    && user?.app_metadata?.union_ground_provisioning === "pending";
}

export function validGeneratedLink(payload, supabaseUrl, invitation) {
  try {
    const action = new URL(payload?.action_link);
    const expected = new URL(supabaseUrl);
    return action.origin === expected.origin
      && action.pathname === "/auth/v1/verify"
      && invitationOwnedGeneratedUser(payload, invitation);
  } catch {
    return false;
  }
}
