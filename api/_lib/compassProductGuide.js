// REQ-UG-COMPASS-REFUSES-GENERAL-HOW-TO-QUESTIONS-20261030.
//
// Compass's answers about using Union Ground itself. A member asking "How do I
// open a case?" was refused as written, because the minimizer's closed
// vocabulary had no words for the product, and even a sent question found no
// source: an organization's knowledge base describes its contract, not the
// portal. This module holds both halves of the fix.
//
// HOW_TO_FORM and PRODUCT_HOW_TO_WORDS widen the member question path only, and
// only for a sentence that asks how or where to do something: every other
// minimizer rule (names, digits, health, discipline and immigration) still
// applies to it. None of these words can carry a name, a contact detail or a
// case fact on its own.
//
// PRODUCT_GUIDE is product-authored and public: the same text for every
// organization, written from the shipped navigation (each path is a real app
// route, checked by tests/compass-product-guide.test.js). It carries no
// organization data, so adding it to a grounded answer never crosses an
// organization boundary. Sources are recognized by object identity, never by
// a row's claimed id, so retrieval output cannot pose as product guidance.

// The 422 a withheld question gets: it names what to change, including the
// how-to form this record opens (src/lib/i18n.js guide.errorQuestionWithheld
// and the native app's COMPASS_QUESTION_WITHHELD_MESSAGE carry the same text).
export const COMPASS_QUESTION_WITHHELD_ERROR = "The Guide can't send that question as written. Ask it as a general organizing question, with no names and no personal health, discipline or immigration details, or try one of the suggested questions or ask the committee.";

// A how-to or where-to sentence, read after contractions are expanded.
// BUG-UG-COMPASS-MINIMIZER-WITHHOLDS-ORDINARY-QUESTIONS-20261107
// (#7433): a question that asks for the steps ("What are the steps to open a
// case?", "Which steps open a case?", "steps to open a case") is the same
// how-to request and takes the same product words, nothing more.
export const HOW_TO_FORM = /^(?:how (?:do|can|should|would|could|does) (?:i|we|you|a member|members|a steward|stewards|an admin|staff|someone|anyone|compass)\b|how to\b|where (?:do|can|should|would) (?:i|we|you|members)\b|where (?:is|are) the\b|is there a way to\b|(?:what|which)(?: are)?(?: the)? steps\b|(?:the )?steps (?:to|for)\b)/iu;

export const PRODUCT_HOW_TO_WORDS = new Set(`
union ground compass app site page pages screen menu button tab link desk desks
setting settings switch switches feature features turn off enable disable
open post posts notice notices announcement announcements broadcast broadcasts mark
set setup start new add edit remove rename invite invites invitations
election elections ballot ballots vote votes survey surveys campaign campaigns
event events rsvp case cases profile password account role roles admin administrator
administrators president officer officers coordinator advisor find search guide guides
worksite worksites export download upload attach photo email emails notification notifications
language calendar card cards space spaces group groups people person
`.trim().split(/\s+/u));

// Capitalized product names a how-to sentence may carry mid-sentence.
export const PRODUCT_PROPER_TERMS = new Set(["Compass", "Union", "Ground"]);

const entry = (key, title, topics, snippet) => Object.freeze({
  source_id: `guide:${key}`,
  kind: "product_guide",
  title,
  ref: "Union Ground guide",
  snippet,
  topics: Object.freeze(topics),
});

export const PRODUCT_GUIDE = Object.freeze([
  entry("open-a-case", "Opening a case", ["case", "cases", "casework"],
    "A member opens My cases (/m/cases) and chooses Start a new case, then enters what happened, the case type, any deadline and contract articles, and chooses Create case. If My cases says chapter setup is required, the chapter must be connected first. Stewards work cases from the steward desk (/m/steward/requests)."),
  entry("ballots-and-elections", "Setting up a ballot or election", ["ballot", "ballots", "election", "elections", "vote", "votes", "voting", "campaign", "campaigns"],
    "Staff with the Campaigns desk open Ballots and pulses (/m/campaigns), choose New campaign, and save a ballot as a draft with its eligibility before publishing it. Only an organization-wide Admin or President may publish to all members. Members vote in Voting (/m/voting), and nobody can see how a person voted."),
  entry("surveys", "Creating a survey", ["survey", "surveys"],
    "Staff create surveys in Campaigns, under Engagement studio and Surveys (/m/campaigns/engagement/surveys). A survey is saved as a draft and members see it only after it is published."),
  entry("invitations", "Inviting people", ["invite", "invites", "invitation", "invitations"],
    "An organization administrator sends and resends invitations from Invite a member (/m/admin/invitations) and chooses the starting access. More roles are granted after the person joins, from Access (/m/admin/access)."),
  entry("notices-and-announcements", "Notices and announcements", ["notice", "notices", "announcement", "announcements", "broadcast", "broadcasts"],
    "Members read announcements in Messages (/m/messages) under the Announcements filter, and choose whether announcements also arrive by email in Settings (/m/settings). Staff add events from the Events desk (/m/events-desk). If you cannot find where to post a notice for your role, ask your organization administrator."),
  // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030.
  entry("messaging-officers", "Messaging an officer or administrator", ["message", "messages", "messaging", "contact", "officer", "officers", "president", "administrator", "administrators", "admin"],
    "A member writes privately to an officer or administrator of their chapter from Messages (/m/messages) with Write to an officer, or with Message beside their name under Who runs this chapter in Settings (/m/settings/profile). No contact code or reward is needed, and only the two of them can read that conversation. A message to the chapter steward is read by the chapter's stewards; when no steward is assigned yet, Messages offers the chapter's officers instead."),
  entry("events", "Events", ["event", "events", "rsvp", "calendar"],
    "Staff create events from the Events desk (/m/events-desk) or the Admin desk events page (/m/admin/events). Members see chapter events and RSVP in Events (/m/events)."),
  entry("compass-switch", "Turning Compass off", ["off", "disable", "switch", "switches"],
    "An organization administrator turns Compass off for the whole organization with the Compass AI assistant switch in Feature switches and limits (/m/admin/configuration); Compass then leaves the menu for everyone in the organization. Compass governance holds the platform controls, which only a Union Ground AI operator can change. There is no personal switch: Compass only reads what you send it."),
  entry("settings-and-profile", "Settings and profile", ["settings", "setting", "profile", "password", "notification", "notifications", "email", "language", "account"],
    "Settings (/m/settings) is where you choose how Union Ground reaches you, edit your profile and who can see each detail, and manage sign-in and security."),
  entry("finding-things", "Finding your way around", ["guide", "guides", "find", "search", "menu", "page", "desk", "desks"],
    "The Site guide (/m/guide) explains each section of the menu and each desk your account holds. Search (/m/search) finds pages and features in plain language. An organization administrator can change the guide's wording for the whole organization."),
]);

const GUIDE_ENTRIES = new WeakSet(PRODUCT_GUIDE);

export function isProductGuideSource(item) {
  return GUIDE_ENTRIES.has(item);
}

// Up to two guide entries for a how-to question, best topic match first. The
// input is the minimized retrieval query, so nothing withheld is ever matched.
export function productGuideSources(retrievalQuery, limit = 2) {
  const text = String(retrievalQuery || "").replace(/\s+/gu, " ").trim();
  if (!text.split(/(?<=[.!?])\s+/u).some((sentence) => HOW_TO_FORM.test(sentence))) return [];
  const words = new Set((text.toLowerCase().match(/[a-z]+/gu) || []));
  return PRODUCT_GUIDE
    .map((item, index) => ({ item, index, score: item.topics.filter((topic) => words.has(topic)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}
