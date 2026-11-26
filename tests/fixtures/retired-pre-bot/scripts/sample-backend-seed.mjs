import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// SAMPLE demo seed (REQ-UNION-GROUND-SAMPLE-PROD-PARITY-20260820).
//
// The owner revised the Demo origin contract on 2026-08-20: the SAMPLE origin
// is wired exactly as production and its database carries REALISTIC FICTIONAL
// data that is NOT labeled "SAMPLE" in any user-visible name or content. The
// ORIGIN is the demo boundary, not a suffix on every row.
//
// What did NOT change, and must never change, are the target rails:
//   * assertSampleTarget refuses anything that is not the pinned SAMPLE
//     Supabase project (and every forbidden production/retired ref);
//   * --apply additionally demands SAMPLE_SEED_CONFIRM;
//   * without --apply this script only ever prints a plan.
// Those three are what make "fictional org and chapter rows are fine here"
// true: they cannot address production Postgres, so nothing seeded below can
// ever be presented as a real organization's data.
//
// Non-visible provenance markers stay: every auth user this script creates
// carries { sample: true, surface: "sample" } in user_metadata/app_metadata.
// Those are machine fields — no member ever reads them — so they are the one
// place labeling is still correct.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTRA_CHAPTER_MEMBERS,
  PLACEHOLDER_BALLOT_IDS,
  PLACEHOLDER_EVENT_IDS,
  PLACEHOLDER_KB_SLUGS,
  PLACEHOLDER_SURVEY_IDS,
  POINT_RULES,
  RIGHTS_LESSONS,
  SAMPLE_BALLOTS,
  SAMPLE_GUIDE_THREADS,
  SAMPLE_HISTORY_BROADCASTS,
  SAMPLE_HISTORY_CASES,
  SAMPLE_HISTORY_CONVERSATIONS,
  SAMPLE_HISTORY_EVENTS,
  SAMPLE_HISTORY_NOTIFICATIONS,
  SAMPLE_HISTORY_TASKS,
  SAMPLE_HISTORY_WEEKS,
  SAMPLE_KB_ARTICLES,
  SAMPLE_CHAPTER_DOCUMENTS,
  SAMPLE_CHAPTER_RECORDS,
  SAMPLE_HANDSHAKES,
  SAMPLE_PARTNER_ATLAS_SHA,
  SAMPLE_PARTNER_CHAPTER_MEMBERS,
  SAMPLE_PARTNER_ORGS,
  SAMPLE_SPACES,
  SAMPLE_SURVEYS,
  WORKLOAD_PERSONA_KEYS,
  ballotReceiptCode,
  hex8,
  hashMod,
  livedInPlanSlice,
  optionIndex,
  participates,
} from "./sample-lived-in-history.mjs";
import { SEED_FIXTURE_MARKERS, fixtureMarkersIn } from "../../../../scripts/lib/sample-fixture-markers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(join(root, "config/sample-backend.json"), "utf8"));
const CONFIRM = "SEED_UNION_GROUND_SAMPLE_BACKEND";

// 'wor' (Cedar Ridge Care Services) is the is_default chapter every migrated database
// already carries from 20260723040000_chapter_model_foundation.sql, so the
// personas belong somewhere real without this script inventing an org row.
// member_profiles.chapter_id defaults to it and private.handle_new_member()
// falls back to it, which is also what makes the chapter_* RLS scopes line up.
export const SAMPLE_CHAPTER_ID = "wor";
export const SAMPLE_CHAPTER_NAME = "Cedar Ridge Care Services";

// The sign-in-capable demo accounts. config/sample-backend.json is the source
// of truth (src/lib/sampleBackend.js carries the browser copy of the same
// list); this file only adds the presentation fields the profile row needs.
const PERSONA_PROFILES = {
  "darnell.foster@demo.example.com": { initials: "DF", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2019 },
  "sam.okafor@demo.example.com": { initials: "SO", roleLine: "Chapter steward · Cedar Ridge Care Services", memberSince: 2016 },
  "jordan.patel@demo.example.com": { initials: "JP", roleLine: "Case coordinator · Cedar Ridge Care Services", memberSince: 2014 },
  "avery.nguyen@demo.example.com": { initials: "AN", roleLine: "Chapter advisor · Cedar Ridge Care Services", memberSince: 2011 },
  "alex.rivera@demo.example.com": { initials: "AR", roleLine: "Chapter administrator · Cedar Ridge Care Services", memberSince: 2013 },
  "taylor.morgan@demo.example.com": { initials: "TM", roleLine: "Chapter president · Cedar Ridge Care Services", memberSince: 2009 },
};

export const SAMPLE_PERSONAS = Object.freeze(contract.samplePersonas.map((persona) => Object.freeze({
  ...persona,
  roles: Object.freeze([...persona.roles]),
})));

// The labeled roster this script used to seed, which reached the live SAMPLE
// project on 2026-08-20 before the owner reversed the labeling decision. Those
// two accounts carry "Darnell Foster SAMPLE"/"Sam Okafor SAMPLE" profiles,
// SAMPLE-1042/SAMPLE-1043 cases and a "SAMPLE Union Ground update" notice, all
// of which a visitor can still read. Adding unlabeled rows alongside them does
// not satisfy the revised contract, so the apply path RETIRES them.
//
// EXACT ADDRESSES, NEVER A PATTERN. A `.endsWith(".sample@")` sweep is the
// obvious shortcut and the wrong one: it is one config edit away from deleting
// a live persona, and a deletion cascades through every row that account owns.
// The module-scope assertion below makes the two properties this list must
// have — labeled legacy addresses, disjoint from the live personas — a load
// failure rather than a code review question.
export const LEGACY_LABELED_EMAILS = Object.freeze([
  "darnell.foster.sample@demo.example.com",
  "sam.okafor.sample@demo.example.com",
]);

{
  const personaEmails = new Set(SAMPLE_PERSONAS.map((persona) => persona.email));
  for (const email of LEGACY_LABELED_EMAILS) {
    if (!email.endsWith(".sample@demo.example.com")) {
      throw new Error(`Legacy retirement list may only name labeled legacy addresses, got ${email}`);
    }
    if (personaEmails.has(email)) {
      throw new Error(`Legacy retirement list must never name a live SAMPLE persona, got ${email}`);
    }
  }
  if (new Set(LEGACY_LABELED_EMAILS).size !== LEGACY_LABELED_EMAILS.length) {
    throw new Error("Legacy retirement list contains a duplicate address");
  }
}

// ------------------------------------------------------- reconcile keys ----
//
// Two sets of rows exist in the SAMPLE database that this script did not
// write, and both are user-visible placeholder content:
//
//   1. private.handle_new_member() fires on EVERY auth user insert
//      (20260730160500_seed_case_refs_per_member_suffix.sql), so all sixteen
//      seeded accounts arrive carrying four boilerplate cases, two "Chapter
//      steward" conversations — one of which says only "HI" — and three
//      seed.* notifications, one of them literally "The latest fictional
//      chapter broadcast is ready."
//   2. 20260720191847_fresh_member_workflows.sql seeds twenty
//      member_broadcasts rows titled "Fictional Public Service Chapter
//      3E024208 …" and "Member briefing N", which loadMemberApp reads
//      unfiltered.
//
// Every literal below is transcribed from those two migrations. They are
// EXACT shapes, never prefixes or wildcards, for the same reason
// LEGACY_LABELED_EMAILS is: the reconcile step deletes, and a pattern is one
// content edit away from deleting the demo's own rows.

// The four fixed case titles the trigger inserts. Their references carry a
// per-member CSPRNG suffix (GR-2026-509-31847), so the title is the stable
// key and the reference SHAPE below is the confirmation.
export const TRIGGER_CASE_TITLES = Object.freeze([
  "Step 2 — discipline",
  "Telework schedule restored",
  "Safety equipment issued",
  "Scheduling shift corrected",
]);

// `'GR-2026-509-' || private.member_case_suffix()` and its three siblings.
// A row is only deleted when its reference matches one of these bases exactly
// plus a numeric suffix, which no seeded reference (GR-2026-118, three digits,
// no suffix) can ever satisfy.
export const TRIGGER_CASE_REFERENCE_PATTERN = /^(?:GR-2026-509|GR-2026-312|GR-2025-944|GR-2025-721)-\d+$/;

// The trigger's two conversations are titled 'Chapter steward' with initials
// 'CS' — which is ALSO what this seed's own threads are titled, because that
// generic wire name is the product's canon. So the conversations are never
// identified by their title. They are identified by the exact body of the
// steward message the trigger puts inside them, and the seed's own thread ids
// are excluded a second time as belt and braces.
export const TRIGGER_MESSAGE_BODIES = Object.freeze([
  "Now the employer owes a written Step 2 answer, due at the end of next week.",
  "HI",
]);

// private.notify_member_at renders private.notification_copy at insert time in
// the member's language. Every seeded profile is 'en', but both locales are
// listed so a language change can never strand a placeholder row.
// (20260728221544_notification_copy_sweep.sql:64-69, Spanish titles repointed
// by 20260731214500_notification_copy_capitulo.sql.)
export const TRIGGER_NOTIFICATION_TITLES = Object.freeze([
  "Ballot closes soon",
  "Case deadline",
  "New chapter update",
  "La votación cierra pronto",
  "Fecha límite del caso",
  "Nueva actualización de la sección",
  "Nueva actualización del capítulo",
]);

// The twenty placeholder broadcasts, by primary key. Ids rather than titles:
// the id IS the exact identity, four of the titles repeat across rows, and no
// id here can collide with this seed's own `bc-2026-*` notices.
export const PLACEHOLDER_BROADCAST_IDS = Object.freeze([
  "broadcast-2026-q2", "broadcast-2026-q1", "broadcast-2025-q3",
  "broadcast-2025-q1", "broadcast-2024-q3", "broadcast-2024-q2",
  ...Array.from({ length: 14 }, (_, index) => `broadcast-archive-${String(index + 1).padStart(2, "0")}`),
]);

// NOT retired, on purpose: the trigger's member_rights_progress row (one
// completed Weingarten step) and its three member_action_log 'seed' rows are
// realistic, unlabeled, and drive the Today week strip. Deleting them would
// make the demo LESS believable, not more.

const PERSONA_ROSTER = SAMPLE_PERSONAS.map((persona) => ({
  key: persona.email.split("@")[0],
  hat: persona.hat,
  email: persona.email,
  firstName: persona.firstName,
  fullName: persona.fullName,
  roles: [...persona.roles],
  signIn: true,
  ...PERSONA_PROFILES[persona.email],
}));

// The rest of the chapter. Plain members with no role rows, so the staff desks
// read like a real chapter instead of a two-row fixture. Names follow the
// naming style already established by private.member_stress_name_pool in
// 20260726000000_chapter_agency_roster_and_stress_enrichment.sql — realistic,
// fictional, unlabeled — but the list below is fixed and inline. This script
// never calls those production-pinned stress RPCs.
const CHAPTER_ROSTER = [
  { key: "rosa.almeida", firstName: "Rosa", fullName: "Rosa Almeida", initials: "RA", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2016 },
  { key: "marcus.bell", firstName: "Marcus", fullName: "Marcus Bell", initials: "MB", roleLine: "Day program instructor · Cedar Ridge Care Services", memberSince: 2019 },
  { key: "kathleen.whelan", firstName: "Kathleen", fullName: "Kathleen Whelan", initials: "KW", roleLine: "Case manager · Cedar Ridge Care Services", memberSince: 2012 },
  { key: "andre.boucher", firstName: "Andre", fullName: "Andre Boucher", initials: "AB", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2021 },
  { key: "imani.yeboah", firstName: "Imani", fullName: "Imani Yeboah", initials: "IY", roleLine: "Vocational specialist · Cedar Ridge Care Services", memberSince: 2018 },
  { key: "thomas.gagnon", firstName: "Thomas", fullName: "Thomas Gagnon", initials: "TG", roleLine: "Maintenance technician · Cedar Ridge Care Services", memberSince: 2015 },
  { key: "lucia.estrada", firstName: "Lucia", fullName: "Lucia Estrada", initials: "LE", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2022 },
  { key: "brian.sullivan", firstName: "Brian", fullName: "Brian Sullivan", initials: "BS", roleLine: "Transportation driver · Cedar Ridge Care Services", memberSince: 2014 },
  { key: "nadia.haddad", firstName: "Nadia", fullName: "Nadia Haddad", initials: "NH", roleLine: "Clinical coordinator · Cedar Ridge Care Services", memberSince: 2023 },
  { key: "curtis.monteiro", firstName: "Curtis", fullName: "Curtis Monteiro", initials: "CM", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2020 },
].map((member) => ({ ...member, email: `${member.key}@demo.example.com`, roles: [], signIn: false }));

// One roster, personas first. The demo's straight-in entry and hat switcher
// use the persona slice; every desk read uses the whole chapter, including the
// extra three-year members that fill ballots, pulses, and the staff desks.
export const SAMPLE_ROSTER = Object.freeze([
  ...PERSONA_ROSTER,
  ...CHAPTER_ROSTER,
  ...EXTRA_CHAPTER_MEMBERS,
].map(Object.freeze));

// chapter_tasks.workstream is validated against chapter_workstreams by
// private.assert_chapter_workstream (20260728221223), so these rows have to
// exist before a single task insert can succeed.
export const SAMPLE_WORKSTREAMS = Object.freeze([
  "General", "Grievances", "Health and safety", "Contract campaign", "Membership", "Training",
]);

// Grievance files. Every date is an OFFSET resolved at apply time so the plan
// this script prints is deterministic and the seeded data is always "recent".
// References follow the production shape (GR-YYYY-NNN) rather than a label.
export const SAMPLE_CASES = Object.freeze([
  {
    memberKey: "rosa.almeida", reference: "GR-2026-118", title: "Overtime distribution on the weekend rota",
    caseType: "Scheduling", step: "Step 2", status: "active",
    articles: "Article 7 — Hours of Work · Article 8 — Overtime",
    openedDaysAgo: 34, updatedDaysAgo: 3, deadlineInDays: 9,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Step 1 answer denied. The agency cited operational need without producing the rota records we asked for.",
      "Step 2 filed. The employer owes a written answer by the end of next week.",
    ],
  },
  {
    memberKey: "marcus.bell", reference: "GR-2026-121", title: "Telework schedule denied without a written reason",
    caseType: "Telework", step: "Step 1", status: "active",
    articles: "Article 15 — Telework",
    openedDaysAgo: 21, updatedDaysAgo: 2, deadlineInDays: 5,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Filed at Step 1 with the denial letter and six weeks of coverage notes attached."],
  },
  {
    memberKey: "andre.boucher", reference: "GR-2026-124", title: "Lift equipment missing from the day program van",
    caseType: "Safety", step: "Step 1", status: "active",
    articles: "Article 16 — Health and Safety",
    openedDaysAgo: 16, updatedDaysAgo: 4, deadlineInDays: 12,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: [
      "Photographed the empty lift bracket and logged the incident with the site supervisor.",
      "Safety committee walkthrough scheduled. The agency has not answered in writing yet.",
    ],
  },
  {
    memberKey: "imani.yeboah", reference: "GR-2026-127", title: "Reasonable accommodation delayed past thirty days",
    caseType: "Accommodation", step: "Step 2", status: "active",
    articles: "Article 21 — Reasonable Accommodation",
    openedDaysAgo: 62, updatedDaysAgo: 1, deadlineInDays: 4,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Interactive-process meeting requested on the 12th. The agency has not scheduled it.",
      "Escalated to Step 2 and copied the coordinator on the documentation timeline.",
    ],
  },
  {
    memberKey: "thomas.gagnon", reference: "GR-2026-130", title: "Out-of-title work on the residential floor",
    caseType: "Classification", step: "Step 1", status: "active",
    articles: "Article 6 — Job Classification",
    openedDaysAgo: 12, updatedDaysAgo: 5, deadlineInDays: 18,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Collected two weeks of assignment sheets showing the higher-grade duties."],
  },
  {
    memberKey: "lucia.estrada", reference: "GR-2026-133", title: "Written warning after a documented staffing shortage",
    caseType: "Discipline", step: "Step 2", status: "active",
    articles: "Article 12 — Discipline · Article 3 — Union Rights and Representation",
    openedDaysAgo: 41, updatedDaysAgo: 6, deadlineInDays: -2,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Weingarten request honored. The steward attended the investigatory meeting.",
      "Step 1 answer upheld the warning. Appealing to Step 2 with the shortage log.",
    ],
  },
  {
    memberKey: "nadia.haddad", reference: "GR-2026-136", title: "Shift differential not paid on the holiday rota",
    caseType: "Pay", step: "Intake", status: "active",
    articles: "Article 9 — Compensation",
    openedDaysAgo: 6, updatedDaysAgo: 6, deadlineInDays: 21,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Intake call taken. Pulling the last three pay advices before drafting."],
  },
  {
    memberKey: "darnell.foster", reference: "GR-2026-139", title: "Weekend rotation changed without notice",
    caseType: "Scheduling", step: "Step 1", status: "active",
    articles: "Article 7 — Hours of Work",
    openedDaysAgo: 15, updatedDaysAgo: 2, deadlineInDays: 7,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Filed with the posted schedule and the superseding version emailed on the 3rd."],
  },
  {
    memberKey: "kathleen.whelan", reference: "GR-2026-104", title: "Split shift restored after caseload review",
    caseType: "Scheduling", step: "Closed", status: "resolved",
    articles: "Article 7 — Hours of Work",
    openedDaysAgo: 120, updatedDaysAgo: 74, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Resolved at Step 1. The split shift was restored and the lost hours were made whole."],
  },
  {
    memberKey: "brian.sullivan", reference: "GR-2025-948", title: "Back pay issued for missed differentials",
    caseType: "Pay", step: "Closed", status: "resolved",
    articles: "Article 9 — Compensation",
    openedDaysAgo: 240, updatedDaysAgo: 190, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: ["The agency issued the back pay in the second September cycle. Closed with the member's agreement."],
  },
  {
    memberKey: "curtis.monteiro", reference: "GR-2026-109", title: "Mandatory overtime cap applied to the residential rota",
    caseType: "Scheduling", step: "Closed", status: "resolved",
    articles: "Article 7 — Hours of Work · Article 8 — Overtime",
    openedDaysAgo: 150, updatedDaysAgo: 96, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Settled at Step 2 with a written cap on consecutive mandated shifts."],
  },
]);

// Private member/steward threads. member_messages.sender_kind is constrained to
// ('member','steward') by 20260720191847, and the steward's name on the wire is
// always the generic 'Chapter steward' — the same canon the production trigger
// writes, so a demo thread cannot expose a steward's legal name.
const STEWARD_WIRE_NAME = "Chapter steward";
export const SAMPLE_CONVERSATIONS = Object.freeze([
  {
    memberKey: "rosa.almeida", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 12,
    messages: [
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 12, read: true, body: "I have the Step 1 denial. Can you send me the rota printouts for the last four weekends?" },
      { senderKind: "member", daysAgo: 12, read: true, body: "Sent them this morning. The 2nd and the 16th are the ones where I was skipped twice." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 3, read: false, body: "Got them. I filed Step 2 today, so the employer owes a written answer by the end of next week." },
    ],
  },
  {
    memberKey: "marcus.bell", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 9,
    messages: [
      { senderKind: "member", daysAgo: 9, read: true, body: "They denied my telework days again and would not put a reason in writing." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 9, read: true, body: "Ask for the denial in writing and forward it to me. Article 15 requires a stated reason." },
      { senderKind: "member", daysAgo: 8, read: false, body: "Got the letter this afternoon. Forwarding it now." },
    ],
  },
  {
    memberKey: "imani.yeboah", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 5,
    messages: [
      { senderKind: "member", daysAgo: 5, read: true, body: "It has been over thirty days and nobody has scheduled the accommodation meeting." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 4, read: false, body: "That is past the contract window. I am escalating to Step 2 and copying the case coordinator." },
    ],
  },
  {
    memberKey: "andre.boucher", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 6,
    messages: [
      { senderKind: "member", daysAgo: 6, read: true, body: "The van went out again without the lift bracket. I refused the run and wrote it up." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 6, read: false, body: "You did the right thing. Send me the incident number and I will put it in front of the safety committee." },
    ],
  },
  {
    memberKey: "darnell.foster", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 20,
    messages: [
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 20, read: true, body: "Welcome to the chapter roster. If your weekend rotation changes again, tell me the same day." },
      { senderKind: "member", daysAgo: 15, read: true, body: "Thanks. It changed on the 3rd with no notice and I saved the old posting." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 14, read: false, body: "Perfect. I opened a Step 1 with it. Keep every schedule they post." },
    ],
  },
]);

// member_events.check_in_code is CHECKed against ^SG-[0-9A-Z]{3,12}$
// (20260722023422) and (chapter_id, order_index) is unique since
// 20260812170000, so the indices below start well clear of the rows the
// migrations themselves seed.
export const SAMPLE_EVENTS = Object.freeze([
  {
    id: "evt-chapter-membership-meeting", title: "Chapter membership meeting",
    startsInDays: 6, startsAtHour: 17.5, orderIndex: 101, checkInCode: "SG-MEET26",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "Contract enforcement update, steward elections, and an open floor for scheduling concerns.",
    isPublic: true, isPublicAcrossAgencies: false,
    rsvpKeys: ["darnell.foster", "rosa.almeida", "marcus.bell", "kathleen.whelan", "andre.boucher", "imani.yeboah", "lucia.estrada", "curtis.monteiro"],
  },
  {
    id: "evt-new-steward-training-3", title: "New-steward training — Module 3",
    startsInDays: 13, startsAtHour: 18, orderIndex: 102, checkInCode: "SG-TRAIN3",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "Weingarten rights, investigatory interviews, and Step 1 practice against a live case file.",
    isPublic: true, isPublicAcrossAgencies: false,
    rsvpKeys: ["rosa.almeida", "thomas.gagnon", "nadia.haddad", "andre.boucher"],
  },
  {
    id: "evt-health-safety-walkthrough", title: "Health and safety walkthrough",
    startsInDays: 20, startsAtHour: 9, orderIndex: 103, checkInCode: "SG-SAFE04",
    location: "Pinebend day program · 20 Example Way",
    summary: "Joint walkthrough of lift equipment, van maintenance logs, and the incident reporting binder.",
    isPublic: false, isPublicAcrossAgencies: false,
    rsvpKeys: ["andre.boucher", "thomas.gagnon", "brian.sullivan"],
  },
  {
    id: "evt-contract-action-team", title: "Contract action team check-in",
    startsInDays: -5, startsAtHour: 16, orderIndex: 104, checkInCode: "SG-CAT09",
    location: "Online · chapter conference line",
    summary: "Worksite leader report-backs on the scheduling petition and next steps before bargaining.",
    isPublic: true, isPublicAcrossAgencies: false,
    rsvpKeys: ["rosa.almeida", "marcus.bell", "imani.yeboah", "lucia.estrada", "curtis.monteiro", "kathleen.whelan"],
  },
]);

// Chapter-wide notices. member_broadcasts.order_index is globally unique, so
// these also start above the range the migrations seed.
export const SAMPLE_BROADCASTS = Object.freeze([
  {
    id: "bc-2026-scheduling-petition", sender: "Chapter president", orderIndex: 101, publishedDaysAgo: 4,
    title: "Scheduling petition reaches two hundred signatures",
    body: "Two hundred and eleven members have signed the weekend rota petition. Worksite leaders are collecting the last day program sites this week; bring the sheet to the membership meeting if you still have one out.",
  },
  {
    id: "bc-2026-safety-walkthrough", sender: "Health and safety committee", orderIndex: 102, publishedDaysAgo: 11,
    title: "Joint safety walkthrough set for the day programs",
    body: "The agency agreed to a joint walkthrough covering lift equipment, van maintenance logs, and the incident binder. If a hazard was reported at your site in the last ninety days, send the incident number to your steward so it is on the list.",
  },
  {
    id: "bc-2026-steward-elections", sender: "Chapter steward", orderIndex: 103, publishedDaysAgo: 19,
    title: "Steward elections open at the membership meeting",
    body: "Nominations for chapter steward open on the floor of the next membership meeting and stay open for ten days. Any member in good standing may nominate or be nominated.",
  },
]);

// member_steward_requests.lesson_id points at the five member_rights_lessons
// rows seeded by 20260720191847 (loudermill, weingarten, harassment, pip,
// safety). These fill the steward desk's request queue.
export const SAMPLE_STEWARD_REQUESTS = Object.freeze([
  { memberKey: "lucia.estrada", lessonId: "weingarten", status: "acknowledged", daysAgo: 8 },
  { memberKey: "andre.boucher", lessonId: "safety", status: "requested", daysAgo: 5 },
  { memberKey: "thomas.gagnon", lessonId: "pip", status: "requested", daysAgo: 2 },
  { memberKey: "marcus.bell", lessonId: "loudermill", status: "closed", daysAgo: 26 },
]);

// Standard Task contract (AGENTS.md): the status flow is Backlog, To do, In
// progress, Review, Done, which the database spells
// ('backlog','to_do','in_progress','needs_review','done') — the widened CHECK
// from 20260802190831_standard_task_contract.sql. task_type stays 'general':
// private.guard_chapter_task_template_type (20260812205000) rejects any
// specialized type on a plain insert.
export const SAMPLE_TASKS = Object.freeze([
  { title: "Draft the scheduling petition for the Pinebend day program", workstream: "Contract campaign", status: "backlog", priority: "medium", assigneeKey: "sam.okafor", startInDays: null, dueInDays: 24, progress: 0, blocked: false, milestone: false, description: "Reuse the residential petition language and swap in the day program rota examples the worksite leaders collected." },
  { title: "Collect van maintenance logs ahead of the safety walkthrough", workstream: "Health and safety", status: "backlog", priority: "high", assigneeKey: "jordan.patel", startInDays: null, dueInDays: 17, progress: 0, blocked: true, milestone: false, description: "The agency has produced two of five sites. Blocked on the fleet office until they confirm who holds the Brooks St binder." },
  { title: "Book the chapter hall for the November membership meeting", workstream: "Membership", status: "to_do", priority: "medium", assigneeKey: "alex.rivera", startInDays: null, dueInDays: 9, progress: 0, blocked: false, milestone: false, description: "Confirm the room, the accessible entrance, and the interpreter request before the notice goes out." },
  { title: "Post the steward election timeline to the chapter board", workstream: "Membership", status: "to_do", priority: "low", assigneeKey: "taylor.morgan", startInDays: null, dueInDays: 12, progress: 0, blocked: false, milestone: false, description: "Nominations open on the floor and stay open ten days. Post the same dates in every break room." },
  { title: "Prepare the Step 2 packet for the overtime grievance", workstream: "Grievances", status: "to_do", priority: "high", assigneeKey: "sam.okafor", startInDays: -2, dueInDays: 6, progress: 0, blocked: false, milestone: true, description: "Link the authorized case record rather than pasting member detail into this card." },
  { title: "Follow up with the agency on the accommodation backlog", workstream: "Grievances", status: "in_progress", priority: "high", assigneeKey: "jordan.patel", startInDays: -9, dueInDays: 3, progress: 55, blocked: false, milestone: false, description: "Three interactive-process meetings are past the thirty-day window. Push for dates in writing this week." },
  { title: "Schedule worksite visits for the two new day program sites", workstream: "Membership", status: "in_progress", priority: "medium", assigneeKey: "sam.okafor", startInDays: -6, dueInDays: 14, progress: 40, blocked: false, milestone: false, description: "Morning shift change is the only time both sites overlap. Bring membership forms and the safety flyer." },
  { title: "Assemble the shift differential research for the contract question", workstream: "Contract campaign", status: "in_progress", priority: "medium", assigneeKey: "avery.nguyen", startInDays: -4, dueInDays: 11, progress: 25, blocked: false, milestone: false, description: "Compare Article 9 language against the last two holiday cycles and note where the agency's practice diverges." },
  { title: "Review the draft accommodation tracking form", workstream: "General", status: "needs_review", priority: "medium", assigneeKey: "avery.nguyen", startInDays: -14, dueInDays: 2, progress: 80, blocked: false, milestone: false, description: "Check that nothing on the form asks for medical detail the chapter has no business holding." },
  { title: "Confirm the new-steward training roster", workstream: "Training", status: "needs_review", priority: "low", assigneeKey: "taylor.morgan", startInDays: -10, dueInDays: 4, progress: 75, blocked: false, milestone: false, description: "Four confirmed, two waiting on shift coverage. Confirm the room holds twelve before opening it wider." },
  { title: "Send the September chapter newsletter", workstream: "Membership", status: "done", priority: "medium", assigneeKey: "alex.rivera", startInDays: -30, dueInDays: -12, progress: 100, blocked: false, milestone: false, description: "Went out to the full roster with the petition update and the safety walkthrough date." },
  { title: "Close out the resolved back pay grievance file", workstream: "Grievances", status: "done", priority: "low", assigneeKey: "jordan.patel", startInDays: -40, dueInDays: -20, progress: 100, blocked: false, milestone: false, description: "Back pay landed in the second September cycle. Record archived and the member confirmed in writing." },
]);

// In-app notices. kind stays 'general' on purpose: every OTHER kind is a
// delivery topic, and private.enqueue_notification_deliveries (20260813022500)
// only queues an outbound send for typed rows. A demo database must never be
// one policy flip away from mailing fictional addresses.
export const SAMPLE_NOTIFICATIONS = Object.freeze([
  {
    key: "membership-meeting", audience: "all", hoursAgo: 40,
    title: "Chapter membership meeting is on the calendar",
    body: "Doors at 5:30 PM at the Cedar Ridge chapter hall. Steward elections are on the agenda.",
  },
  {
    key: "case-moved", audience: "activeCaseOwners", hoursAgo: 18,
    title: "Your grievance moved to a new step",
    body: "Open Cases to read the latest update your steward posted to the file.",
  },
  {
    key: "review-column", audience: "staff", hoursAgo: 6,
    title: "Two cards are waiting in Review",
    body: "Open the Tasks board to clear the review column before the membership meeting.",
  },
]);

// Casework history is loaded with `steward_user_id = auth.uid()` and a fixed
// 50-row page. The parity lanes exercise that query with their own generated
// steward identities, but the public SAMPLE tour signs in as Sam Okafor. Keep
// two complete pages on that canonical identity too; otherwise the database
// can pass its parity ledger while the browser's Next control stays disabled.
export const SAMPLE_CANONICAL_STEWARD_CASE_MINIMUM = 100;

const CANONICAL_CASE_THEMES = Object.freeze([
  { caseType: "Scheduling", articles: "Article 7 — Hours of Work", title: "Posted rotation changed without the required notice", update: "The original posting and revised schedule were compared, and the notice remedy was documented." },
  { caseType: "Pay", articles: "Article 9 — Compensation", title: "Shift differential omitted from a pay cycle", update: "Payroll records confirmed the missing differential and the make-whole amount was issued." },
  { caseType: "Safety", articles: "Article 16 — Health and Safety", title: "Safety equipment unavailable at shift change", update: "The incident log and equipment check were reviewed, and replacement stock was restored." },
  { caseType: "Discipline", articles: "Article 12 — Discipline · Article 3 — Union Rights and Representation", title: "Corrective action issued without complete records", update: "The meeting record was corrected and the unsupported action was removed from the file." },
  { caseType: "Leave", articles: "Article 10 — Leave", title: "Approved leave coded as an attendance occurrence", update: "The approval notice was matched to the time record and the occurrence was removed." },
  { caseType: "Classification", articles: "Article 6 — Job Classification", title: "Higher-grade duties assigned outside the classification", update: "Assignment sheets established the higher-grade work and the pay adjustment was processed." },
  { caseType: "Workload", articles: "Article 18 — Workload", title: "Caseload remained above the written standard", update: "The roster was reviewed against the standard and assignments were redistributed." },
  { caseType: "Telework", articles: "Article 15 — Telework", title: "Telework schedule changed without a written reason", update: "The written-review requirement was enforced and a stable schedule was restored." },
]);

const CANONICAL_CASE_WORKSITES = Object.freeze([
  "Brooks Street residence",
  "Pinebend day program",
  "Lincoln Street office",
  "Park Avenue residence",
  "Shrewsbury service center",
  "West Boylston program",
  "Cedar Ridge intake team",
  "Grafton community site",
]);

const canonicalPlainMembers = SAMPLE_ROSTER.filter((member) => !member.signIn);
const canonicalCaseShortfall = Math.max(
  0,
  SAMPLE_CANONICAL_STEWARD_CASE_MINIMUM - SAMPLE_CASES.length - SAMPLE_HISTORY_CASES.length,
);

export const SAMPLE_CANONICAL_STEWARD_HISTORY_CASES = Object.freeze(Array.from(
  { length: canonicalCaseShortfall },
  (_, index) => {
    const theme = CANONICAL_CASE_THEMES[index % CANONICAL_CASE_THEMES.length];
    const worksite = CANONICAL_CASE_WORKSITES[Math.floor(index / CANONICAL_CASE_THEMES.length) % CANONICAL_CASE_WORKSITES.length];
    const openedDaysAgo = 105 + (index * 12);
    const active = index < 8;
    return Object.freeze({
      memberKey: canonicalPlainMembers[index % canonicalPlainMembers.length].key,
      seedKey: `canonical-steward-history-${index + 1}`,
      referenceSequence: 600 + index,
      title: `${theme.title} at ${worksite}`,
      caseType: theme.caseType,
      step: active ? (index % 2 === 0 ? "Step 1" : "Step 2") : "Closed",
      status: active ? "active" : "resolved",
      articles: theme.articles,
      openedDaysAgo,
      updatedDaysAgo: active ? 8 + index : openedDaysAgo - (35 + (index % 5) * 9),
      deadlineInDays: active ? 6 + index : null,
      stewardKey: "sam.okafor",
      coordinatorKey: index % 3 === 0 ? "jordan.patel" : null,
      updates: [theme.update],
    });
  },
));

export const ALL_SAMPLE_CASES = Object.freeze([
  ...SAMPLE_CASES,
  ...SAMPLE_HISTORY_CASES,
  ...SAMPLE_CANONICAL_STEWARD_HISTORY_CASES,
]);
export const ALL_SAMPLE_CONVERSATIONS = Object.freeze([...SAMPLE_CONVERSATIONS, ...SAMPLE_HISTORY_CONVERSATIONS]);
export const ALL_SAMPLE_EVENTS = Object.freeze([...SAMPLE_EVENTS, ...SAMPLE_HISTORY_EVENTS]);
export const ALL_SAMPLE_BROADCASTS = Object.freeze([...SAMPLE_BROADCASTS, ...SAMPLE_HISTORY_BROADCASTS]);
export const ALL_SAMPLE_TASKS = Object.freeze([...SAMPLE_TASKS, ...SAMPLE_HISTORY_TASKS]);
export const ALL_SAMPLE_NOTIFICATIONS = Object.freeze([...SAMPLE_NOTIFICATIONS, ...SAMPLE_HISTORY_NOTIFICATIONS]);

// The two roles that must be ORG-WIDE (member_roles.chapter_id NULL) rather
// than chapter-scoped. See seedProfilesAndRoles for why.
export const ORG_WIDE_ROLES = Object.freeze(["admin", "vp"]);

export function roleChapterScope(role) {
  return ORG_WIDE_ROLES.includes(role) ? null : SAMPLE_CHAPTER_ID;
}

// How old a case note is, in days, at index `index`. Notes advance forward
// from the day the case opened to the day it was last touched, and the LAST
// note lands exactly on updated_at so a case never displays a newest note
// older than its own recency stamp.
export function caseUpdateDaysAgo(item, index) {
  const span = item.openedDaysAgo - item.updatedDaysAgo;
  return item.openedDaysAgo - (span * (index + 1)) / item.updates.length;
}

// RSVPs must land before the event they attend. A 21-day cap would put a
// 1,000-day-old meeting's RSVP last week and mint those points in the current
// Reports window.
export function rsvpDaysBeforeEvent(startsInDays) {
  if (startsInDays > 0) return 3;
  return Math.abs(startsInDays) + 2;
}

// ---------------------------------------------------------------- rails ----

export function supabaseRefFromOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export function assertSampleTarget(url) {
  const origin = new URL(url).origin;
  const ref = supabaseRefFromOrigin(origin);
  const forbidden = new Set(contract.forbiddenSampleSupabaseRefs);
  if (!ref) throw new Error(`SAMPLE seed target must be a supabase.co origin, got ${origin}`);
  if (forbidden.has(ref)) {
    throw new Error(`Refusing to seed forbidden project ${ref}. SAMPLE data must not touch production or retired databases.`);
  }
  if (contract.sampleSupabaseRef && ref !== contract.sampleSupabaseRef) {
    throw new Error(`SAMPLE seed target ${ref} does not match pinned sampleSupabaseRef ${contract.sampleSupabaseRef}`);
  }
  return { origin, ref };
}

// The realism guard, which replaced the old `labeledSample` check when the
// owner reversed the labeling decision on 2026-08-20. Every key listed here
// renders somewhere a member or staffer can read it, so a "SAMPLE"/"PREVIEW"
// token reaching one of them is the defect this guard exists to catch. Machine
// fields (confirm, target, hat, key, status, kind, ids) are deliberately NOT
// listed — CONFIRM itself contains "SAMPLE", and it is never rendered.
export const VISIBLE_SEED_KEYS = Object.freeze([
  "firstName", "fullName", "initials", "roleLine", "email", "chapterName",
  "title", "titleEs", "body", "bodyEs", "description", "summary", "location", "name",
  "reference", "caseType", "step", "articles", "updates",
  "senderName", "sender", "label", "labelEs",
  "workstream", "workstreams", "assigneeName", "checkInCode", "articleRef", "keywords",
  "purpose", "affiliation", "city", "region", "parentName", "designation",
]);

const VISIBLE_SEED_KEY_SET = new Set(VISIBLE_SEED_KEYS);

export function collectVisibleSeedStrings(value, key = null, out = []) {
  if (typeof value === "string") {
    if (key && VISIBLE_SEED_KEY_SET.has(key)) out.push(value);
    return out;
  }
  // An array inherits its parent key, so `updates: ["…"]` and
  // `workstreams: ["…"]` are collected as the visible strings they are.
  if (Array.isArray(value)) {
    for (const item of value) collectVisibleSeedStrings(item, key, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectVisibleSeedStrings(child, childKey, out);
    return out;
  }
  return out;
}

export const LABELED_SEED_PATTERN = /sample|preview/i;

// Test-fixture labels are a defect in seed copy too: the 2026-10-02 census
// found "Fixture …", "synthetic", "device fixture" and qa-…@example.invalid rows
// on the demo, and self-describing "realistic fictional" seed sentences.
export function assertUnlabeledSeed(plan) {
  const offenders = [...new Set(collectVisibleSeedStrings(plan))]
    .filter((text) => LABELED_SEED_PATTERN.test(text) || fixtureMarkersIn(text, SEED_FIXTURE_MARKERS).length > 0);
  if (offenders.length) {
    throw new Error(
      "SAMPLE seed content must stay unlabeled — the origin is the demo boundary, not the data. "
      + `Offending user-visible strings: ${offenders.join(" | ")}`,
    );
  }
  return true;
}

export function planSampleSeed({ url, now = new Date() } = {}) {
  const target = url ? assertSampleTarget(url) : null;
  const cases = ALL_SAMPLE_CASES.map((item) => ({
    ...item,
    reference: caseReferenceForSeed(item, now),
  }));
  const plan = {
    confirm: CONFIRM,
    portalOrigin: contract.samplePortalOrigin,
    target,
    chapter: { id: SAMPLE_CHAPTER_ID, name: SAMPLE_CHAPTER_NAME },
    // Deliberately NOT under a key in VISIBLE_SEED_KEYS. These strings ARE
    // labeled — that is what identifies them — but they name rows this run
    // DELETES, never rows it writes, so the realism guard must not see them.
    retiresLegacyLabeledAccounts: LEGACY_LABELED_EMAILS,
    // Same rule as retiresLegacyLabeledAccounts: these keys are deliberately
    // absent from VISIBLE_SEED_KEYS. The strings are the DATABASE's
    // placeholder copy, quoted here so the delete keys are auditable — they
    // describe rows this run removes, never rows it writes.
    reconciles: {
      triggerCaseTitles: TRIGGER_CASE_TITLES,
      triggerCaseReferencePattern: TRIGGER_CASE_REFERENCE_PATTERN.source,
      triggerMessageBodies: TRIGGER_MESSAGE_BODIES,
      triggerNotificationTitles: TRIGGER_NOTIFICATION_TITLES,
      placeholderBroadcastIds: PLACEHOLDER_BROADCAST_IDS,
      placeholderBallotIds: PLACEHOLDER_BALLOT_IDS,
      placeholderSurveyIds: PLACEHOLDER_SURVEY_IDS,
      placeholderEventIds: PLACEHOLDER_EVENT_IDS,
      placeholderKbSlugs: PLACEHOLDER_KB_SLUGS,
    },
    // admin and vp are org-wide (chapter_id NULL); the other three are pinned
    // to the demo chapter.
    roleScopes: Object.fromEntries(
      [...new Set(SAMPLE_ROSTER.flatMap((member) => member.roles))]
        .map((role) => [role, roleChapterScope(role)]),
    ),
    personaPasswordConfigured: Boolean(contract.samplePersonaPassword),
    personas: SAMPLE_PERSONAS,
    members: SAMPLE_ROSTER,
    workstreams: SAMPLE_WORKSTREAMS,
    cases,
    conversations: ALL_SAMPLE_CONVERSATIONS,
    events: ALL_SAMPLE_EVENTS,
    broadcasts: ALL_SAMPLE_BROADCASTS,
    stewardRequests: SAMPLE_STEWARD_REQUESTS,
    tasks: ALL_SAMPLE_TASKS,
    notifications: ALL_SAMPLE_NOTIFICATIONS,
    livedIn: livedInPlanSlice(),
    counts: {
      personas: SAMPLE_PERSONAS.length,
      members: SAMPLE_ROSTER.length,
      roleRows: SAMPLE_ROSTER.reduce((total, member) => total + member.roles.length, 0),
      cases: cases.length,
      caseUpdates: cases.reduce((total, item) => total + item.updates.length, 0),
      conversations: ALL_SAMPLE_CONVERSATIONS.length,
      messages: ALL_SAMPLE_CONVERSATIONS.reduce((total, item) => total + item.messages.length, 0),
      events: ALL_SAMPLE_EVENTS.length,
      broadcasts: ALL_SAMPLE_BROADCASTS.length,
      stewardRequests: SAMPLE_STEWARD_REQUESTS.length,
      workstreams: SAMPLE_WORKSTREAMS.length,
      tasks: ALL_SAMPLE_TASKS.length,
      ballots: SAMPLE_BALLOTS.length,
      openBallots: SAMPLE_BALLOTS.filter((item) => !item.closed).length,
      surveys: SAMPLE_SURVEYS.length,
      openSurveys: SAMPLE_SURVEYS.filter((item) => !item.closed).length,
      historyWeeks: SAMPLE_HISTORY_WEEKS,
      spaces: SAMPLE_SPACES.length,
      kbArticles: SAMPLE_KB_ARTICLES.length,
      partnerOrgs: SAMPLE_PARTNER_ORGS.length,
      handshakes: SAMPLE_HANDSHAKES.length,
      sentHandshakes: SAMPLE_HANDSHAKES.filter((item) => item.status === "requested").length,
      draftHandshakes: SAMPLE_HANDSHAKES.filter((item) => item.status === "draft").length,
      partnerChapterMembers: SAMPLE_PARTNER_CHAPTER_MEMBERS.length,
    },
    // Asserted below, and re-asserted by the CLI before anything prints.
    unlabeled: true,
  };
  assertUnlabeledSeed(plan);
  return plan;
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

export async function findExistingUserId(client, email, cache = {}) {
  // Look up an existing auth user by email across every page exactly once.
  // Reading only page 1 (the previous behaviour) silently misses members past
  // the first 200 rows and re-fetched the same page for every member.
  if (!cache.byEmail) {
    const perPage = 200;
    const maxPages = 1_000;
    const byEmail = new Map();
    let page = 1;
    for (let pagesRead = 0; pagesRead < maxPages; pagesRead += 1) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = data?.users ?? [];
      for (const user of users) byEmail.set(user.email, user.id);
      const nextPage = Number(data?.nextPage);
      if (Number.isInteger(nextPage) && nextPage > page) {
        if (pagesRead + 1 === maxPages) {
          throw new Error(`SAMPLE Auth directory exceeds the ${maxPages * perPage}-user lookup safety bound`);
        }
        page = nextPage;
        continue;
      }
      if (users.length < perPage) break;
      if (pagesRead + 1 === maxPages) {
        throw new Error(`SAMPLE Auth directory exceeds the ${maxPages * perPage}-user lookup safety bound`);
      }
      page += 1;
    }
    cache.byEmail = byEmail;
  }
  return cache.byEmail.get(email);
}

// ----------------------------------------------------------------- apply ---

// Deterministic row ids. Every seeded row whose primary key this script may
// supply is keyed off a stable string, so a second --apply UPDATES the row it
// wrote last time instead of inserting a duplicate. The auth user id is part
// of the input, and that id is itself stable (created once, then found by
// findExistingUserId), so the whole seed is idempotent.
export function stableUuid(...parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The seed's own thread ids, computed identically here and in
// seedConversations so the reconcile pass can prove which "Chapter steward"
// conversations are its own before it deletes any of the trigger's.
function seededConversationId(userId, thread) {
  return stableUuid("member_conversation", userId, thread.title, String(thread.openedDaysAgo));
}

export function seededConversationIds(roster) {
  return ALL_SAMPLE_CONVERSATIONS
    .filter((thread) => roster.has(thread.memberKey))
    .map((thread) => seededConversationId(roster.get(thread.memberKey).userId, thread));
}

function shiftDays(now, days) {
  return new Date(now.getTime() + days * 86400000);
}

export function caseReferenceForSeed(item, now) {
  if (item.reference) return item.reference;
  if (!Number.isInteger(item.referenceSequence) || item.referenceSequence < 0 || item.referenceSequence > 999) {
    throw new Error("Generated SAMPLE case requires a three-digit reference sequence");
  }
  if (!Number.isFinite(item.openedDaysAgo) || item.openedDaysAgo < 0) {
    throw new Error("Generated SAMPLE case requires a non-negative openedDaysAgo value");
  }
  const openedAt = shiftDays(now, -item.openedDaysAgo);
  return `GR-${openedAt.getUTCFullYear()}-${String(item.referenceSequence).padStart(3, "0")}`;
}

function isoDaysAgo(now, days) {
  return shiftDays(now, -days).toISOString();
}

function isoHoursAgo(now, hours) {
  return new Date(now.getTime() - hours * 3600000).toISOString();
}

function dateOnlyInDays(now, days) {
  if (days === null || days === undefined) return null;
  return shiftDays(now, days).toISOString().slice(0, 10);
}

function eventStartsAt(now, event) {
  const day = shiftDays(now, event.startsInDays);
  day.setHours(Math.floor(event.startsAtHour), Math.round((event.startsAtHour % 1) * 60), 0, 0);
  return day.toISOString();
}

function failOn(error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function sameSeedValue(before, after) {
  if (before === after) return true;
  if (before != null && after != null && typeof before === "object" && typeof after === "object") {
    return JSON.stringify(before) === JSON.stringify(after);
  }
  if (typeof before === "string" && typeof after === "string" && ISO_INSTANT.test(before) && ISO_INSTANT.test(after)) {
    const left = Date.parse(before);
    const right = Date.parse(after);
    return !Number.isNaN(left) && left === right;
  }
  return false;
}

// Every seeded timestamp is derived from the run's `now`, so an unconditional
// re-upsert rewrites them all on each apply. That breaks two different things:
//
//   * member_cases and member_conversations carry a BEFORE UPDATE
//     private.touch_updated_at() trigger (20260720191847:245-246) that stamps
//     updated_at with now() on ANY write, collapsing the staggered recency the
//     seed is built around and reshuffling the steward desk (its caseload
//     orders by deadline, then updated_at) into insertion order.
//   * the CHILD rows — case notes, messages, notices — recompute created_at
//     from the new `now`, so a second apply pushed a case's newest note past
//     its own parent's updated_at. That is the exact inverse of the recency
//     the note progression exists to produce.
//
// So every seeded table reads its rows back first and writes ONLY the ones
// whose content actually differs. Comparison is on content columns. Timestamps
// stay out of trigger-stamped parent/child tables (cases, conversations, notes)
// because a rewrite restamps updated_at and inverts recency. Rolling computed
// dates — campaign closes_at, RSVP created_at, ledger occurred_at — are
// compared so a formula fix or a later apply can land. sameSeedValue treats
// equal ISO instants as unchanged, so PostgREST's +00:00 vs .000Z does not
// count as a rewrite. A no-change apply therefore issues no write except on
// those deliberately rolling date columns, which move with the run's `now`.
//
// Residual, accepted: a genuine content edit DOES move that row's timestamps —
// its own recomputed created_at, and (on the two triggered tables) an
// updated_at the trigger owns and no client can opt out of. That is the honest
// outcome: the row really did change, and it affects only the rows whose text
// the seed author edited.
//
// `keyColumns` defaults to the single `id` primary key. member_event_rsvps is
// keyed (event_id, user_id) instead, so it passes both and reads its existing
// rows through the first of them.
export async function writeChangedRows(client, table, rows, contentColumns, label, options = {}) {
  if (!rows.length) return { written: 0, unchanged: 0 };
  const keyColumns = options.keyColumns ?? ["id"];
  const lookupColumn = keyColumns[0];
  const rowKey = (row) => keyColumns.map((column) => String(row[column])).join("\u0000");
  const { data: existing, error } = await client.from(table)
    .select([...new Set([...keyColumns, ...contentColumns])].join(","))
    .in(lookupColumn, [...new Set(rows.map((row) => row[lookupColumn]))]);
  failOn(error, `Failed to read existing ${label}`);
  const byKey = new Map((existing || []).map((row) => [rowKey(row), row]));
  const changed = rows.filter((row) => {
    const current = byKey.get(rowKey(row));
    if (!current) return true;
    return contentColumns.some((column) => !sameSeedValue(current[column] ?? null, row[column] ?? null));
  });
  if (changed.length) {
    const { error: writeError } = await client.from(table)
      .upsert(changed, { onConflict: keyColumns.join(",") });
    failOn(writeError, `Failed to write ${label}`);
  }
  return { written: changed.length, unchanged: rows.length - changed.length };
}

export async function writeChangedRowsChunked(client, table, rows, contentColumns, label, options = {}) {
  const chunkSize = options.chunkSize ?? 200;
  let written = 0;
  let unchanged = 0;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const result = await writeChangedRows(
      client,
      table,
      chunk,
      contentColumns,
      `${label} ${index + 1}-${index + chunk.length}`,
      options,
    );
    written += result.written;
    unchanged += result.unchanged;
  }
  return { written, unchanged };
}

// Retire the labeled roster the previous contract seeded. Deleting the auth
// user is sufficient and is the ONLY delete this script performs: every table
// the old seed and private.handle_new_member() wrote for those accounts
// references auth.users(id) ON DELETE CASCADE —
//   member_profiles.id, member_cases.user_id, member_case_updates.user_id,
//   member_notifications.user_id, member_conversations.user_id,
//   member_messages.user_id, member_rights_progress.user_id,
//   member_action_log.user_id (20260720191847_fresh_member_workflows.sql) and
//   member_notification_deliveries.user_id (20260723201000).
// The ON DELETE RESTRICT references to auth.users all sit on authored-content
// columns (chapter_spaces/chapter_threads/chapter_thread_posts/chapter_documents/
// chapter_records/chapter_governance_requests created_by, and the coordinator
// case audit tables), which these two never wrote — they held no role and never
// signed in. If one of them somehow did, the delete fails loudly below rather
// than half-retiring the account.
//
// Idempotent: an address with no account is a no-op, which is the steady state
// after the first successful apply.
export async function retireLegacyLabeledAccounts(client) {
  const cache = {};
  const retired = [];
  const alreadyAbsent = [];
  for (const email of LEGACY_LABELED_EMAILS) {
    const userId = await findExistingUserId(client, email, cache);
    if (!userId) {
      alreadyAbsent.push(email);
      continue;
    }
    const { error } = await client.auth.admin.deleteUser(userId);
    if (error) {
      throw new Error(
        `Failed to retire the previous labeled SAMPLE account ${email}. Its rows are still `
        + "user-visible, so the seed stops rather than adding unlabeled data beside them "
        + `(a surviving ON DELETE RESTRICT reference would look like this): ${error.message}`,
      );
    }
    retired.push(email);
  }
  return { retired, alreadyAbsent };
}

// Reconcile the rows the DATABASE created, which the seed does not own but
// which a visitor reads as demo content. Runs AFTER the roster exists (the
// trigger rows only exist once their accounts do) and BEFORE the seed writes
// its own content, so the placeholder never appears beside the real thing.
//
// Every delete is (a) scoped to the sixteen seeded user ids, and (b) keyed on
// a literal transcribed from the migration that created it. Nothing here can
// reach a row this script wrote: the case titles, message bodies and
// notification titles are all disjoint from the seed's own content, and the
// conversation pass additionally excludes the seed's deterministic ids by
// value. Idempotent by construction — a second run finds nothing to delete.
export async function reconcileGeneratedRows(client, roster, seededConversationIds, extraUserIds = []) {
  const userIds = [...roster.values()].map((member) => member.userId).concat(extraUserIds);
  const removed = { cases: 0, conversations: 0, notifications: 0, broadcasts: 0, ballots: 0, surveys: 0, events: 0, kbArticles: 0 };

  // 1. The four boilerplate cases per member. Read first, re-verify the
  //    reference shape row by row, then delete by exact id — a title match
  //    alone would be a wider claim than the trigger's own contract.
  const { data: caseRows, error: caseReadError } = await client.from("member_cases")
    .select("id,reference,title")
    .in("user_id", userIds)
    .in("title", [...TRIGGER_CASE_TITLES]);
  failOn(caseReadError, "Failed to read generated SAMPLE cases");
  const caseIds = (caseRows || [])
    .filter((row) => TRIGGER_CASE_REFERENCE_PATTERN.test(row.reference))
    .map((row) => row.id);
  if (caseIds.length) {
    // member_case_updates.case_id cascades (20260720191847:78).
    const { error } = await client.from("member_cases").delete().in("id", caseIds);
    failOn(error, "Failed to retire generated SAMPLE cases");
    removed.cases = caseIds.length;
  }

  // 2. The two boilerplate conversations per member, found through the exact
  //    steward message the trigger writes into each of them.
  const { data: messageRows, error: messageReadError } = await client.from("member_messages")
    .select("conversation_id,body,sender_kind,sender_name")
    .in("user_id", userIds)
    .in("body", [...TRIGGER_MESSAGE_BODIES]);
  failOn(messageReadError, "Failed to read generated SAMPLE messages");
  const protectedIds = new Set(seededConversationIds);
  const conversationIds = [...new Set((messageRows || [])
    .filter((row) => row.sender_kind === "steward" && row.sender_name === STEWARD_WIRE_NAME)
    .map((row) => row.conversation_id))]
    .filter((id) => !protectedIds.has(id));
  if (conversationIds.length) {
    // member_messages.conversation_id cascades (20260720191847:36).
    const { error } = await client.from("member_conversations").delete().in("id", conversationIds);
    failOn(error, "Failed to retire generated SAMPLE conversations");
    removed.conversations = conversationIds.length;
  }

  // 3. The three seed.* notifications per member, by their rendered titles.
  const { data: noticeRows, error: noticeReadError } = await client.from("member_notifications")
    .select("id")
    .in("user_id", userIds)
    .in("title", [...TRIGGER_NOTIFICATION_TITLES]);
  failOn(noticeReadError, "Failed to read generated SAMPLE notifications");
  const noticeIds = (noticeRows || []).map((row) => row.id);
  if (noticeIds.length) {
    // member_notification_deliveries.notification_id cascades (20260723201000:61).
    const { error } = await client.from("member_notifications").delete().in("id", noticeIds);
    failOn(error, "Failed to retire generated SAMPLE notifications");
    removed.notifications = noticeIds.length;
  }

  // 4. The twenty migration-seeded placeholder broadcasts. Chapter-wide rather
  //    than per-user, so this one is keyed on the primary keys the migration
  //    itself spells out. member_broadcast_receipts cascades (20260720191847:56).
  const { data: broadcastRows, error: broadcastReadError } = await client.from("member_broadcasts")
    .select("id")
    .in("id", [...PLACEHOLDER_BROADCAST_IDS]);
  failOn(broadcastReadError, "Failed to read placeholder SAMPLE broadcasts");
  const broadcastIds = (broadcastRows || []).map((row) => row.id);
  if (broadcastIds.length) {
    const { error } = await client.from("member_broadcasts").delete().in("id", broadcastIds);
    failOn(error, "Failed to retire placeholder SAMPLE broadcasts");
    removed.broadcasts = broadcastIds.length;
  }

  // 5. Migration-seeded ballots/surveys/events still titled "Fictional Public
  //    Service Chapter" or pointed at Pine Harbor/Maple Crossing. Receipts restrict
  //    ballot deletes, so they go first; choices cascade with the ballot.
  const { error: receiptDeleteError } = await client.from("member_ballot_receipts")
    .delete()
    .in("ballot_id", [...PLACEHOLDER_BALLOT_IDS]);
  failOn(receiptDeleteError, "Failed to retire placeholder SAMPLE ballot receipts");
  const { data: ballotRows, error: ballotReadError } = await client.from("member_ballots")
    .select("id")
    .in("id", [...PLACEHOLDER_BALLOT_IDS]);
  failOn(ballotReadError, "Failed to read placeholder SAMPLE ballots");
  const ballotIds = (ballotRows || []).map((row) => row.id);
  if (ballotIds.length) {
    const { error } = await client.from("member_ballots").delete().in("id", ballotIds);
    failOn(error, "Failed to retire placeholder SAMPLE ballots");
    removed.ballots = ballotIds.length;
  }

  const { data: surveyRows, error: surveyReadError } = await client.from("member_surveys")
    .select("id")
    .in("id", [...PLACEHOLDER_SURVEY_IDS]);
  failOn(surveyReadError, "Failed to read placeholder SAMPLE surveys");
  const surveyIds = (surveyRows || []).map((row) => row.id);
  if (surveyIds.length) {
    const { error } = await client.from("member_surveys").delete().in("id", surveyIds);
    failOn(error, "Failed to retire placeholder SAMPLE surveys");
    removed.surveys = surveyIds.length;
  }

  const { data: eventRows, error: eventReadError } = await client.from("member_events")
    .select("id")
    .in("id", [...PLACEHOLDER_EVENT_IDS]);
  failOn(eventReadError, "Failed to read placeholder SAMPLE events");
  const eventIds = (eventRows || []).map((row) => row.id);
  if (eventIds.length) {
    const { error } = await client.from("member_events").delete().in("id", eventIds);
    failOn(error, "Failed to retire placeholder SAMPLE events");
    removed.events = eventIds.length;
  }

  // 6. Migration-seeded Compass articles still titled against the fictional
  //    public-service chapter. RLS hides is_sample rows from members, but a
  //    service-role sweep still reads them, and the origin is the demo
  //    boundary — those strings should not remain in the SAMPLE database.
  //    Revisions restrict article deletes, so they go first.
  const { data: kbRows, error: kbReadError } = await client.from("member_kb_articles")
    .select("id,slug")
    .in("slug", [...PLACEHOLDER_KB_SLUGS]);
  failOn(kbReadError, "Failed to read placeholder SAMPLE Compass articles");
  const kbIds = (kbRows || []).map((row) => row.id);
  if (kbIds.length) {
    const { error: revisionError } = await client.from("member_kb_article_revisions")
      .delete()
      .in("article_id", kbIds);
    failOn(revisionError, "Failed to retire placeholder SAMPLE Compass revisions");
    const { error } = await client.from("member_kb_articles").delete().in("id", kbIds);
    failOn(error, "Failed to retire placeholder SAMPLE Compass articles");
    removed.kbArticles = kbIds.length;
  }

  return removed;
}

// public.org_security_policy.require_staff_mfa ships TRUE
// (20260812091000_staff_mfa_policy.sql), and get_staff_mfa_standing then
// reports blocked=true for any account holding a member_roles row with no
// enrolled factor — which loadMemberApp turns into roles=[] client-side. In
// the SAMPLE database that would silently empty every staff hat the demo's
// switcher offers, so the demo project turns the org policy off. This is a
// SAMPLE-only row in a project assertSampleTarget has already proven is the
// pinned demo ref; production keeps its default.
async function relaxStaffMfaForDemo(client) {
  const { error } = await client.from("org_security_policy")
    .update({ require_staff_mfa: false })
    .eq("id", true)
    .is("organization_id", null);
  if (error) {
    throw new Error(
      "Failed to clear the SAMPLE staff two-step policy — every staff hat would load with no roles: "
      + error.message,
    );
  }
}

async function ensureRosterUsers(client, password) {
  const cache = {};
  const byKey = new Map();
  for (const member of SAMPLE_ROSTER) {
    const metadata = {
      sample: true,
      first_name: member.firstName,
      full_name: member.fullName,
      initials: member.initials,
      chapter_id: SAMPLE_CHAPTER_ID,
    };
    const { data, error } = await client.auth.admin.createUser({
      email: member.email,
      // Only the six hat personas are sign-in capable. The rest of the chapter
      // exists so the desks have members to represent; giving them passwords
      // would widen the demo's credential surface for nothing.
      ...(member.signIn ? { password } : {}),
      email_confirm: true,
      user_metadata: metadata,
      app_metadata: {
        sample: true,
        surface: "sample",
        ...(member.signIn ? { sample_persona: member.hat } : {}),
      },
    });
    let userId = data?.user?.id;
    if (error || !userId) {
      let existingId;
      try {
        existingId = await findExistingUserId(client, member.email, cache);
      } catch (lookupError) {
        throw new Error(
          `Failed to create SAMPLE member ${member.email}: ${error?.message || lookupError.message}`,
          { cause: lookupError },
        );
      }
      userId = existingId;
      if (!userId) throw new Error(`Failed to create SAMPLE member ${member.email}: ${error?.message || "user missing"}`);
      if (member.signIn) {
        // Re-running the seed must leave the published demo password working
        // even if the account already existed with another one.
        const { error: updateError } = await client.auth.admin.updateUserById(userId, {
          password,
          email_confirm: true,
          user_metadata: metadata,
          app_metadata: {
            sample: true,
            surface: "sample",
            ...(member.signIn ? { sample_persona: member.hat } : {}),
          },
        });
        failOn(updateError, `Failed to refresh SAMPLE persona ${member.email}`);
      }
    }
    byKey.set(member.key, { ...member, userId });
  }
  return byKey;
}

async function seedProfilesAndRoles(client, roster) {
  const profiles = [...roster.values()].map((member) => ({
    id: member.userId,
    first_name: member.firstName,
    full_name: member.fullName,
    initials: member.initials,
    role_line: member.roleLine,
    member_since: member.memberSince,
    chapter_id: SAMPLE_CHAPTER_ID,
  }));
  // member_profiles carries the third touch_updated_at() trigger
  // (20260720191847:244), so it gets the same treatment even though nothing
  // orders on a profile's updated_at — the point is that a no-change apply
  // writes nothing anywhere.
  const profileWrite = await writeChangedRows(client, "member_profiles", profiles, [
    "first_name", "full_name", "initials", "role_line", "member_since", "chapter_id",
  ], "SAMPLE member profiles");

  // member_roles is (user_id, role) primary key with a chapter_id where NULL
  // means ORG-WIDE scope (20260723040000_chapter_model_foundation.sql:74).
  //
  // admin and vp MUST be org-wide. private.can_manage_vote_scope
  // (20260812140000_staff_campaign_authoring.sql:66) grants union-scope
  // campaign authoring only to an admin/vp role row whose chapter_id IS NULL,
  // so a 'wor'-scoped admin gets canManageUnion=false and an empty union
  // Campaigns desk. NULL costs those two hats nothing at chapter scope either:
  // the chapter branch of the same function accepts `chapter_id is null or
  // chapter_id = p_chapter_id`, and current_member_chapter() still resolves to
  // 'wor' from the profile.
  //
  // steward, coordinator and advisor stay pinned to the demo chapter — that is
  // the least-privilege scope staff_can_see_user() evaluates, and every seeded
  // member is in 'wor', so nothing they need is out of reach.
  const roles = [...roster.values()].flatMap((member) => member.roles.map((role) => ({
    user_id: member.userId,
    role,
    // The conflict target is the (user_id, role) primary key, so an existing
    // chapter-scoped row is UPDATED to org-wide rather than duplicated.
    chapter_id: roleChapterScope(role),
  })));
  // granted_at is DB-defaulted and never in the payload, so nothing here can
  // drift — but comparing on chapter_id is what makes the live 'wor'-scoped
  // admin/vp rows the ONLY two roles this apply rewrites.
  const roleWrite = await writeChangedRows(client, "member_roles", roles, [
    "chapter_id",
  ], "SAMPLE staff roles", { keyColumns: ["user_id", "role"] });

  // Chapter budget access, owner text 12:26 PM ET Saturday October 10, 2026:
  // "Q39 go, Q40 A, Q41 A, Q42 A, Q43 A, Q44 A, Q45 A, Android B, phone 2A 3
  // yes 4 yes". The officer budget RPCs in
  // 20261009003000_chapter_officer_budgets.sql derive can_read from
  // public.member_role_chapters (role 'vp' for the caller's own chapter) or a
  // member_chapter_memberships.budget_office, and this seed never wrote
  // member_role_chapters at all, so get_chapter_budget_access answered
  // canRead false for the President hat and the officer budget surface was
  // unreachable on SAMPLE.
  //
  // The grant must land on the ORGANIZATION'S chapter, not SAMPLE_CHAPTER_ID.
  // private.chapter_budget_context resolves the chapter from the profile and
  // then demands `chapters.organization_id = organizations.id` for the
  // caller's active organization; 'wor' is the migrated is_default chapter and
  // carries organization_id NULL, so a grant pinned there can never satisfy
  // that check. Read the persona's own active chapter memberships instead and
  // grant on the ones that belong to an organization.
  //
  // member_roles keeps the org-wide NULL scope above for the reasons in that
  // comment. Additive: nothing is changed or removed, and only the vp persona
  // gets a row.
  const budgetPersonaIds = [...roster.values()]
    .filter((member) => member.roles.includes("vp"))
    .map((member) => member.userId);
  let budgetRoleWrite = { written: 0, unchanged: 0 };
  let budgetGrants = [];
  if (budgetPersonaIds.length) {
    const { data: memberships, error: membershipError } = await client
      .from("member_chapter_memberships")
      .select("user_id,chapter_id")
      .in("user_id", budgetPersonaIds)
      .eq("status", "active");
    failOn(membershipError, "Failed to read the President persona's chapter memberships");
    const { data: orgChapters, error: chapterError } = await client
      .from("chapters")
      .select("id")
      .in("id", [...new Set((memberships || []).map((row) => row.chapter_id))])
      .not("organization_id", "is", null);
    failOn(chapterError, "Failed to read the organization's chapters");
    const scoped = new Set((orgChapters || []).map((row) => row.id));
    budgetGrants = (memberships || [])
      .filter((row) => scoped.has(row.chapter_id))
      .map((row) => ({ user_id: row.user_id, role: "vp", chapter_id: row.chapter_id }));
    budgetRoleWrite = await writeChangedRows(client, "member_role_chapters", budgetGrants, [
      "chapter_id",
    ], "SAMPLE chapter President budget grant", { keyColumns: ["user_id", "role", "chapter_id"] });
  }

  return {
    profiles: profiles.length,
    profilesWritten: profileWrite.written,
    profilesUnchanged: profileWrite.unchanged,
    roles: roles.length,
    rolesWritten: roleWrite.written,
    rolesUnchanged: roleWrite.unchanged,
    chapterRoles: budgetGrants.length,
    chapterRolesWritten: budgetRoleWrite.written,
    chapterRolesUnchanged: budgetRoleWrite.unchanged,
  };
}

async function seedCases(client, roster, now) {
  const caseRows = [];
  const updateRows = [];
  for (const item of ALL_SAMPLE_CASES) {
    const member = roster.get(item.memberKey);
    const steward = item.stewardKey ? roster.get(item.stewardKey) : null;
    const coordinator = item.coordinatorKey ? roster.get(item.coordinatorKey) : null;
    const reference = caseReferenceForSeed(item, now);
    const caseId = stableUuid("member_case", member.userId, item.seedKey || reference);
    caseRows.push({
      id: caseId,
      user_id: member.userId,
      reference,
      title: item.title,
      deadline: dateOnlyInDays(now, item.deadlineInDays),
      case_type: item.caseType,
      articles: item.articles,
      step: item.step,
      status: item.status,
      // The steward desk's caseload is exactly
      // `steward_user_id = auth.uid() and user_id <> auth.uid()`
      // (memberApi.js loadStewardDesk), so without these two columns the
      // steward hat opens on an empty queue.
      steward_user_id: steward?.userId ?? null,
      steward_name: steward?.fullName ?? null,
      coordinator_user_id: coordinator?.userId ?? null,
      coordinator_name: coordinator?.fullName ?? null,
      assigned_at: isoDaysAgo(now, item.openedDaysAgo),
      created_at: isoDaysAgo(now, item.openedDaysAgo),
      updated_at: isoDaysAgo(now, item.updatedDaysAgo),
    });
    // Notes advance FORWARD from the day the case opened to the day it was
    // last touched, and the newest note lands exactly on updated_at. The
    // previous `Math.max(updatedDaysAgo, openedDaysAgo - …)` picked whichever
    // date was OLDER, so a case updated yesterday could show its most recent
    // note fifty days back — the file read as abandoned on every desk that
    // sorts by recency.
    item.updates.forEach((body, index) => {
      updateRows.push({
        id: stableUuid("member_case_update", caseId, String(index)),
        case_id: caseId,
        user_id: member.userId,
        body,
        created_at: isoDaysAgo(now, caseUpdateDaysAgo(item, index)),
      });
    });
  }
  const caseWrite = await writeChangedRows(client, "member_cases", caseRows, [
    "user_id", "reference", "title", "deadline", "case_type", "articles", "step", "status",
    "steward_user_id", "steward_name", "coordinator_user_id", "coordinator_name",
  ], "SAMPLE cases");
  // The notes get the same treatment as their parent. Rewriting them
  // unconditionally recomputed created_at from the new `now`, which pushed a
  // case's newest note PAST the parent's preserved updated_at — a file that
  // read as "last touched a month ago, latest note today".
  const updateWrite = await writeChangedRows(client, "member_case_updates", updateRows, [
    "case_id", "user_id", "body",
  ], "SAMPLE case updates");
  return {
    cases: caseRows.length,
    casesWritten: caseWrite.written,
    casesUnchanged: caseWrite.unchanged,
    caseUpdates: updateRows.length,
    caseUpdatesWritten: updateWrite.written,
    caseUpdatesUnchanged: updateWrite.unchanged,
  };
}

async function seedConversations(client, roster, now) {
  const conversationRows = [];
  const messageRows = [];
  for (const thread of ALL_SAMPLE_CONVERSATIONS) {
    const member = roster.get(thread.memberKey);
    const conversationId = seededConversationId(member.userId, thread);
    const newest = Math.min(...thread.messages.map((message) => message.daysAgo));
    conversationRows.push({
      id: conversationId,
      user_id: member.userId,
      title: thread.title,
      initials: thread.initials,
      created_at: isoDaysAgo(now, thread.openedDaysAgo),
      updated_at: isoDaysAgo(now, newest),
    });
    thread.messages.forEach((message, index) => {
      messageRows.push({
        id: stableUuid("member_message", conversationId, String(index)),
        conversation_id: conversationId,
        user_id: member.userId,
        sender_kind: message.senderKind,
        sender_name: message.senderName || member.fullName,
        body: message.body,
        read_at: message.read ? isoDaysAgo(now, message.daysAgo) : null,
        created_at: isoDaysAgo(now, message.daysAgo),
      });
    });
  }
  const conversationWrite = await writeChangedRows(client, "member_conversations", conversationRows, [
    "user_id", "title", "initials",
  ], "SAMPLE conversations");
  // Same for the messages inside them: created_at (and the read_at derived
  // from it) is written once and then left alone, so a thread's last message
  // never drifts newer than the thread's own updated_at.
  const messageWrite = await writeChangedRows(client, "member_messages", messageRows, [
    "conversation_id", "user_id", "sender_kind", "sender_name", "body",
  ], "SAMPLE messages");
  return {
    conversations: conversationRows.length,
    conversationsWritten: conversationWrite.written,
    conversationsUnchanged: conversationWrite.unchanged,
    messages: messageRows.length,
    messagesWritten: messageWrite.written,
    messagesUnchanged: messageWrite.unchanged,
  };
}

async function seedEvents(client, roster, now) {
  const eventRows = ALL_SAMPLE_EVENTS.map((event) => ({
    id: event.id,
    title: event.title,
    starts_at: eventStartsAt(now, event),
    location: event.location,
    summary: event.summary,
    check_in_code: event.checkInCode,
    order_index: event.orderIndex,
    chapter_id: SAMPLE_CHAPTER_ID,
    is_public: event.isPublic,
    is_public_across_agencies: event.isPublicAcrossAgencies,
  }));
  // member_events is the ONE table deliberately rewritten every apply:
  // starts_at is recomputed from `now` on purpose, so re-seeding is also how
  // the demo's calendar stays ahead of today instead of decaying into an
  // all-past agenda. It has no touch trigger and nothing hangs a recency
  // relationship off it — the RSVPs below are always dated before it.
  for (let index = 0; index < eventRows.length; index += 100) {
    const chunk = eventRows.slice(index, index + 100);
    const { error: eventError } = await client.from("member_events").upsert(chunk, { onConflict: "id" });
    failOn(eventError, "Failed to write SAMPLE events");
  }

  const rsvpRows = [];
  const checkinRows = [];
  for (const event of ALL_SAMPLE_EVENTS) {
    const keys = event.rsvpKeys
      || [...roster.keys()].filter((key) => participates(key, event.id, event.rsvpPercent ?? 0));
    const rsvpAge = Math.max(1, rsvpDaysBeforeEvent(event.startsInDays));
    for (const key of keys) {
      const member = roster.get(key);
      if (!member) continue;
      rsvpRows.push({
        event_id: event.id,
        user_id: member.userId,
        status: "going",
        created_at: isoDaysAgo(now, rsvpAge),
        updated_at: isoDaysAgo(now, rsvpAge),
      });
      if (event.startsInDays < 0 && participates(key, `checkin:${event.id}`, event.checkInPercent ?? 80)) {
        checkinRows.push({
          event_id: event.id,
          user_id: member.userId,
          checked_in_at: eventStartsAt(now, { ...event, startsAtHour: event.startsAtHour + 0.25 }),
        });
      }
    }
  }
  const rsvpWrite = await writeChangedRowsChunked(client, "member_event_rsvps", rsvpRows, [
    "status", "created_at", "updated_at",
  ], "SAMPLE event RSVPs", { keyColumns: ["event_id", "user_id"] });
  const checkinWrite = await writeChangedRowsChunked(client, "member_event_checkins", checkinRows, [
    "checked_in_at",
  ], "SAMPLE event check-ins", { keyColumns: ["event_id", "user_id"] });
  return {
    events: eventRows.length,
    eventRsvps: rsvpRows.length,
    eventRsvpsWritten: rsvpWrite.written,
    eventRsvpsUnchanged: rsvpWrite.unchanged,
    eventCheckins: checkinRows.length,
    eventCheckinsWritten: checkinWrite.written,
    eventCheckinsUnchanged: checkinWrite.unchanged,
  };
}

async function seedBroadcastsAndRequests(client, roster, now) {
  const broadcastRows = ALL_SAMPLE_BROADCASTS.map((item) => ({
    id: item.id,
    sender: item.sender,
    title: item.title,
    body: item.body,
    published_at: isoDaysAgo(now, item.publishedDaysAgo),
    order_index: item.orderIndex,
    locale: "en",
  }));
  // published_at is excluded from the comparison for the same reason every
  // other timestamp is: the feed orders on it, so a no-change re-apply must
  // not shuffle three notices into "all published seconds apart, just now".
  const broadcastWrite = await writeChangedRows(client, "member_broadcasts", broadcastRows, [
    "sender", "title", "body", "order_index", "locale",
  ], "SAMPLE broadcasts");

  const requestRows = SAMPLE_STEWARD_REQUESTS.map((item) => {
    const member = roster.get(item.memberKey);
    return {
      id: stableUuid("member_steward_request", member.userId, item.lessonId),
      user_id: member.userId,
      lesson_id: item.lessonId,
      status: item.status,
      created_at: isoDaysAgo(now, item.daysAgo),
    };
  });
  const requestWrite = await writeChangedRows(client, "member_steward_requests", requestRows, [
    "user_id", "lesson_id", "status",
  ], "SAMPLE steward requests");
  return {
    broadcasts: broadcastRows.length,
    broadcastsWritten: broadcastWrite.written,
    broadcastsUnchanged: broadcastWrite.unchanged,
    stewardRequests: requestRows.length,
    stewardRequestsWritten: requestWrite.written,
    stewardRequestsUnchanged: requestWrite.unchanged,
  };
}

async function seedNotifications(client, roster, now) {
  const activeCaseOwners = new Set(ALL_SAMPLE_CASES.filter((item) => item.status === "active").map((item) => item.memberKey));
  const rows = [];
  for (const notice of ALL_SAMPLE_NOTIFICATIONS) {
    for (const member of roster.values()) {
      const inAudience = notice.audience === "all"
        || (notice.audience === "activeCaseOwners" && activeCaseOwners.has(member.key))
        || (notice.audience === "staff" && member.roles.length > 0);
      if (!inAudience) continue;
      rows.push({
        id: stableUuid("member_notification", member.userId, notice.key),
        user_id: member.userId,
        title: notice.title,
        body: notice.body,
        kind: "general",
        created_at: isoHoursAgo(now, notice.hoursAgo),
      });
    }
  }
  // The feed orders newest-first on created_at, so an unconditional rewrite
  // stacked all twenty-seven notices at "now" and every member's bell read as
  // if the whole chapter had happened in the last second.
  const write = await writeChangedRows(client, "member_notifications", rows, [
    "user_id", "title", "body", "kind",
  ], "SAMPLE notifications");
  return {
    notifications: rows.length,
    notificationsWritten: write.written,
    notificationsUnchanged: write.unchanged,
  };
}

async function ensureWorkstreams(client) {
  const rows = SAMPLE_WORKSTREAMS.map((name) => ({ chapter_id: SAMPLE_CHAPTER_ID, name }));
  const { error } = await client.from("chapter_workstreams")
    .upsert(rows, { onConflict: "chapter_id,name", ignoreDuplicates: true });
  failOn(error, "Failed to write SAMPLE task workstreams");
  return { workstreams: rows.length };
}

// chapter_tasks cannot be written with a bare service-role key: the BEFORE
// trigger private.prepare_chapter_task() raises 'authentication required' when
// auth.uid() is null, and it also stamps chapter_id, task_number, created_by
// and assignee_name from the CALLER. So the board is seeded the way a real
// coordinator seeds it — signed in as one of the demo personas, over the same
// RLS the product uses. The client below still carries the service key as its
// apikey; the Authorization header becomes the persona's own session token
// once sign-in succeeds.
async function seedTasks(createClient, target, serviceRoleKey, password, roster, now) {
  const author = roster.get("jordan.patel");
  const authored = createClient(target.origin, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await authored.auth.signInWithPassword({ email: author.email, password });
  if (signInError) {
    throw new Error(
      `Failed to sign in as ${author.email} to author SAMPLE tasks (chapter_tasks requires an authenticated `
      + `caller — private.prepare_chapter_task raises 'authentication required' for a bare service role): `
      + signInError.message,
    );
  }
  try {
    const { data: existing, error: readError } = await authored.from("chapter_tasks")
      .select("id,title")
      .eq("chapter_id", SAMPLE_CHAPTER_ID)
      .limit(2000);
    failOn(readError, "Failed to read existing SAMPLE tasks");
    // chapter_tasks has no client-writable id (the insert grant is column
    // scoped and excludes it) and no natural unique key a re-run could target
    // — the prepare trigger mints a FRESH task_number on every insert, so
    // (chapter_id, task_number) can never conflict. Idempotency is therefore
    // look-up-then-write on the title within this chapter.
    const byTitle = new Map((existing || []).map((row) => [row.title, row.id]));
    let inserted = 0;
    let refreshed = 0;
    for (const [index, task] of ALL_SAMPLE_TASKS.entries()) {
      const payload = {
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        workstream: task.workstream,
        assignee_id: roster.get(task.assigneeKey).userId,
        start_date: dateOnlyInDays(now, task.startInDays),
        due_date: dateOnlyInDays(now, task.dueInDays),
        progress: task.progress,
        blocked: task.blocked,
        milestone: task.milestone,
        order_index: index,
      };
      const existingId = byTitle.get(task.title);
      if (existingId) {
        // task_type is deliberately absent here: chapter_tasks_guard_template_type
        // fires on UPDATE OF task_type, and the card is already 'general'.
        const { error } = await authored.from("chapter_tasks").update(payload).eq("id", existingId);
        failOn(error, `Failed to refresh SAMPLE task "${task.title}"`);
        refreshed += 1;
        continue;
      }
      const { error } = await authored.from("chapter_tasks").insert({ ...payload, task_type: "general" });
      failOn(error, `Failed to write SAMPLE task "${task.title}"`);
      inserted += 1;
    }
    return { tasksInserted: inserted, tasksRefreshed: refreshed };
  } finally {
    await authored.auth.signOut().catch(() => {});
  }
}

function campaignState(item) {
  return item.closed ? "closed" : "open";
}

async function seedCampaigns(client, roster, now) {
  const author = roster.get("taylor.morgan") || roster.get("alex.rivera");
  const ballotRows = SAMPLE_BALLOTS.map((item) => ({
    id: item.id,
    title: item.title,
    title_es: item.titleEs,
    body: item.body,
    body_es: item.bodyEs,
    closes_at: shiftDays(now, item.closesInDays).toISOString(),
    active: !item.closed,
    order_index: item.orderIndex,
    quorum_target: item.quorumTarget,
    chapter_id: item.chapterId,
    campaign_state: campaignState(item),
    created_by: author.userId,
    published_at: isoDaysAgo(now, item.publishedDaysAgo),
    closed_at: item.closed ? shiftDays(now, item.closesInDays).toISOString() : null,
  }));
  const ballotWrite = await writeChangedRows(client, "member_ballots", ballotRows, [
    "title", "title_es", "body", "body_es", "active", "order_index", "quorum_target",
    "chapter_id", "campaign_state", "created_by", "closes_at", "published_at", "closed_at",
  ], "SAMPLE ballots");
  const ballotOptions = SAMPLE_BALLOTS.flatMap((item) => item.options.map((choice) => ({
    id: choice.id,
    ballot_id: item.id,
    label: choice.label,
    label_es: choice.labelEs,
    order_index: choice.orderIndex,
  })));
  const ballotOptionWrite = await writeChangedRows(client, "member_ballot_options", ballotOptions, [
    "ballot_id", "label", "label_es", "order_index",
  ], "SAMPLE ballot options");

  const surveyRows = SAMPLE_SURVEYS.map((item) => ({
    id: item.id,
    title: item.title,
    title_es: item.titleEs,
    body: item.body,
    body_es: item.bodyEs,
    closes_at: shiftDays(now, item.closesInDays).toISOString(),
    active: !item.closed,
    order_index: item.orderIndex,
    chapter_id: item.chapterId,
    campaign_state: campaignState(item),
    created_by: author.userId,
    published_at: isoDaysAgo(now, item.publishedDaysAgo),
    closed_at: item.closed ? shiftDays(now, item.closesInDays).toISOString() : null,
  }));
  const surveyWrite = await writeChangedRows(client, "member_surveys", surveyRows, [
    "title", "title_es", "body", "body_es", "active", "order_index",
    "chapter_id", "campaign_state", "created_by", "closes_at", "published_at", "closed_at",
  ], "SAMPLE surveys");
  const surveyOptions = SAMPLE_SURVEYS.flatMap((item) => item.options.map((choice) => ({
    id: choice.id,
    survey_id: item.id,
    label: choice.label,
    label_es: choice.labelEs,
    order_index: choice.orderIndex,
  })));
  const surveyOptionWrite = await writeChangedRows(client, "member_survey_options", surveyOptions, [
    "survey_id", "label", "label_es", "order_index",
  ], "SAMPLE survey options");

  return {
    ballots: ballotRows.length,
    ballotsWritten: ballotWrite.written,
    ballotOptions: ballotOptions.length,
    ballotOptionsWritten: ballotOptionWrite.written,
    surveys: surveyRows.length,
    surveysWritten: surveyWrite.written,
    surveyOptions: surveyOptions.length,
    surveyOptionsWritten: surveyOptionWrite.written,
  };
}

async function seedVotesAndSurveyResponses(client, roster, now) {
  const receiptRows = [];
  const choiceRows = [];
  const responseRows = [];
  for (const ballot of SAMPLE_BALLOTS) {
    const submittedAt = isoDaysAgo(now, Math.max(1, -ballot.closesInDays + 3));
    for (const member of roster.values()) {
      if (!participates(member.key, ballot.id, ballot.turnoutPercent)) continue;
      const choice = ballot.options[optionIndex(member.key, ballot.id, ballot.options.length)];
      receiptRows.push({
        id: stableUuid("ballot_receipt", member.userId, ballot.id),
        ballot_id: ballot.id,
        user_id: member.userId,
        receipt_code: ballotReceiptCode(member.key, ballot.id),
        counted: true,
        issued_at: submittedAt,
      });
      choiceRows.push({
        id: stableUuid("ballot_choice", ballot.id, choice.id, member.key),
        ballot_id: ballot.id,
        option_id: choice.id,
        stress_run_id: null,
      });
    }
  }
  for (const survey of SAMPLE_SURVEYS) {
    const submittedAt = isoDaysAgo(now, Math.max(1, -survey.closesInDays + 2));
    for (const member of roster.values()) {
      if (!participates(member.key, survey.id, survey.turnoutPercent)) continue;
      const choice = survey.options[optionIndex(member.key, survey.id, survey.options.length, 46)];
      responseRows.push({
        survey_id: survey.id,
        option_id: choice.id,
        user_id: member.userId,
        submitted_at: submittedAt,
      });
    }
  }
  const receiptWrite = await writeChangedRowsChunked(client, "member_ballot_receipts", receiptRows, [
    "ballot_id", "user_id", "receipt_code", "counted",
  ], "SAMPLE ballot receipts");
  const choiceWrite = await writeChangedRowsChunked(client, "member_ballot_choices", choiceRows, [
    "ballot_id", "option_id",
  ], "SAMPLE ballot choices");
  const responseWrite = await writeChangedRowsChunked(client, "member_survey_responses", responseRows, [
    "option_id",
  ], "SAMPLE survey responses", { keyColumns: ["survey_id", "user_id"] });
  return {
    ballotReceipts: receiptRows.length,
    ballotReceiptsWritten: receiptWrite.written,
    ballotChoices: choiceRows.length,
    ballotChoicesWritten: choiceWrite.written,
    surveyResponses: responseRows.length,
    surveyResponsesWritten: responseWrite.written,
  };
}

async function seedRightsWorkloadAndLedgers(client, roster, now) {
  const progressRows = [];
  const workloadRows = [];
  const pointRows = [];
  const actionRows = [];

  const addLedger = (member, actionKind, actionKey, daysAgo) => {
    const points = POINT_RULES[actionKind];
    if (!points) return;
    pointRows.push({
      id: stableUuid("point_event", member.userId, actionKey),
      user_id: member.userId,
      action_key: actionKey,
      action_kind: actionKind,
      points,
      occurred_at: isoDaysAgo(now, daysAgo),
    });
    actionRows.push({
      id: stableUuid("action_log", member.userId, actionKey),
      user_id: member.userId,
      action_key: actionKey,
      action_kind: actionKind,
      occurred_at: isoDaysAgo(now, daysAgo),
    });
  };

  for (const member of roster.values()) {
    for (const [index, lessonId] of RIGHTS_LESSONS.entries()) {
      const completed = member.signIn || participates(member.key, `rights:${lessonId}`, 55);
      if (!completed) continue;
      const daysAgo = 90 + index * 40 + hashMod(20, member.key, lessonId);
      progressRows.push({
        lesson_id: lessonId,
        user_id: member.userId,
        completed_steps: [1, 2, 3],
        updated_at: isoDaysAgo(now, daysAgo),
      });
      addLedger(member, "rights", `rights-${lessonId}`, daysAgo);
    }
  }

  for (const key of WORKLOAD_PERSONA_KEYS) {
    const member = roster.get(key);
    if (!member) continue;
    for (let week = 0; week < SAMPLE_HISTORY_WEEKS; week += 1) {
      const daysAgo = week * 7 + 2;
      const logId = stableUuid("workload", member.userId, String(week));
      workloadRows.push({
        id: logId,
        user_id: member.userId,
        priority: 8 + (week % 12),
        pending: 4 + (week % 7),
        unread_docs: week % 5,
        todos: 3 + (week % 4),
        referrals: week % 3,
        ce_activities: week % 2,
        assistance_requests: week % 4,
        aged_cases: week % 3,
        weekly_assigned: 12 + (week % 6),
        employment: "full_time",
        on_plan: week % 5 === 0,
        ot_worked: week % 3 === 0,
        ot_hours: week % 3 === 0 ? 4 + (week % 4) : 0,
        receipt_code: hex8(member.key, String(week)),
        created_at: isoDaysAgo(now, daysAgo),
        logged_on: dateOnlyInDays(now, -daysAgo),
      });
      addLedger(member, "workload", `workload-${logId}`, daysAgo);
    }
  }

  for (const ballot of SAMPLE_BALLOTS) {
    const daysAgo = Math.max(1, -ballot.closesInDays + 3);
    for (const member of roster.values()) {
      if (!participates(member.key, ballot.id, ballot.turnoutPercent)) continue;
      addLedger(member, "vote", `vote-${ballot.id}`, daysAgo);
    }
  }
  for (const survey of SAMPLE_SURVEYS) {
    const daysAgo = Math.max(1, -survey.closesInDays + 2);
    for (const member of roster.values()) {
      if (!participates(member.key, survey.id, survey.turnoutPercent)) continue;
      addLedger(member, "survey", `survey-${survey.id}`, daysAgo);
    }
  }
  for (const event of ALL_SAMPLE_EVENTS) {
    const keys = event.rsvpKeys
      || [...roster.keys()].filter((key) => participates(key, event.id, event.rsvpPercent ?? 0));
    const rsvpAge = Math.max(1, rsvpDaysBeforeEvent(event.startsInDays));
    for (const key of keys) {
      const member = roster.get(key);
      if (!member) continue;
      addLedger(member, "rsvp", `rsvp-${event.id}`, rsvpAge);
      if (event.startsInDays < 0 && participates(key, `checkin:${event.id}`, event.checkInPercent ?? 80)) {
        addLedger(member, "checkin", `checkin-${event.id}`, Math.max(1, -event.startsInDays));
      }
    }
  }
  for (const item of ALL_SAMPLE_CASES) {
    const member = roster.get(item.memberKey);
    if (!member) continue;
    addLedger(member, "case", `case-${item.seedKey || caseReferenceForSeed(item, now)}`, item.openedDaysAgo);
  }
  for (const thread of ALL_SAMPLE_CONVERSATIONS) {
    const member = roster.get(thread.memberKey);
    if (!member) continue;
    const conversationId = seededConversationId(member.userId, thread);
    thread.messages.forEach((message, index) => {
      if (message.senderKind !== "member") return;
      const messageId = stableUuid("member_message", conversationId, String(index));
      addLedger(member, "message", `message-${messageId}`, message.daysAgo);
    });
  }

  const progressWrite = await writeChangedRowsChunked(client, "member_rights_progress", progressRows, [
    "completed_steps",
  ], "SAMPLE rights progress", { keyColumns: ["lesson_id", "user_id"] });
  const workloadWrite = await writeChangedRowsChunked(client, "member_workload_logs", workloadRows, [
    "user_id", "priority", "pending", "weekly_assigned", "employment", "ot_worked", "ot_hours", "receipt_code",
  ], "SAMPLE workload logs");
  // Point rows first so the action_log trigger's ON CONFLICT keeps historical occurred_at.
  const pointWrite = await writeChangedRowsChunked(client, "member_point_events", pointRows, [
    "action_kind", "points", "occurred_at",
  ], "SAMPLE point events", { keyColumns: ["user_id", "action_key"] });
  const actionWrite = await writeChangedRowsChunked(client, "member_action_log", actionRows, [
    "action_kind", "occurred_at",
  ], "SAMPLE action log", { keyColumns: ["user_id", "action_key"] });
  return {
    rightsProgress: progressRows.length,
    rightsProgressWritten: progressWrite.written,
    workloadLogs: workloadRows.length,
    workloadLogsWritten: workloadWrite.written,
    pointEvents: pointRows.length,
    pointEventsWritten: pointWrite.written,
    actionLog: actionRows.length,
    actionLogWritten: actionWrite.written,
  };
}

async function seedSpacesGuideAndKnowledge(client, roster, now, createClient, target, serviceRoleKey, password) {
  // chapter_spaces / threads / posts stamp chapter_id and authorship from
  // auth.uid() (private.stamp_product_identity). A bare service-role write
  // nulls chapter_id. Author them the same way chapter_tasks are authored:
  // signed in as a demo persona over the product RLS/grants.
  const publisher = roster.get("alex.rivera");
  const byEmail = new Map();
  const personaClient = async (member) => {
    const cached = byEmail.get(member.email);
    if (cached) return cached;
    if (!member.signIn) {
      throw new Error(`SAMPLE chapter communication cannot be authored by ${member.email} — that account has no demo password`);
    }
    const authored = createClient(target.origin, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await authored.auth.signInWithPassword({ email: member.email, password });
    if (error) {
      throw new Error(`Failed to sign in as ${member.email} to author SAMPLE chapter communication: ${error.message}`);
    }
    byEmail.set(member.email, authored);
    return authored;
  };

  let spacesInserted = 0;
  let spacesExisting = 0;
  let threadsInserted = 0;
  let threadsExisting = 0;
  let postsInserted = 0;
  let postsExisting = 0;
  const spaceIds = new Map();

  try {
    const publisherClient = await personaClient(publisher);
    const { data: existingSpaces, error: spaceReadError } = await publisherClient.from("chapter_spaces")
      .select("id,name")
      .eq("chapter_id", SAMPLE_CHAPTER_ID);
    failOn(spaceReadError, "Failed to read SAMPLE chapter spaces");
    for (const row of existingSpaces || []) spaceIds.set(row.name, row.id);

    for (const space of SAMPLE_SPACES) {
      let spaceId = spaceIds.get(space.name);
      if (!spaceId) {
        const { data, error } = await publisherClient.from("chapter_spaces")
          .insert({ name: space.name, description: space.description, visibility: space.visibility })
          .select("id")
          .single();
        failOn(error, `Failed to write SAMPLE space "${space.name}"`);
        spaceId = data.id;
        spaceIds.set(space.name, spaceId);
        spacesInserted += 1;
      } else {
        const { error } = await publisherClient.from("chapter_spaces")
          .update({ description: space.description, visibility: space.visibility })
          .eq("id", spaceId);
        failOn(error, `Failed to refresh SAMPLE space "${space.name}"`);
        spacesExisting += 1;
      }

      const { data: existingThreads, error: threadReadError } = await publisherClient.from("chapter_threads")
        .select("id,title")
        .eq("space_id", spaceId);
      failOn(threadReadError, `Failed to read SAMPLE threads in "${space.name}"`);
      const threadIds = new Map((existingThreads || []).map((row) => [row.title, row.id]));

      for (const thread of space.threads) {
        // Members cannot create threads unless a live reward entitlement is
        // on. Admin/staff can. Author every thread as the publisher so a
        // member voice can still post inside it.
        let threadId = threadIds.get(thread.title);
        if (!threadId) {
          const { data, error } = await publisherClient.from("chapter_threads")
            .insert({
              space_id: spaceId,
              title: thread.title,
              kind: thread.kind,
            })
            .select("id")
            .single();
          failOn(error, `Failed to write SAMPLE thread "${thread.title}"`);
          threadId = data.id;
          threadIds.set(thread.title, threadId);
          threadsInserted += 1;
        } else {
          threadsExisting += 1;
        }

        // chapter_thread_posts_create requires t.status = 'open'. Keep the
        // thread open while historical posts land, then apply the catalog
        // status last so a re-run can fill a resolved thread that was
        // created empty on a previous attempt.
        const { error: reopenError } = await publisherClient.from("chapter_threads")
          .update({ kind: thread.kind, status: "open", resolved_at: null })
          .eq("id", threadId);
        failOn(reopenError, `Failed to open SAMPLE thread "${thread.title}" for posting`);

        const { data: existingPosts, error: postReadError } = await publisherClient.from("chapter_thread_posts")
          .select("id,body")
          .eq("thread_id", threadId);
        failOn(postReadError, `Failed to read SAMPLE posts in "${thread.title}"`);
        const postBodies = new Set((existingPosts || []).map((row) => row.body));
        for (const post of thread.posts) {
          if (postBodies.has(post.body)) {
            postsExisting += 1;
            continue;
          }
          const poster = roster.get(post.authorKey);
          if (!poster?.signIn) {
            throw new Error(`SAMPLE post in "${thread.title}" must be authored by a signed-in persona, not ${post.authorKey}`);
          }
          const posterClient = await personaClient(poster);
          const { error } = await posterClient.from("chapter_thread_posts")
            .insert({ thread_id: threadId, body: post.body });
          failOn(error, `Failed to write SAMPLE post in "${thread.title}"`);
          postBodies.add(post.body);
          postsInserted += 1;
        }

        const { error: statusError } = await publisherClient.from("chapter_threads")
          .update({
            kind: thread.kind,
            status: thread.status,
            resolved_at: thread.status === "resolved" ? isoDaysAgo(now, thread.posts.at(-1).daysAgo) : null,
          })
          .eq("id", threadId);
        failOn(statusError, `Failed to set SAMPLE thread status "${thread.title}"`);
      }
    }
  } finally {
    await Promise.all([...byEmail.values()].map((authored) => authored.auth.signOut().catch(() => {})));
  }

  const author = publisher;
  const guideThreadRows = [];
  const guideMessageRows = [];
  for (const thread of SAMPLE_GUIDE_THREADS) {
    const member = roster.get(thread.memberKey);
    const threadId = stableUuid("guide_thread", member.userId, thread.title);
    guideThreadRows.push({
      id: threadId,
      user_id: member.userId,
      title: thread.title,
      created_at: isoDaysAgo(now, thread.openedDaysAgo),
      updated_at: isoDaysAgo(now, thread.messages.at(-1).daysAgo),
    });
    thread.messages.forEach((message, index) => {
      guideMessageRows.push({
        id: stableUuid("guide_message", threadId, String(index)),
        thread_id: threadId,
        user_id: member.userId,
        role: message.role,
        body: message.body,
        created_at: isoDaysAgo(now, message.daysAgo),
      });
    });
  }
  const guideThreadWrite = await writeChangedRows(client, "member_guide_threads", guideThreadRows, [
    "user_id", "title",
  ], "SAMPLE Compass threads");
  const guideMessageWrite = await writeChangedRows(client, "member_guide_messages", guideMessageRows, [
    "thread_id", "user_id", "role", "body",
  ], "SAMPLE Compass messages");

  const kbRows = SAMPLE_KB_ARTICLES.map((article) => ({
    id: stableUuid("kb_article", SAMPLE_CHAPTER_ID, article.slug),
    slug: article.slug,
    chapter_id: SAMPLE_CHAPTER_ID,
    kind: article.kind,
    title: article.title,
    article_ref: article.articleRef,
    body: article.body,
    keywords: article.keywords,
    order_index: article.orderIndex,
    status: "published",
    is_sample: false,
    version: 1,
    created_by: author.userId,
    updated_by: author.userId,
    verified_by: author.userId,
    verified_at: isoDaysAgo(now, 200),
  }));
  const kbWrite = await writeChangedRows(client, "member_kb_articles", kbRows, [
    "slug", "chapter_id", "kind", "title", "article_ref", "body", "status", "is_sample", "version",
    "created_by", "updated_by", "verified_by",
  ], "SAMPLE Compass articles");

  return {
    spacesInserted,
    spacesExisting,
    threadsInserted,
    threadsExisting,
    postsInserted,
    postsExisting,
    guideThreads: guideThreadRows.length,
    guideThreadsWritten: guideThreadWrite.written,
    guideMessages: guideMessageRows.length,
    guideMessagesWritten: guideMessageWrite.written,
    kbArticles: kbRows.length,
    kbArticlesWritten: kbWrite.written,
  };
}


async function ensurePartnerChapterUsers(client) {
  const cache = {};
  const byKey = new Map();
  for (const member of SAMPLE_PARTNER_CHAPTER_MEMBERS) {
    const metadata = {
      sample: true,
      first_name: member.firstName,
      full_name: member.fullName,
      initials: member.initials,
      chapter_id: member.chapterId,
    };
    const { data, error } = await client.auth.admin.createUser({
      email: member.email,
      email_confirm: true,
      user_metadata: metadata,
      app_metadata: { sample: true, surface: "sample" },
    });
    let userId = data?.user?.id;
    if (error || !userId) {
      let existingId;
      try {
        existingId = await findExistingUserId(client, member.email, cache);
      } catch (lookupError) {
        throw new Error(
          `Failed to create SAMPLE partner-chapter member ${member.email}: ${error?.message || lookupError.message}`,
          { cause: lookupError },
        );
      }
      userId = existingId;
      if (!userId) {
        throw new Error(`Failed to create SAMPLE partner-chapter member ${member.email}: ${error?.message || "user missing"}`);
      }
      const { error: updateError } = await client.auth.admin.updateUserById(userId, {
        email_confirm: true,
        user_metadata: metadata,
        app_metadata: { sample: true, surface: "sample" },
      });
      failOn(updateError, `Failed to refresh SAMPLE partner-chapter member ${member.email}`);
    }
    byKey.set(member.key, { ...member, userId });
  }
  return byKey;
}

async function seedPartnerProfiles(client, partners) {
  const profiles = [...partners.values()].map((member) => ({
    id: member.userId,
    first_name: member.firstName,
    full_name: member.fullName,
    initials: member.initials,
    role_line: member.roleLine,
    member_since: member.memberSince,
    chapter_id: member.chapterId,
  }));
  const profileWrite = await writeChangedRows(client, "member_profiles", profiles, [
    "first_name", "full_name", "initials", "role_line", "member_since", "chapter_id",
  ], "SAMPLE partner-chapter profiles");
  return {
    partnerProfiles: profiles.length,
    partnerProfilesWritten: profileWrite.written,
    partnerProfilesUnchanged: profileWrite.unchanged,
  };
}

async function seedPartnerNetwork(client, roster, now, createClient, target, serviceRoleKey, password) {
  const orgRows = SAMPLE_PARTNER_ORGS.map((org) => ({
    id: org.id,
    olms_file_number: org.olmsFileNumber,
    name: org.name,
    affiliation: org.affiliation,
    designation: org.designation,
    local_number: org.localNumber,
    level: org.level,
    parent_olms_file_number: org.parentOlmsFileNumber,
    parent_affiliation: org.parentAffiliation,
    parent_name: org.parentName,
    sector_public_private: "public",
    sector_tags: ["public"],
    city: org.city,
    state: org.state,
    zip: org.zip,
    members_latest: org.membersLatest,
    members_latest_year: org.membersLatestYear,
    membership_history: [],
    sources: [],
    enrichment_status: "enriched",
    atlas_manifest_sha: SAMPLE_PARTNER_ATLAS_SHA,
  }));
  const orgWrite = await writeChangedRows(client, "union_orgs", orgRows, [
    "olms_file_number", "name", "affiliation", "designation", "local_number", "level",
    "parent_olms_file_number", "parent_affiliation", "parent_name",
    "sector_public_private", "city", "state", "zip",
    "members_latest", "members_latest_year", "enrichment_status", "atlas_manifest_sha",
  ], "SAMPLE partner organizations");

  const publisher = roster.get("alex.rivera");
  const authored = createClient(target.origin, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await authored.auth.signInWithPassword({
    email: publisher.email,
    password,
  });
  if (signInError) {
    throw new Error(`Failed to sign in as ${publisher.email} to author SAMPLE partner network: ${signInError.message}`);
  }

  let documentsInserted = 0;
  let documentsExisting = 0;
  let recordsInserted = 0;
  let recordsExisting = 0;
  let handshakesInserted = 0;
  let handshakesExisting = 0;
  try {
    const { data: existingDocs, error: docReadError } = await authored.from("chapter_documents")
      .select("id,title")
      .eq("chapter_id", SAMPLE_CHAPTER_ID);
    failOn(docReadError, "Failed to read SAMPLE chapter documents");
    const docsByTitle = new Map((existingDocs || []).map((row) => [row.title, row.id]));
    for (const doc of SAMPLE_CHAPTER_DOCUMENTS) {
      const payload = {
        title: doc.title,
        document_type: doc.documentType,
        summary: doc.summary,
        body: doc.body,
        visibility: doc.visibility,
        status: doc.status,
        published_at: isoDaysAgo(now, doc.publishedDaysAgo),
      };
      const existingId = docsByTitle.get(doc.title);
      if (existingId) {
        // Direct UPDATE was revoked; published rows go through
        // update_chapter_document_content. Existing seed copy stays as written.
        documentsExisting += 1;
      } else {
        const { error } = await authored.from("chapter_documents").insert(payload);
        failOn(error, `Failed to write SAMPLE document "${doc.title}"`);
        documentsInserted += 1;
      }
    }

    const { data: existingRecords, error: recordReadError } = await authored.from("chapter_records")
      .select("id,title")
      .eq("chapter_id", SAMPLE_CHAPTER_ID);
    failOn(recordReadError, "Failed to read SAMPLE chapter records");
    const recordsByTitle = new Map((existingRecords || []).map((row) => [row.title, row.id]));
    for (const record of SAMPLE_CHAPTER_RECORDS) {
      const payload = {
        record_type: record.recordType,
        title: record.title,
        body: record.body,
        occurred_at: isoDaysAgo(now, record.occurredDaysAgo),
      };
      const existingId = recordsByTitle.get(record.title);
      if (existingId) {
        const { error } = await authored.from("chapter_records").update(payload).eq("id", existingId);
        failOn(error, `Failed to refresh SAMPLE record "${record.title}"`);
        recordsExisting += 1;
      } else {
        const { error } = await authored.from("chapter_records").insert(payload);
        failOn(error, `Failed to write SAMPLE record "${record.title}"`);
        recordsInserted += 1;
      }
    }

    const { data: existingHandshakes, error: handshakeReadError } = await authored.from("chapter_handshakes")
      .select("id,title")
      .eq("chapter_id", SAMPLE_CHAPTER_ID);
    failOn(handshakeReadError, "Failed to read SAMPLE chapter handshakes");
    const handshakesByTitle = new Map((existingHandshakes || []).map((row) => [row.title, row.id]));
    for (const handshake of SAMPLE_HANDSHAKES) {
      const payload = {
        title: handshake.title,
        purpose: handshake.purpose,
        data_scope: handshake.dataScope,
        status: handshake.status,
        requested_at: handshake.requestedDaysAgo == null ? null : isoDaysAgo(now, handshake.requestedDaysAgo),
      };
      const existingId = handshakesByTitle.get(handshake.title);
      if (existingId) {
        const { error } = await authored.from("chapter_handshakes").update({
          ...payload,
          countersigned_by: handshake.countersignedDaysAgo == null ? null : publisher.userId,
          countersigned_at: handshake.countersignedDaysAgo == null ? null : isoDaysAgo(now, handshake.countersignedDaysAgo),
        }).eq("id", existingId);
        failOn(error, `Failed to refresh SAMPLE handshake "${handshake.title}"`);
        handshakesExisting += 1;
      } else {
        const { data, error } = await authored.from("chapter_handshakes").insert({
          partner_org_id: handshake.partnerOrgId,
          ...payload,
        }).select("id").single();
        failOn(error, `Failed to write SAMPLE handshake "${handshake.title}"`);
        if (handshake.countersignedDaysAgo != null) {
          const { error: signError } = await authored.from("chapter_handshakes").update({
            countersigned_by: publisher.userId,
            countersigned_at: isoDaysAgo(now, handshake.countersignedDaysAgo),
            status: handshake.status,
          }).eq("id", data.id);
          failOn(signError, `Failed to countersign SAMPLE handshake "${handshake.title}"`);
        }
        handshakesInserted += 1;
      }
    }
  } finally {
    await authored.auth.signOut().catch(() => {});
  }

  return {
    partnerOrgs: orgRows.length,
    partnerOrgsWritten: orgWrite.written,
    documentsInserted,
    documentsExisting,
    recordsInserted,
    recordsExisting,
    handshakesInserted,
    handshakesExisting,
  };
}

export function assertLegacySampleSeedRetired() {
  throw new Error("Legacy agency SAMPLE seed retired");
}

export async function applySampleSeed(url, serviceRoleKey) {
  // This obsolete writer targets the retired wor chapter. Refuse before
  // loading a client or deleting/recreating any accounts or dependent rows.
  assertLegacySampleSeedRetired();
  const { createClient } = await import("@supabase/supabase-js");
  const target = assertSampleTarget(url);
  const password = String(contract.samplePersonaPassword || "").trim();
  if (!password) throw new Error("config/sample-backend.json is missing samplePersonaPassword");
  const client = createClient(target.origin, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date();

  // Retirement runs FIRST: the labeled rows must be gone before anything new
  // is written, so a run that fails halfway can never leave the demo showing
  // both rosters at once.
  const legacy = await retireLegacyLabeledAccounts(client);
  await relaxStaffMfaForDemo(client);
  const roster = await ensureRosterUsers(client, password);
  const partners = await ensurePartnerChapterUsers(client);
  // Runs before any seeded content is written, so the demo is never showing
  // the trigger's boilerplate and the real chapter at the same time.
  const reconciled = await reconcileGeneratedRows(
    client,
    roster,
    seededConversationIds(roster),
    [...partners.values()].map((member) => member.userId),
  );
  const rosterCounts = await seedProfilesAndRoles(client, roster);
  const partnerProfileCounts = await seedPartnerProfiles(client, partners);
  const caseCounts = await seedCases(client, roster, now);
  const conversationCounts = await seedConversations(client, roster, now);
  const eventCounts = await seedEvents(client, roster, now);
  const broadcastCounts = await seedBroadcastsAndRequests(client, roster, now);
  const notificationCounts = await seedNotifications(client, roster, now);
  const workstreamCounts = await ensureWorkstreams(client);
  const taskCounts = await seedTasks(createClient, target, serviceRoleKey, password, roster, now);
  const campaignCounts = await seedCampaigns(client, roster, now);
  const voteCounts = await seedVotesAndSurveyResponses(client, roster, now);
  const ledgerCounts = await seedRightsWorkloadAndLedgers(client, roster, now);
  const commsCounts = await seedSpacesGuideAndKnowledge(
    client,
    roster,
    now,
    createClient,
    target,
    serviceRoleKey,
    password,
  );
  const partnerNetworkCounts = await seedPartnerNetwork(
    client,
    roster,
    now,
    createClient,
    target,
    serviceRoleKey,
    password,
  );

  return {
    target,
    chapterId: SAMPLE_CHAPTER_ID,
    retiredLegacyLabeledAccounts: legacy,
    reconciledGeneratedRows: reconciled,
    personas: [...roster.values()].filter((member) => member.signIn)
      .map((member) => ({ hat: member.hat, email: member.email, userId: member.userId })),
    seeded: {
      ...rosterCounts,
      ...caseCounts,
      ...conversationCounts,
      ...eventCounts,
      ...broadcastCounts,
      ...notificationCounts,
      ...workstreamCounts,
      ...taskCounts,
      ...campaignCounts,
      ...voteCounts,
      ...ledgerCounts,
      ...commsCounts,
      ...partnerProfileCounts,
      ...partnerNetworkCounts,
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const apply = process.argv.includes("--apply");
  const url = envValue("SAMPLE_SUPABASE_URL") || envValue("VITE_SAMPLE_SUPABASE_URL");
  try {
    if (apply) assertLegacySampleSeedRetired();
    const plan = planSampleSeed({ url: url || undefined });
    assertUnlabeledSeed(plan);
    console.log(JSON.stringify(plan, null, 2));
    if (!apply) process.exit(0);
    if (envValue("SAMPLE_SEED_CONFIRM") !== CONFIRM) {
      throw new Error(`Refusing apply without SAMPLE_SEED_CONFIRM=${CONFIRM}`);
    }
    const serviceRoleKey = envValue("SAMPLE_SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceRoleKey) {
      throw new Error("Apply requires SAMPLE_SUPABASE_URL and SAMPLE_SUPABASE_SERVICE_ROLE_KEY");
    }
    const result = await applySampleSeed(url, serviceRoleKey);
    console.log(JSON.stringify({ applied: true, ...result }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
