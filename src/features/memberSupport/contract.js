export const MEMBER_SUPPORT_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  screenedPaths: Object.freeze([
    "app/dashboard/accommodation/actions.ts",
    "app/dashboard/mentorship/actions.ts",
    "app/dashboard/onboarding/actions.ts",
    "app/m/rights/RightsScreen.tsx",
    "lib/union-ground/accommodation.ts",
    "lib/union-ground/hr-contact.ts",
    "lib/union-ground/onboarding.ts",
    "lib/union-ground/rights.ts",
  ]),
  rejected: Object.freeze([
    "agency-as-tenant authorization",
    "caller-supplied organization or member scope",
    "service-role reads for staff aggregates",
    "legacy Next.js server actions and route structure",
    "legacy credentials, project identifiers, dependencies, and migration history",
    "hard-coded organization identities, contacts, or user-visible affiliation copy",
    "fictional production tenants, users, programs, or onboarding assignments",
    "raw visual colors and fixed organization-specific labels",
  ]),
});

export const MEMBER_SUPPORT_RPCS = Object.freeze({
  snapshot: "get_member_support_workspace",
  saveEmergencyChecklist: "save_member_emergency_checklist",
  alertEmergencySteward: "alert_member_emergency_steward",
  resolveEmergencyChecklist: "resolve_member_emergency_checklist",
  createAccommodation: "create_member_accommodation_request",
  transitionAccommodation: "transition_member_accommodation_request",
  recordHrContact: "record_member_hr_contact",
  saveHrDirectory: "save_organization_hr_directory",
  saveOnboardingStep: "save_organization_onboarding_step",
  startOnboarding: "start_member_onboarding_plan",
  completeOnboardingStep: "complete_member_onboarding_step",
  createMentorshipPair: "create_member_mentorship_pair",
  transitionMentorshipPair: "transition_member_mentorship_pair",
  addMentorshipNote: "add_member_mentorship_note",
  saveMentorshipGoal: "save_member_mentorship_goal",
  listHandoffs: "list_member_handoffs_v2",
  searchHandoffMembers: "search_handoff_members",
  searchHandoffStewards: "search_handoff_stewards",
  initiateHandoff: "initiate_member_handoff",
  acknowledgeHandoff: "acknowledge_member_handoff",
  declineHandoff: "decline_member_handoff",
  cancelHandoff: "cancel_member_handoff",
});

export const MEMBER_SUPPORT_STAFF_HATS = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

// Only these hats may search for and start a handoff. It mirrors
// private.mi1_w2_handoff_can_initiate and the mobile HANDOFF_INITIATOR_HATS;
// an advisor oversees handoff history but the server refuses its searches and
// starts (BUG-UG-ADVISOR-HANDOFF-DEAD-END-20261003).
export const HANDOFF_INITIATOR_HATS = Object.freeze([
  "steward",
  "coordinator",
  "admin",
  "vp",
]);

export const MEMBER_SUPPORT_TABS = Object.freeze([
  Object.freeze({ id: "rights", label: "Emergency rights" }),
  Object.freeze({ id: "accommodations", label: "Accommodations" }),
  Object.freeze({ id: "hr", label: "HR contact" }),
  Object.freeze({ id: "onboarding", label: "Onboarding" }),
  Object.freeze({ id: "mentorship", label: "Mentorship" }),
  Object.freeze({ id: "handoffs", label: "Handoffs", staffOnly: true }),
]);

export const EMERGENCY_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "disciplinary_meeting",
    label: "Disciplinary meeting",
    // Before a union is recognized most
    // private-sector workers have no legal right to a representative in an
    // investigatory meeting, so the checklist asks for a coworker and promises
    // no right the worker may not have. Four steps: the database bounds a
    // saved step index to 0-3. The web desk's COPY carries the same text.
    summary: "Ask whether it could lead to discipline, ask for a coworker to be present, and keep a record while you reach the committee.",
    steps: Object.freeze([
      "Ask whether the meeting could lead to discipline.",
      "Ask for a coworker to be present. The employer may say no, but asking is still worth it.",
      "Stay calm. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.",
      "Right after, write down the time, place, people, and documents, and tell a committee member or organizer.",
    ]),
  }),
  Object.freeze({
    id: "pre_discipline_response",
    label: "Pre-discipline response",
    summary: "Use the response window to understand the charges, gather records, and prepare a supported answer.",
    steps: Object.freeze([
      "Request the allegations and supporting material in writing.",
      "Confirm the response deadline.",
      "Talk with an organizer or a qualified advisor before submitting a response.",
      "Keep a copy of everything submitted.",
    ]),
  }),
  Object.freeze({
    id: "unsafe_work",
    label: "Unsafe work",
    summary: "Address immediate danger first, then preserve facts and use the appropriate safety channel.",
    steps: Object.freeze([
      "Move away from immediate danger when you can do so safely.",
      "Notify the appropriate emergency or workplace safety contact.",
      "Document the condition without exposing coworkers' private information.",
      "Tell the committee so it can follow up.",
    ]),
  }),
]);

export const ACCOMMODATION_TYPES = Object.freeze([
  "schedule",
  "equipment",
  "workspace",
  "leave",
  "communication",
  "remote_work",
  "other",
]);

export const ACCOMMODATION_STATUSES = Object.freeze([
  "submitted",
  "under_review",
  "approved",
  "denied",
  "withdrawn",
]);

export const HR_CONTACT_DISPOSITIONS = Object.freeze([
  "planned",
  "attempted",
  "reached",
  "follow_up_due",
  "resolved",
]);

export const MENTORSHIP_STATUSES = Object.freeze([
  "active",
  "completed",
  "cancelled",
]);

export const EMPTY_MEMBER_SUPPORT_WORKSPACE = Object.freeze({
  state: "empty",
  organizationId: null,
  viewerUserId: null,
  staff: false,
  emergencyChecklists: Object.freeze([]),
  accommodations: Object.freeze([]),
  accommodationSummary: Object.freeze({ total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 }),
  hrDirectory: null,
  hrContacts: Object.freeze([]),
  onboardingProgram: Object.freeze([]),
  onboardingPlan: null,
  onboardingRoster: Object.freeze([]),
  mentorshipPairs: Object.freeze([]),
  mentorshipDirectory: Object.freeze([]),
  handoffs: Object.freeze({ items: Object.freeze([]), nextCursor: null }),
});
