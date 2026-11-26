// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): the shape of the organizations the Nov 8 to 10 bot campaign used,
// in place of the retired demo data most web tests boot on. A small new
// organization: five people, two chapters, one officer who holds a role only
// in a chapter, one who holds a role only for the whole organization, nobody
// with a join year, draft sharing on, and one survey the current Engagement
// studio made. A second customer organization has its own people, so a
// journey can prove none of them reaches the first one's screens.
//
// Every name, address and id here is fictional. No real person's data.

export const ORGANIZATION_ID = "5e110000-0000-4000-8000-000000000001";
export const OTHER_ORGANIZATION_ID = "5e110000-0000-4000-8000-000000000002";

export const organization = Object.freeze({
  id: ORGANIZATION_ID,
  name: "Fernbrook Care Workers",
  chapters: [
    { id: "5e11c000-0000-4000-8000-000000000011", name: "Fernbrook North Clinic" },
    { id: "5e11c000-0000-4000-8000-000000000012", name: "Fernbrook Riverside Home" },
  ],
});

export const otherOrganization = Object.freeze({
  id: OTHER_ORGANIZATION_ID,
  name: "Quarry Lane Library Staff",
  chapters: [{ id: "5e11c000-0000-4000-8000-000000000021", name: "Quarry Lane Main Branch" }],
});

const [north, riverside] = organization.chapters;

// organizationRoles are hats for the whole organization; chapterRoles hold
// only inside the named chapter. memberSince is null for everyone: a new
// organization has imported no join years.
export const people = Object.freeze({
  organizationOfficer: {
    id: "5e11a000-0000-4000-8000-000000000101",
    firstName: "Odessa",
    fullName: "Odessa Brightwater",
    initials: "OB",
    chapterId: north.id,
    organizationRoles: ["admin"],
    chapterRoles: [],
  },
  chapterOfficer: {
    id: "5e11a000-0000-4000-8000-000000000102",
    firstName: "Calloway",
    fullName: "Calloway Fenn",
    initials: "CF",
    chapterId: north.id,
    organizationRoles: [],
    chapterRoles: ["steward"],
  },
  member: {
    id: "5e11a000-0000-4000-8000-000000000103",
    firstName: "Marigold",
    fullName: "Marigold Ashby",
    initials: "MA",
    chapterId: north.id,
    organizationRoles: [],
    chapterRoles: [],
  },
  riversideMember: {
    id: "5e11a000-0000-4000-8000-000000000104",
    firstName: "Teodor",
    fullName: "Teodor Quill",
    initials: "TQ",
    chapterId: riverside.id,
    organizationRoles: [],
    chapterRoles: [],
  },
  newestMember: {
    id: "5e11a000-0000-4000-8000-000000000105",
    firstName: "Juniper",
    fullName: "Juniper Hale",
    initials: "JH",
    chapterId: riverside.id,
    organizationRoles: [],
    chapterRoles: [],
  },
});

// The second customer organization's own people. They exist so a journey can
// assert their names never appear for someone in Fernbrook.
export const otherPeople = Object.freeze({
  officer: {
    id: "5e11b000-0000-4000-8000-000000000201",
    firstName: "Rosalind",
    fullName: "Rosalind Marchetti",
    initials: "RM",
    chapterId: otherOrganization.chapters[0].id,
    organizationRoles: ["admin"],
    chapterRoles: [],
  },
  member: {
    id: "5e11b000-0000-4000-8000-000000000202",
    firstName: "Ignatius",
    fullName: "Ignatius Pell",
    initials: "IP",
    chapterId: otherOrganization.chapters[0].id,
    organizationRoles: [],
    chapterRoles: [],
  },
});

// The one survey, made in the current Engagement studio (the organization
// survey builder), open and organization-wide.
export const studioSurvey = Object.freeze({
  id: "5e115000-0000-4000-8000-000000000301",
  title: "Which shift change matters most to you?",
  body: "Tell the organizing committee which change to bargain for first.",
  options: ["Earlier start", "Fixed weekends", "Paid handover time"],
});

// Draft sharing is on: a member's grievance draft is shared with their
// chapter officer.
export const sharedGrievanceDraft = Object.freeze({
  id: "5e11f000-0000-4000-8000-000000000401",
  templateKey: "grievance",
  ownerId: people.member.id,
  sharedWith: people.chapterOfficer.id,
});

// One notice from the organization officer to everyone in Fernbrook.
export const notice = Object.freeze({
  id: "5e11d000-0000-4000-8000-000000000501",
  title: "Clinic staffing meeting moved to Thursday",
  body: "The staffing meeting with management is now Thursday at 4 PM in the North Clinic break room.",
});
