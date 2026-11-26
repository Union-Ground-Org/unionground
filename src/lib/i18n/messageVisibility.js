import { messageVisibilityCatalogueSpanish } from "./locales/es/namespaces/messageVisibility.js";
// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030, split out
// of the src/lib/i18n.js barrel like stewardHint.js. This file is the ONLY
// declaration of every `visibility.` and `officerContact.` key and of the
// footer, Messages and Privacy keys that used to say who can read what in
// different words; the barrel spreads it back into `catalogue`, so `t()` is
// unchanged. Every "who can read this" sentence in the app is one of the
// `visibility.` keys below, chosen by src/features/messaging/visibility.js.
//
// The statements follow the database: a steward conversation
// (public.member_conversations) is read by the member and every steward who
// can see them (private.staff_visible_member_ids('steward')); a two-person
// conversation (public.member_peer_*) by its two participants only; profile
// details by the member and, if they choose, administrators; a shared steward
// or officer email or phone by the members of that person's chapter.
export const messageVisibilityCatalogue = {
  en: {
    "visibility.title": "Who can read what",
    "visibility.stewardConversation": "Messages to your committee member: you and your campaign's committee members (and any organization-wide committee member) can read them, not only the committee member you write to. Your employer cannot.",
    "visibility.personalConversation": "A conversation with one officer or worker: only you and {name} can read it. Committee members, other officers and your employer cannot.",
    "visibility.otherPerson": "the other person",
    "visibility.stewardShort": "You and your campaign's committee members can read it",
    "visibility.personalShort": "Only you and {name} can read it",
    "visibility.profileDetails": "Your work and contact details: only you, unless you choose administrators. Committee members and other workers do not see them.",
    "visibility.sharedContact": "An email or phone a committee member or officer shares for workers: the workers of their campaign.",
    "visibility.qa": "Questions and replies in Q&A: everyone in your campaign and your organization's officers can read them, shown with your first name and last initial.",
    "visibility.employer": "Your employer never sees your messages, your profile details or your activity here.",
    "morehub.footerPrivacy": "Your activity is visible to you and your organizing committee — never to the employer.",
    "settings.visibilityBody": "You and campaign staff authorized by campaign policy and their role can see activity needed to support campaign work. Private issues and messages may be visible to authorized campaign-wide staff, not only an assigned staff member. Your employer cannot see this workspace.",

    "officerContact.title": "Write to an officer",
    "officerContact.body": "Write privately to an officer or administrator of your campaign. No contact code or reward is needed.",
    "officerContact.loading": "Loading your campaign's officers…",
    "officerContact.error": "Your campaign's officers could not be loaded. Try again in a moment.",
    "officerContact.empty": "No officer or administrator of your campaign can be messaged yet.",
    "officerContact.pick": "Choose who to write to",
    "officerContact.write": "Write to {name}",
    "officerContact.startTitle": "First message to {name}",
    "officerContact.cancel": "Choose someone else",
    "officerContact.noStewardTitle": "No committee member is assigned to your campaign yet",
    "officerContact.noStewardBody": "Your message was not sent. You can send it to one of your campaign's officers instead; it is still in the box.",
    "officerContact.message": "Message",
    "officerContact.messageNamed": "Message {name}",
    "officerContact.email": "Email",
    "officerContact.phone": "Phone",
    "rpcError.officer_unavailable": "That officer can't be messaged here any more. Choose someone else from your campaign's officers.",
    "rpcError.officer_contact_limit": "You have started three new conversations in the last 24 hours. Try again tomorrow, or continue a conversation you already have.",
    "settings.contactSharingBody": "Choose an email or phone number the workers of your campaign can see beside your name under Who runs this campaign (and on your committee member card, if you are a committee member). Nothing is shared until you turn it on.",
  },
  get es() { return messageVisibilityCatalogueSpanish; },
};
