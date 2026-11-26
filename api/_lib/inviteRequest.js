import { createHash } from "node:crypto";
import { brandText } from "./brand.js";
import { waitUntil } from "@vercel/functions";

// Request an invite: accounts are invitation-only (the "Invitation-only
// accounts contract"), so a person without an invitation asks the Union Ground
// team. Since November 18, 2026 (owner choice, REQ-UNIONGROUND-INTAKE-QUEUE-
// STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118) the request is stored for
// the platform operator's intake queue and also emailed to the team's support
// mailbox. Nothing is ever sent to the address the requester typed, so the form
// cannot be used to mail a third party.

// The legal path that turns the store on. It stays off until the privacy
// release that discloses it is live (content/legal/pending,
export const INVITE_REQUEST_STORE_PATH = "invite-request-store";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasControl(value, { allowNewlines = false } = {}) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    if (allowNewlines && (character === "\n" || character === "\r")) return false;
    // C0, DEL and C1: the same set the database rejects with [[:cntrl:]].
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function boundedText(value, min, max, options) {
  const text = String(value ?? "").trim();
  const length = [...text].length;
  if (length < min || length > max || hasControl(text, options)) return null;
  return text;
}

/** The validated request, or null when any field is out of bounds. */
export function inviteRequestFields(body) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return null;
  const name = boundedText(body?.name, 2, 120);
  const organization = boundedText(body?.organization, 2, 160);
  const note = boundedText(body?.note, 0, 1000, { allowNewlines: true });
  if (name === null || organization === null || note === null) return null;
  return {
    name,
    email,
    organization,
    note: note.replace(/\r\n?/g, "\n"),
    locale: body?.locale === "es" ? "es" : "en",
  };
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clip(value, max) {
  const characters = [...value];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : value;
}

/** The team-facing email. Every requester value is escaped. */
export function inviteRequestEmail(request, receivedAt) {
  const rows = [
    ["Name", request.name],
    ["Email", request.email],
    ["Organization", request.organization],
    ["Language", request.locale === "es" ? "Spanish" : "English"],
    ["Received", receivedAt],
  ];
  const note = request.note || "(none)";
  const intro = brandText("Someone asked for a Union Ground invitation. Reply to this email to reach them. To let them in, an organization administrator sends an invitation from Admin › Invite a member.");
  return {
    subject: clip(`Invite request: ${request.name} (${request.organization})`, 150),
    text: [intro, "", ...rows.map(([label, value]) => `${label}: ${value}`), "", "Note:", note].join("\n"),
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f2f2;color:#14201c;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d1d1d1;border-radius:16px"><tr><td style="padding:32px"><p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;color:#4b5851">${escapeHtml(brandText("UNION GROUND"))}</p><h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#14201c">Invite request</h1><p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#3d4a44">${escapeHtml(intro)}</p><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5;color:#14201c">${rows.map(([label, value]) => `<tr><td style="padding:3px 16px 3px 0;color:#4b5851;font-weight:700;vertical-align:top">${escapeHtml(label)}</td><td style="padding:3px 0;word-break:break-word">${escapeHtml(value)}</td></tr>`).join("")}</table><p style="margin:18px 0 6px;font-size:13px;font-weight:700;color:#4b5851">Note</p><p style="margin:0;font-size:15px;line-height:1.55;color:#3d4a44;white-space:pre-wrap;word-break:break-word">${escapeHtml(note)}</p></td></tr></table></td></tr></table></body></html>`,
  };
}

// Resend keeps an idempotency key for 24 hours, so the same address asking
// about the same organization more than once a day sends one email.
export function inviteRequestIdempotencyKey(request, day) {
  const digest = createHash("sha256")
    .update(`invite-request-v1\u001f${request.email}\u001f${request.organization.toLowerCase()}\u001f${day}`)
    .digest("hex");
  return `ug-invite-request-${digest.slice(0, 40)}`;
}

// The email after a stored request is best effort and never awaited: the
// stored row is the record, so a mail failure never fails the request and the
// answer takes the same time whether or not a row was stored. waitUntil keeps
// the function alive after the response on Vercel; anywhere else the promise
// simply runs detached. Returns the promise so tests can await the outcome.
export function scheduleInviteRequestEmail(options) {
  const pending = sendInviteRequestEmail(options).catch(() => false); // swallow-ok: the stored row is the record; a failed notice never fails it
  try { (options.waitUntilImpl || waitUntil)(pending); } catch { /* swallow-ok: outside the Vercel runtime the promise runs detached */ }
  return pending;
}

export async function sendInviteRequestEmail({ resendKey, from, to, request, now = new Date() }) {
  const receivedAt = `${now.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": inviteRequestIdempotencyKey(request, now.toISOString().slice(0, 10)),
    },
    body: JSON.stringify({ from, to: [to], reply_to: request.email, ...inviteRequestEmail(request, receivedAt) }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}
