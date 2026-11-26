import { requestInviteCatalogueSpanish } from "./locales/es/namespaces/requestInvite.js";
// Request an invite (/request-invite) and the "Request an invite" links on the
// sign-in card, /get-app and the landing page. Split out of the
// src/lib/i18n.js barrel like getApp.js; this file is the ONLY declaration of
// every `requestInvite.` key.
//
// Copy rules: never name a real organization, never promise an invitation,
// and say that the Union Ground team answers by email. The sent state is the
// whole acknowledgement: (11:28 AM ET), on
// screen with the response window, no email and nothing stored
// (REQ-UG-INVITE-REQUEST-ACKNOWLEDGEMENT-20261006).
export const requestInviteCatalogue = {
  en: {
    "requestInvite.link": "Request an invite",
    // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 75): on
    // the landing page this link sits beside "Request to join", so it is
    // worded apart from it and says what it is for.
    "requestInvite.landingLink": "Request an invite",
    "requestInvite.linkAudience": "For workers whose organization already uses Union Ground",
    "requestInvite.eyebrow": "Invitation only",
    "requestInvite.title": "Request an invite",
    "requestInvite.intro": "If your campaign already uses Union Ground, ask your campaign administrator to invite you. That is fastest. Use this form only if your campaign is not on Union Ground yet. Union Ground accounts are by invitation only. Tell us who you are and which campaign you're with, and the Union Ground team will reply by email.",
    "requestInvite.name": "Full name",
    "requestInvite.email": "Email address",
    "requestInvite.organization": "Campaign or workplace",
    "requestInvite.organizationHint": "If your campaign isn't on Union Ground yet, tell us its name anyway.",
    "requestInvite.bringOrganization": "Bringing an organization that isn't on Union Ground yet?",
    "requestInvite.note": "Anything we should know? (optional)",
    // WEB-PUB-03: the form marks its optional fields, and says so.
    "requestInvite.requiredNote": "Every field is required unless it says optional.",
    "requestInvite.submit": "Send request",
    "requestInvite.submitting": "Sending…",
    "requestInvite.privacy": "We use these details to answer your request and may share your name, email address and note with an organization's administrators on Union Ground so they can decide whether to invite you.",
    "requestInvite.sentTitle": "Request sent",
    "requestInvite.sentBody": "The Union Ground team reads every request and replies by email within 3 business days. No confirmation email is sent, so nothing arrives before that reply. If you're invited, the invitation email has a QR code and links for the website and the phone apps.",
    "requestInvite.sentTo": "The reply goes to {email}. If that address is wrong, send the request again with the right one.",
    "requestInvite.invalid": "Check your name, email address and organization, then try again.",
    "requestInvite.unavailable": "Requests can't be sent from this site right now. Email us instead:",
    "requestInvite.error": "Your request couldn't be sent. Check your connection and try again.",
    "requestInvite.haveInvitation": "Already invited? Open your invitation email first.",
    "requestInvite.signIn": "Sign in",
    "requestInvite.back": "Back to Union Ground",
  },
  get es() { return requestInviteCatalogueSpanish; },
};
