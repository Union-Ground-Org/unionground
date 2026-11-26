// REQ-UG-HOME-PAUSED-STEWARD-WEB-PROOF-20261103 (#6963): two chapter
// states for proving #6876 by eye in the fixture preview. Each is a
// member-only account whose chapter has exactly one steward, so Home's guide
// may name them ("Ask Sam Okafor, your steward"), with the member feature
// guides switched on. Like a new member, they have no conversation yet, so
// Messages offers the first Chapter steward message. `stewardMessageAvailable` is the answer
// get_member_steward_message_available() would give: false when the chapter's
// only steward is paused (two-step sign-in unfinished), true when they can
// read. Fictional people and chapters only.
//
// Chosen with ?fixture=steward-paused or ?fixture=steward-active on a test
// build (e2e/assurance-entry.jsx); any other value leaves the fixtures alone.
import { PROPOSED_MEMBER_SWITCHES } from "../../../../../src/features/onboardingGuideEngine/memberLayers.js";

const CHAPTERS = Object.freeze({
  "steward-paused": { chapterId: "wor", chapterName: "Cedar Ridge Care Services", stewardMessageAvailable: false },
  "steward-active": { chapterId: "spr-dds", chapterName: "Maple Crossing Care Services", stewardMessageAvailable: true },
});

export const STEWARD_AVAILABILITY_FIXTURES = Object.freeze(Object.keys(CHAPTERS));

export function withStewardAvailabilityFixture(fixtures, name) {
  const chapter = CHAPTERS[name];
  if (!chapter) return fixtures;
  const { chapterId, chapterName, stewardMessageAvailable } = chapter;
  return {
    ...fixtures,
    member: { ...fixtures.member, chapterId, chapterName },
    roles: [],
    conversations: [],
    peerContact: { ...fixtures.peerContact, incoming: [], outgoing: [], conversations: [] },
    chapterStewards: [{
      id: "staff-so", name: "Sam Okafor", roleLabel: "steward",
      chapterId, chapterLabel: chapterName, acceptsAppointments: true,
      contact: { conversation: true, email: null, phone: null },
    }],
    organizationConfiguration: {
      ...fixtures.organizationConfiguration,
      switches: { ...fixtures.organizationConfiguration?.switches, [PROPOSED_MEMBER_SWITCHES.featureGuides]: true },
    },
    stewardMessageAvailable,
  };
}
