// Which member↔steward thread a Contact control opens.
//
// Before public.member_conversations carried a steward identity every thread
// looked the same to the client, so a per-steward Contact button could only
// ever reach the first steward-role conversation — the same generic thread for
// every card on the roster. The nullable `steward_user_id` column fixes that,
// and this module is the one place both the Home card and the inbox agree on
// how to read it.
//
// The two cases are deliberately NOT symmetric:
//
//   selected steward -> the conversation bound to THAT steward, or nothing.
//     Falling back to the canonical thread here is the defect: the member
//     pressed Contact on a named card and would silently land in a thread
//     another steward reads.
//   no selected steward -> the unbound (general "Chapter steward") thread, or
//     nothing. A bound thread coexists with the general one (the backend's
//     start_member_conversation refusal counts only unbound threads), so the
//     general action must never open a selected steward's thread in its place.

function stewardIdOf(conversation) {
  return conversation?.stewardUserId ?? null;
}

function isStewardThread(conversation) {
  return conversation?.counterpartRole === "steward";
}

export function selectStewardConversation(conversations, stewardUserId = null) {
  const rows = Array.isArray(conversations) ? conversations.filter(Boolean) : [];
  if (stewardUserId) {
    return rows.find((row) => isStewardThread(row) && stewardIdOf(row) === stewardUserId) ?? null;
  }
  return rows.find((row) => isStewardThread(row) && stewardIdOf(row) === null) ?? null;
}

// The contact channels a steward card may offer. `conversation` is the floor —
// the in-app thread always exists as an action — and email/phone appear only
// when the roster projection carried an opted-in value, because the RPC returns
// null for every steward who has not written their own preference row.
export function stewardContactChannels(steward) {
  const contact = steward?.contact ?? {};
  return {
    conversation: contact.conversation !== false,
    email: typeof contact.email === "string" && contact.email.trim() ? contact.email.trim() : null,
    phone: typeof contact.phone === "string" && contact.phone.trim() ? contact.phone.trim() : null,
  };
}

// The stewards a member is pointed to as "your steward": everyone on the
// chapter's steward roster except the viewer, so a steward is never told to
// ask themselves (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030).
// `self` says the viewer was on the roster, so an empty list can say they are
// the only steward rather than that none is listed.
// `messageAvailable` is the server's answer to whether anyone could receive a
// steward message (#6876, false when the chapter's stewards are paused). When
// it is false nobody is offered and `unavailable` says why, so Home's Find my
// steward card and the guide never name a paused steward (#6971). Unknown
// availability (null) keeps the roster.
export function stewardsForViewer(stewards, viewerId = null, messageAvailable = null) {
  const rows = Array.isArray(stewards) ? stewards.filter(Boolean) : [];
  const others = viewerId ? rows.filter((row) => row.id !== viewerId) : rows;
  const self = others.length !== rows.length;
  if (messageAvailable === false && others.length > 0) return { others: [], self, unavailable: true };
  return { others, self, unavailable: false };
}

export function homeEmptyStewardKey(data, memberEmptyKey) {
  const canNameSteward = data.roles?.includes("admin") && data.staffMfa?.blocked !== true;
  if (data.member?.chapterId) return canNameSteward ? "today.findStewardAdminEmpty" : memberEmptyKey;
  return canNameSteward ? "today.findStewardAdminNoChapter" : "today.findStewardNoChapter";
}

// #9595: the one answer member pages read to whether a steward is named for
// this reader, so they cannot disagree.
// - "named": someone other than the reader is on the chapter's roster.
// - "paused": stewards are on the roster but the server says none can receive
//   a steward message (#6876). They exist and can still read a request, so a
//   page says what it said before; paused is not none.
// - "onlySelf": the reader is the chapter's only steward, so there is no
//   other steward to contact.
// - "none": nobody is on the roster.
// - "noChapter": the reader has no chapter, so a page must not say "your
//   chapter" either.
// - "unknown": the roster read failed or was not made (a route-first load),
//   so a page keeps what it said before rather than claiming either.
export const STEWARD_PRESENCE = Object.freeze({
  named: "named", paused: "paused", onlySelf: "only-self", none: "none", noChapter: "no-chapter", unknown: "unknown",
});

// The states in which no steward other than the reader can be reached.
export function noStewardNamed(presence) {
  return presence === STEWARD_PRESENCE.none || presence === STEWARD_PRESENCE.noChapter || presence === STEWARD_PRESENCE.onlySelf;
}

// #9595: what a member page says in place of a steward promise when no
// steward is named for the reader: who is missing, and who can name one.
// null in every other state, so the page keeps what it said before.
export function noStewardCopy(presence) {
  if (!noStewardNamed(presence)) return null;
  if (presence === STEWARD_PRESENCE.noChapter) return { title: "learn.noStewardNoChapter", who: "steward.noneWhoNoChapter" };
  if (presence === STEWARD_PRESENCE.onlySelf) return { title: "learn.noOtherSteward", who: "steward.noneWhoOther" };
  return { title: "learn.noSteward", who: "steward.noneWho" };
}

export function stewardPresence({ stewards, viewerId = null, messageAvailable = null, rosterLoaded = true, chapterId = null } = {}) {
  if (!chapterId) return STEWARD_PRESENCE.noChapter;
  if (rosterLoaded === false || !Array.isArray(stewards)) return STEWARD_PRESENCE.unknown;
  const { others, self, unavailable } = stewardsForViewer(stewards, viewerId, messageAvailable);
  if (unavailable) return STEWARD_PRESENCE.paused;
  if (others.length > 0) return STEWARD_PRESENCE.named;
  return self ? STEWARD_PRESENCE.onlySelf : STEWARD_PRESENCE.none;
}

// The one steward the member guide may name ("Ask {name}, your steward"):
// never the viewer, only when the chapter has exactly one, and never when the
// server says nobody could receive a steward message (#6876, a steward whose
// role is paused). Unknown availability (null) keeps the name.
export function guideSteward(stewards, viewerId = null, messageAvailable = null) {
  const { others } = stewardsForViewer(stewards, viewerId, messageAvailable);
  return others.length === 1 ? others[0] : null;
}

// #9595 (D2-2): whether a page may say "your chapter" to this reader. It is
// the test stewardPresence makes for "no-chapter" (a member row with no
// chapterId); a member not loaded yet is not taken for one with no chapter.
export function memberHasNoChapter(member) {
  return Boolean(member) && !member.chapterId;
}
