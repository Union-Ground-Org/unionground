// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the one
// place a surface asks "who can read this?". The footer, Messages (both
// shells), Privacy, Profile and Q&A used to answer in their own words and
// disagreed; each now renders one of these keys, declared once in
// src/lib/i18n/messageVisibility.js and written from the database rules
// described there.

// A steward conversation (public.member_conversations) and a two-person
// conversation (public.member_peer_*, the officer route and member contact)
// are the only private message kinds a member writes.
export const CONVERSATION_KINDS = Object.freeze(["steward", "personal"]);

export const VISIBILITY_KEYS = Object.freeze({
  steward: "visibility.stewardConversation",
  personal: "visibility.personalConversation",
  stewardShort: "visibility.stewardShort",
  personalShort: "visibility.personalShort",
  profileDetails: "visibility.profileDetails",
  sharedContact: "visibility.sharedContact",
  qa: "visibility.qa",
  employer: "visibility.employer",
  footer: "morehub.footerPrivacy",
});

// The Privacy page lists every statement, in this order.
export const PRIVACY_STATEMENT_KEYS = Object.freeze([
  VISIBILITY_KEYS.steward,
  VISIBILITY_KEYS.personal,
  VISIBILITY_KEYS.profileDetails,
  VISIBILITY_KEYS.sharedContact,
  VISIBILITY_KEYS.qa,
  VISIBILITY_KEYS.employer,
]);

function otherParticipant(t, name) {
  return typeof name === "string" && name.trim() ? name.trim() : t("visibility.otherPerson");
}

// Who can read one conversation, as the full sentence a composer or first-
// message form shows. `name` is the other participant of a two-person
// conversation; without it the sentence names "the other person".
export function conversationVisibility(t, { kind, name = null } = {}) {
  if (kind === "personal") return t(VISIBILITY_KEYS.personal, { name: otherParticipant(t, name) });
  return t(VISIBILITY_KEYS.steward);
}

// The same answer in a thread header's few words.
export function conversationAudience(t, { kind, name = null } = {}) {
  if (kind === "personal") return t(VISIBILITY_KEYS.personalShort, { name: otherParticipant(t, name) });
  return t(VISIBILITY_KEYS.stewardShort);
}

// The Privacy page's statement list, already translated.
export function privacyStatements(t) {
  return PRIVACY_STATEMENT_KEYS.map((key) => ({
    key,
    text: key === VISIBILITY_KEYS.personal ? t(key, { name: t("visibility.otherPerson") }) : t(key),
  }));
}
