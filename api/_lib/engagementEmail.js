import { portalOrigin } from "../../src/lib/demoOrigin.js";

// SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001
//
// Engagement email (broadcasts, welcome-campaign steps, survey invitations and
// reminders) is optional member mail. Each kind maps to one of the member's three
// email choices in member_profiles.notification_prefs (welcome mail has its own
// since 20261003031000), and every message
// carries an RFC 8058 one-click unsubscribe link for that choice. This module
// mirrors private.engagement_email_category in
// supabase/migrations/20261002021000_engagement_email_opt_out_and_steward_deadline_reminders.sql
// as amended by 20261003031000_welcome_sequence_scheduler.sql.
//
// None of these kinds is transactional or legally required. Transactional mail
// (invitations, first password, sign-in recovery, security notices) and the
// case and deadline notification plane (api/notifications-dispatch.js) never
// enter the engagement outbox, so they are outside this opt-out by
// construction, not by an exemption flag here.
export const ENGAGEMENT_EMAIL_CLASSES = Object.freeze({
  broadcast: Object.freeze({ category: "announcements", transactional: false }),
  welcome: Object.freeze({ category: "welcome", transactional: false }),
  survey_invitation: Object.freeze({ category: "surveys", transactional: false }),
  survey_reminder: Object.freeze({ category: "surveys", transactional: false }),
});

// The production portal origin. Engagement delivery is cron-only, and a cron
// tick always resolves the production backend (api/_lib/backend.js), so the
// link must point at the production route that verifies with the same key.
// Union Ground has no portal yet (src/lib/trustedBackends.js), so this is
// "" and unsubscribeUrl refuses to build a link: no engagement email can go
// out without a working one-click unsubscribe.
export const UNSUBSCRIBE_ORIGIN = portalOrigin("saas");
export const UNSUBSCRIBE_PATH = "/api/email-unsubscribe";

// <member uuid>.<category>.<issued unix seconds>.<base64url HMAC-SHA256>.
// The database mints and verifies the signature; this shape check only keeps
// malformed input away from it.
export const UNSUBSCRIBE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(announcements|surveys|welcome)\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/;

export function engagementEmailClass(deliveryKind) {
  return Object.hasOwn(ENGAGEMENT_EMAIL_CLASSES, deliveryKind) ? ENGAGEMENT_EMAIL_CLASSES[deliveryKind] : null;
}

export function unsubscribeUrl(token, origin = UNSUBSCRIBE_ORIGIN) {
  if (!origin) throw new Error("No Union Ground portal origin is configured for unsubscribe links");
  const url = new URL(UNSUBSCRIBE_PATH, origin);
  url.searchParams.set("t", token);
  return url.toString();
}

// RFC 2369 + RFC 8058. The POST target and the visible link are the same URL:
// a mail provider POSTs "List-Unsubscribe=One-Click" to it, and a person who
// opens it gets a confirmation page whose button POSTs the same request.
export function unsubscribeHeaders(url) {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
