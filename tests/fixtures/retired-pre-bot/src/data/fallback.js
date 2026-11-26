// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { NOTIFICATION_TOPIC_KEYS } from "../../../../../src/lib/memberApi.js";
import { FORM_TEMPLATES } from "../../../../../src/lib/formTemplates.js";
import { languageLoaded, t } from "../../../../../src/lib/i18n.js";
import { DEMO_TASK_TEMPLATES } from "../../../../../src/lib/taskTemplates.js";

// Derived, not restated. The literal that used to sit inline below had already
// drifted off the topic list (it predated 'forms'), which is the exact silent
// drop the comment above NOTIFICATION_TOPIC_KEYS warns about — a topic missing
// from the fixture is a topic the demo can never show a member turning off.
// Safe direction: memberApi's whole transitive closure is rightsLabels +
// formTemplates + i18n, all leaf modules, so this cannot cycle.
const FALLBACK_NOTIFICATION_PREFS = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, true]));

const DEMO_ORGANIZATION_ID = "50000000-0000-4000-8000-000000000001";
const DEMO_ORGANIZATION_LABEL_OVERRIDES = {
  "nav.myCases": "Issue support",
  "staff.chapterWork": "Campaign duty",
};

// Mirrors the record-2 rows of
// supabase/migrations/20261002017000_feature_switches_and_limits.sql at their
// defaults (never overridden), so the SAMPLE Feature switches & limits page
// groups casework and analytics thresholds the way the live page does.
// One deliberate difference: the demo's management-behavior categories name
// an organizing-campaign behavior ("Interrogation about organizing") where the
// shared seed still carries an existing-union doctrine; the database wave
// replaces that seed value.
function demoThresholdSetting(key, kind, category, label, description, defaultValue, minimum, maximum) {
  return {
    key, kind, category, memberVisible: true, label, description,
    value: Array.isArray(defaultValue) ? [...defaultValue] : defaultValue, defaultValue,
    minimum, maximum, allowedValues: null, overridden: false, updatedAt: null, lastChange: null,
  };
}
const DEMO_THRESHOLD_SETTINGS = [
  demoThresholdSetting("limits.casework.deadline_red_days", "integer", "casework", "Deadline red threshold (days)", "Deadlines due within this many days show red. Overdue deadlines are always red.", 5, 0, 90),
  demoThresholdSetting("limits.casework.deadline_amber_days", "integer", "casework", "Deadline amber threshold (days)", "Deadlines due within this many days show amber. Later deadlines show as scheduled.", 14, 0, 180),
  demoThresholdSetting("limits.casework.deadline_risk_critical_days", "integer", "casework", "Deadline risk: critical (days)", "Deadlines due within this many days rank as critical in the coordinator queue. Overdue is always critical.", 0, 0, 30),
  demoThresholdSetting("limits.casework.deadline_risk_high_days", "integer", "casework", "Deadline risk: high (days)", "Deadlines due within this many days rank as high risk in the coordinator queue.", 7, 0, 90),
  demoThresholdSetting("limits.casework.deadline_risk_medium_days", "integer", "casework", "Deadline risk: medium (days)", "Deadlines due within this many days rank as medium risk when the lookahead reaches them.", 14, 0, 180),
  demoThresholdSetting("limits.casework.deadline_lookahead_days", "integer", "casework", "Deadline lookahead (days)", "How many days ahead the due-soon dashboard and coordinator ranking look for deadlines.", 7, 1, 30),
  demoThresholdSetting("lists.casework.management_behavior_categories", "text_list", "casework", "Management behavior categories", "Categories staff can choose when logging a management behavior. Existing entries keep their category.", ["Verbal threat", "Intimidation", "Policy change (unilateral)", "Interrogation about organizing", "Retaliation", "Discrimination", "Other"], 1, 50),
  demoThresholdSetting("limits.casework.management_behavior_window_days", "integer", "casework", "Management behavior window (days)", "Days of management behavior history counted when summarizing a manager across cases.", 90, 7, 730),
  demoThresholdSetting("limits.analytics.health_critical_max", "integer", "analytics", "Health score: critical up to", "Scores at or below this value are critical.", 24, 0, 100),
  demoThresholdSetting("limits.analytics.health_concerning_max", "integer", "analytics", "Health score: concerning up to", "Scores above critical and at or below this value are concerning.", 44, 0, 100),
  demoThresholdSetting("limits.analytics.health_moderate_max", "integer", "analytics", "Health score: moderate up to", "Scores above concerning and at or below this value are moderate.", 64, 0, 100),
  demoThresholdSetting("limits.analytics.health_healthy_max", "integer", "analytics", "Health score: healthy up to", "Scores above moderate and at or below this value are healthy; higher scores are excellent.", 84, 0, 100),
];

const DEMO_DATE_ANCHOR = new Date();
function relativeDemoTimestamp(dayOffset, utcHour, utcMinute = 0) {
  const value = new Date(DEMO_DATE_ANCHOR);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  value.setUTCHours(utcHour, utcMinute, 0, 0);
  return value.toISOString();
}

function relativeDemoDate(dayOffset) {
  return relativeDemoTimestamp(dayOffset, 12).slice(0, 10);
}

function recentDemoTimestamp(hoursAgo) {
  return new Date(DEMO_DATE_ANCHOR.getTime() - (hoursAgo * 60 * 60 * 1000)).toISOString();
}

const DEMO_EVENT_TIME_ZONE = "America/New_York";
function demoEventDateLabel(startsAt) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: DEMO_EVENT_TIME_ZONE,
  }).format(new Date(startsAt));
}

function demoEventTimeLabel(startsAt) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: DEMO_EVENT_TIME_ZONE,
  }).format(new Date(startsAt));
}

// One canonical upcoming-meeting list feeds the worker calendar, Committee
// check-in choices, and the staff meetings desk. Relative dates keep PREVIEW
// credible whenever the tour is built without letting those surfaces drift.
// Every meeting stays private to the campaign: Union Ground has no public
// events, so isPublic and isPublicAcrossAgencies are false throughout.
const DEMO_UPCOMING_EVENTS = [
  { id: "evt-2026-chapter-meeting", title: "Committee huddle", startsAt: relativeDemoTimestamp(9, 18), location: "Off-site library room + Zoom", summary: "Card-count review and evening-shift outreach plan.", checkInCode: "SG-MEET7", orderIndex: 1, chapterId: "wor", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpCount: 42, checkinCount: 0 },
  { id: "evt-2026-steward-training", title: "New-committee training", startsAt: relativeDemoTimestamp(14, 22), location: "Juniper hall · 30 Example Way", summary: "Module 3 — Section 7 rights and first conversations.", checkInCode: "SG-TRAIN3", orderIndex: 2, chapterId: "wor", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpCount: 18, checkinCount: 0 },
  { id: "evt-2026-relief-rally", title: "Caseload-relief rally", startsAt: relativeDemoTimestamp(21, 16), location: "State House steps", summary: "Bring your local T-shirt — noon start.", checkInCode: "SG-RALLY26", orderIndex: 3, chapterId: "wor", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpCount: 64, checkinCount: 0 },
].map((event) => ({
  ...event,
  dateLabel: demoEventDateLabel(event.startsAt),
  timeLabel: demoEventTimeLabel(event.startsAt),
  startsLabel: `${demoEventDateLabel(event.startsAt)} · ${demoEventTimeLabel(event.startsAt)}`,
}));

// Demo twin of the registry rows, mechanically derived from the same static
// fallback schemas the member form renderer uses. The admin editor needs the
// raw bilingual DB shape, not a language-resolved member template.
// Spanish stays lazy: this module may arrive before its catalogue. The demo
// loader and admin desk preserve these accessors until the catalogue arrives.
function spanishTemplateLabel(key) {
  return languageLoaded("es") ? t("es", key) : "";
}
const ADMIN_FORM_TEMPLATE_ROWS = FORM_TEMPLATES.map((template, index) => ({
  key: template.key,
  version: 1,
  label_en: t("en", template.titleKey),
  get label_es() { return spanishTemplateLabel(template.titleKey); },
  blurb_en: t("en", template.blurbKey),
  get blurb_es() { return spanishTemplateLabel(template.blurbKey); },
  icon: template.icon,
  // No points economy: the safe-recognition model pins every template at 0.
  points: 0,
  active: true,
  sort: index + 1,
  created_at: "2026-07-23T11:00:00Z",
  updated_at: "2026-07-23T11:00:00Z",
  field_schema: {
    steps: template.steps.map((step) => ({
      title: { en: t("en", step.titleKey), get es() { return spanishTemplateLabel(step.titleKey); } },
      fields: step.fields.map((field) => ({
        key: field.key,
        type: field.type,
        label: { en: t("en", field.labelKey), get es() { return spanishTemplateLabel(field.labelKey); } },
        required: field.required,
        ...(field.maxLength == null ? {} : { maxLength: field.maxLength }),
        ...(field.options ? {
          options: field.options.map((option) => ({
            value: option.value,
            label: { en: t("en", option.labelKey), get es() { return spanishTemplateLabel(option.labelKey); } },
          })),
        } : {}),
      })),
    })),
  },
}));

// All five organizing-rights lessons. Each advertised tab resolves to its OWN
// record: RightsView resolves a tab with `find(label === lesson) ||
// lessonRecords[0]` and renders the eyebrow from the CLICKED label, so a label
// without a record would show the first lesson's title, checklist and script
// under another topic's name. `lessons` below is derived from this array so
// the two stay parallel, the way the live loader maps both from one row set.
//
// The copy is Union Ground's own organizing guidance (it mirrors the
// knowledge-base excerpts below and the native preview's lessons). It states
// what a worker can do and write down; it never states a legal conclusion.
// No grievance-era doctrine appears here: there is no contract yet.
const RIGHTS_LESSON_RECORDS = [
  { id: "section-7", label: "Section 7", title: "You can talk about forming a union", description: "Use this if a supervisor asks who is organizing, what was said at a meeting, or whether you signed a card.", steps: ["You and your coworkers may talk about pay, safety, and forming a union on non-work time.", "A supervisor cannot legally spy, threaten, promise favors, or interrogate you about organizing.", "You do not have to answer who is involved, who signed, or what was said at a meeting.", "Write down what was asked, who was present, and the time. Tell a committee member or organizer."], script: "I am not going to discuss organizing activity. If this conversation could affect my job, I want a coworker present and I will get back to you.", completedSteps: [] },
  { id: "supervisor-questions", label: "Supervisor questions", title: "If a supervisor asks about organizing", description: "Use this when a supervisor asks who is involved, what was said at a meeting, or whether you signed a card.", steps: ["You do not have to say who signed a card or what was said at a meeting.", "Keep your answer short and calm.", "Write down what was asked, who was present, and the time.", "Tell a committee member or organizer the same day."], script: "I would rather not talk about that right now. I need to get back to work.", completedSteps: [] },
  { id: "cards-majority", label: "Cards & majority", title: "What signing a card means", description: "Use this when a coworker asks what an authorization card does before they sign.", steps: ["A signed card shows that you support forming a union.", "A card majority is not certification.", "Recognition comes either voluntarily from the employer or through an election, and those are separate paths.", "Who has signed stays private to the committee."], script: "Signing shows you support forming a union. It is not a vote and it is not certification. I do not share who has signed.", completedSteps: [] },
  { id: "captive-meeting", label: "Captive meeting", title: "You do not have to agree in a captive meeting", description: "Use this when the employer calls a meeting about the union.", steps: ["Your employer may call a meeting about the union.", "You do not have to speak, sign anything, or name coworkers.", "Write down what was said, who spoke, and the time.", "Tell a committee member after the meeting."], script: "I am here because I was asked to attend. I do not have anything to add.", completedSteps: [] },
  { id: "retaliation", label: "Retaliation", title: "Record a change after organizing activity", description: "Use this if your schedule, duties, or treatment changed after you talked about the campaign.", steps: ["Write down what changed, when, and who told you.", "Note the organizing activity that came before it, and when.", "Keep schedules, messages, and notices at home, not on a work device.", "Bring your notes to an organizer. They are facts, not a conclusion about the law."], script: "I would like the reason for this change in writing, please.", completedSteps: [] },
];

export const fallbackData = {
  member: {
    id: "11111111-1111-4111-8111-111111111111",
    firstName: "Darnell",
    fullName: "Darnell Foster",
    initials: "DF",
    roleLine: "Worker · Harborview Care committee",
    sinceYear: 2023,
    chapterId: "wor",
    chapterName: "Harborview Care United",
    language: "en",
    notificationPrefs: FALLBACK_NOTIFICATION_PREFS,
    notificationCount: 3,
  },
  roles: [],
  actionKeys: [],
  organizingWork: [
    { id: "task-psg-104", reference: "PSG-104", title: "Confirm Thursday meeting room", status: "to_do", type: "Meeting", assignee: "You", due: "Today", checklist: { done: 1, total: 3 }, blocked: false },
    { id: "task-psg-117", reference: "PSG-117", title: "Review evening-shift issue map", status: "in_progress", type: "Issue map", assignee: "You", due: "Wednesday", checklist: { done: 2, total: 4 }, blocked: false },
    { id: "task-psg-123", reference: "PSG-123", title: "Prepare recognition-path questions", status: "review", type: "Research", assignee: "Committee", due: "Friday", checklist: { done: 3, total: 3 }, blocked: false },
    { id: "task-psg-098", reference: "PSG-098", title: "Schedule a second organizing-rights conversation", status: "to_do", type: "Conversation", assignee: "You", due: "Next week", checklist: { done: 0, total: 2 }, blocked: true },
  ],
  notifications: [
    { id: "n1", title: "Authorization card majority check", body: "The committee needs one more evening-shift conversation before the next card count.", fixture_copy_key: "ballotBudget", read_at: null, created_at: "2026-07-21T13:00:00Z" },
    { id: "n2", title: "Issue follow-up", body: "The overnight staffing issue needs a written note before Thursday's meeting.", fixture_copy_key: "deadline", read_at: null, created_at: "2026-07-21T10:00:00Z" },
    { id: "n3", title: "Committee huddle", body: "The next organizing huddle is on the calendar.", fixture_copy_key: "chapterLatest", read_at: null, created_at: "2026-07-20T14:00:00Z" },
  ],
  events: [
    ...DEMO_UPCOMING_EVENTS.map((event) => ({ ...event, checkInOffered: Boolean(event.checkInCode), rsvpStatus: null, checkedIn: false, isPast: false })),
    { id: "evt-history-demo", title: "July open meeting", startsAt: "2026-07-30T18:00:00Z", dateLabel: "Thu, Jul 30", timeLabel: "2:00 PM", location: "Off-site library room + Zoom", summary: "Coworkers ranked campaign priorities and heard the delegation plan for overnight staffing.", chapterId: "wor", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpStatus: "going", checkedIn: true, isPast: true },
  ],
  // Steward appointments (member surface): one live booking plus a settled
  // record, in get_my_appointments' output shape + the loader's labels. The
  // canon cast rule holds: Sam Okafor is the Member & Steward.
  appointments: [
    { id: "appt-demo-1", place: "Boston office · Room 204", stewardId: "staff-so", stewardName: "Sam Okafor", type: "contract_questions", durationMinutes: 30, startsAt: "2026-08-12T14:00:00Z", endsAt: "2026-08-12T14:30:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "steward", dateLabel: "Wed, Aug 12", timeLabel: "10:00 AM", endTimeLabel: "10:30 AM" },
    { id: "appt-demo-2", place: "https://meet.example.org/onboarding", stewardId: "staff-pc", stewardName: "Priya Chandran", type: "onboarding", durationMinutes: 20, startsAt: "2026-07-14T15:00:00Z", endsAt: "2026-07-14T15:20:00Z", status: "completed", reasonCategory: "general", routedVia: "chapter", dateLabel: "Tue, Jul 14", timeLabel: "11:00 AM", endTimeLabel: "11:20 AM" },
  ],
  // Who the demo's booking wizard offers (get_bookable_stewards shape).
  apptStewards: [
    { id: "staff-so", name: "Sam Okafor" },
    { id: "staff-pc", name: "Priya Chandran" },
  ],
  // Find my steward (get_member_chapter_stewards shape). Two stewards in one
  // chapter on purpose: the demo is the only place the two-steward Contact
  // routing is visible by eye. Sam takes appointments and has published no
  // direct channel, so only the in-app conversation is offered; Priya takes
  // none and has opted an address in. Labels are the demo cast and the demo
  // chapter — no union or agency name is seeded here.
  chapterStewards: [
    {
      id: "staff-so", name: "Sam Okafor", roleLabel: "steward",
      chapterId: "wor", chapterLabel: "Harborview Care United", acceptsAppointments: true,
      contact: { conversation: true, email: null, phone: null },
    },
    {
      id: "staff-pc", name: "Priya Chandran", roleLabel: "steward",
      chapterId: "wor", chapterLabel: "Harborview Care United", acceptsAppointments: false,
      contact: { conversation: true, email: "priya.chandran@example.org", phone: null },
    },
  ],
  // Org structure (get_member_organization_structure shape). Node labels are
  // deliberately generic office/role words: the blank-system rule forbids a
  // default union or agency name, and this fixture ships in the demo.
  memberOrgStructure: {
    organizationId: "demo-org",
    chapterId: "wor",
    generatedAt: "2026-09-22T00:00:00.000Z",
    charts: [
      {
        chartKind: "agency",
        nodes: [
          { id: "ag-1", parentId: null, chapterId: null, nodeKind: "organization", label: "Department central office", subtitle: "Statewide", positionX: 0, positionY: 0, sortOrder: 1 },
          { id: "ag-2", parentId: "ag-1", chapterId: null, nodeKind: "division", label: "Regional operations", subtitle: "Service delivery", positionX: 0, positionY: 1, sortOrder: 2 },
          { id: "ag-3", parentId: "ag-2", chapterId: "wor", nodeKind: "team", label: "Area service team", subtitle: "Day programs and supports", positionX: 0, positionY: 2, sortOrder: 3 },
        ],
        edges: [],
      },
      {
        chartKind: "union",
        nodes: [
          { id: "un-1", parentId: null, chapterId: null, nodeKind: "organization", label: "Statewide council", subtitle: "Elected leadership", positionX: 0, positionY: 0, sortOrder: 1 },
          { id: "un-2", parentId: "un-1", chapterId: "wor", nodeKind: "chapter", label: "Harborview Care United", subtitle: "Chapter", positionX: 0, positionY: 1, sortOrder: 2 },
          { id: "un-3", parentId: "un-2", chapterId: "wor", nodeKind: "person", label: "Sam Okafor", subtitle: "Steward", positionX: 0, positionY: 2, sortOrder: 3 },
          { id: "un-4", parentId: "un-2", chapterId: "wor", nodeKind: "person", label: "Priya Chandran", subtitle: "Steward", positionX: 1, positionY: 2, sortOrder: 4 },
        ],
        edges: [
          { id: "rel-1", sourceId: "un-3", targetId: "un-2", kind: "reports_to" },
          { id: "rel-2", sourceId: "un-4", targetId: "un-2", kind: "reports_to" },
        ],
      },
    ],
  },
  taskAssignees: [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "Darnell Foster", initials: "DF" },
    { id: "22222222-2222-4222-8222-222222222222", fullName: "Maria Santos", initials: "MS" },
    { id: "33333333-3333-4333-8333-333333333333", fullName: "Priya Shah", initials: "PS" },
    { id: "44444444-4444-4444-8444-444444444444", fullName: "Jordan Lee", initials: "JL" },
  ],
  // Privacy-safe twin of list_chapter_task_template_reviewers(). This is
  // deliberately separate from the full chapter-member assignment roster.
  taskTemplateReviewers: [
    { id: "staff-so", fullName: "Sam Okafor" },
    { id: "staff-jp", fullName: "Jordan Patel" },
    { id: "staff-an", fullName: "Avery Nguyen" },
    { id: "staff-ar", fullName: "Alex Rivera" },
    { id: "staff-tm", fullName: "Taylor Morgan" },
  ],
  intakeOwners: [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "Darnell Foster", initials: "DF" },
    { id: "33333333-3333-4333-8333-333333333333", fullName: "Priya Shah", initials: "PS" },
    { id: "44444444-4444-4444-8444-444444444444", fullName: "Jordan Lee", initials: "JL" },
  ],
  // taskNumber is the demo twin of the server-assigned per-chapter number
  // (migration 20260801170000): the board renders it as the card key WOR-1…
  // WOR-8 and deep-links by it, so the tour needs stable numbers rather than
  // blank keys. They match the demo ids on purpose — a reader checking
  // ?task=wor-3 against this fixture should not have to count rows.
  //
  // Two board anatomies also need a demo card to live on, or the tour shows a
  // feature nobody can see: task-demo-1 is the milestone at a PARTIAL 40% (a
  // milestone stuck at 0 or 100 renders an empty or full bar and proves
  // nothing — progress is a typed number here, independent of status, and only
  // `done` forces it), and task-demo-3 carries a two-item checklist with one
  // box ticked so the card badge reads 1/2 and the modal has something to
  // toggle.
  tasks: [
    { id: "task-demo-1", chapterId: "wor", taskNumber: 1, title: "Prepare August campaign meeting", description: "Confirm room, agenda, Zoom host, and member notices.", status: "backlog", priority: "high", workstream: "Chapter", assigneeId: "11111111-1111-4111-8111-111111111111", assigneeName: "Darnell Foster", startDate: "2026-07-27", dueDate: "2026-08-31", progress: 40, blocked: false, milestone: true, orderIndex: 10, createdBy: "22222222-2222-4222-8222-222222222222", createdAt: "2026-07-24T13:00:00Z", updatedAt: "2026-08-20T13:00:00Z" },
    { id: "task-demo-2", chapterId: "wor", taskNumber: 2, title: "Translate bargaining pulse", description: "Complete Spanish copy review before publishing.", status: "to_do", priority: "medium", taskType: "document_request", workstream: "Communications", assigneeId: "22222222-2222-4222-8222-222222222222", assigneeName: "Maria Santos", startDate: null, dueDate: null, progress: 0, blocked: false, milestone: false, orderIndex: 20, createdBy: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-24T14:00:00Z", updatedAt: "2026-07-24T14:00:00Z" },
    { id: "task-demo-3", chapterId: "wor", taskNumber: 3, title: "Coworker outreach calls", description: "Reach the coworkers who have not completed the issue survey.\n- [x] Pull the list of coworkers who have not answered\n- [ ] Call the second shift before Thursday", status: "in_progress", priority: "high", workstream: "Organizing", assigneeId: "33333333-3333-4333-8333-333333333333", assigneeName: "Priya Shah", startDate: "2026-08-17", dueDate: "2026-08-28", progress: 45, blocked: false, milestone: false, orderIndex: 10, createdBy: "11111111-1111-4111-8111-111111111111", updatedBy: "33333333-3333-4333-8333-333333333333", createdAt: "2026-07-22T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z" },
    { id: "task-demo-4", chapterId: "wor", taskNumber: 4, title: "Clear issue intake backlog", description: "Triage the remaining intake notes and assign next actions.", status: "in_progress", priority: "high", workstream: "Issues", assigneeId: "44444444-4444-4444-8444-444444444444", assigneeName: "Jordan Lee", startDate: "2026-07-21", dueDate: "2026-07-25", progress: 65, blocked: true, milestone: false, orderIndex: 20, createdBy: "33333333-3333-4333-8333-333333333333", createdAt: "2026-07-21T09:00:00Z", updatedAt: "2026-07-25T16:00:00Z" },
    { id: "task-demo-5", chapterId: "wor", taskNumber: 5, title: "Review chapter newsletter", description: "Final fact check and officer approval.", status: "needs_review", priority: "medium", workstream: "Communications", assigneeId: "11111111-1111-4111-8111-111111111111", assigneeName: "Darnell Foster", startDate: "2026-07-23", dueDate: "2026-07-27", progress: 90, blocked: false, milestone: true, orderIndex: 10, createdBy: "44444444-4444-4444-8444-444444444444", updatedBy: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-23T10:00:00Z", updatedAt: "2026-07-26T15:00:00Z" },
    { id: "task-demo-6", chapterId: "wor", taskNumber: 6, title: "Approve workplace safety checklist", description: "Confirm the checklist matches the posted safety policy.", status: "needs_review", priority: "low", workstream: "Safety", assigneeId: "22222222-2222-4222-8222-222222222222", assigneeName: "Maria Santos", startDate: "2026-07-24", dueDate: "2026-07-29", progress: 85, blocked: false, milestone: false, orderIndex: 20, createdBy: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-24T11:00:00Z", updatedAt: "2026-07-26T16:00:00Z" },
    // Completed fixture dates roll together from the module-load anchor. This
    // preserves their original four-day lifecycles and one-day ordering while
    // keeping both cards inside the production board's 60-day Done window.
    { id: "task-demo-7", chapterId: "wor", taskNumber: 7, title: "Publish bargaining priorities poll", description: "Poll published and member link distributed.", status: "done", priority: "high", workstream: "Bargaining", assigneeId: "33333333-3333-4333-8333-333333333333", assigneeName: "Priya Shah", startDate: relativeDemoDate(-18), dueDate: relativeDemoDate(-14), progress: 100, blocked: false, milestone: true, orderIndex: 10, createdBy: "11111111-1111-4111-8111-111111111111", updatedBy: "33333333-3333-4333-8333-333333333333", doneAt: relativeDemoTimestamp(-14, 18), createdAt: relativeDemoTimestamp(-18, 10), updatedAt: relativeDemoTimestamp(-14, 18) },
    { id: "task-demo-8", chapterId: "wor", taskNumber: 8, title: "Update committee contact roster", description: "Roster checked and current contact channels confirmed.", status: "done", priority: "low", workstream: "Chapter", assigneeId: "44444444-4444-4444-8444-444444444444", assigneeName: "Jordan Lee", startDate: relativeDemoDate(-19), dueDate: relativeDemoDate(-15), progress: 100, blocked: false, milestone: false, orderIndex: 20, createdBy: "22222222-2222-4222-8222-222222222222", doneAt: relativeDemoTimestamp(-15, 17), createdAt: relativeDemoTimestamp(-19, 11), updatedAt: relativeDemoTimestamp(-15, 17) },
  ],
  taskTemplates: DEMO_TASK_TEMPLATES,
  taskTemplateDetails: [
    {
      taskId: "task-demo-2", chapterId: "wor", templateKey: "document_request", flowStep: "requested",
      scheduledOn: null, startsAt: null, endsAt: null, venueMode: null,
      reviewKind: null, reviewerId: null, contactMethod: null, followUpOn: null,
      recordCategory: "correspondence", recordSource: "union", occurredOn: null, incidentSeverity: null,
      createdBy: "11111111-1111-4111-8111-111111111111", updatedBy: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-07-24T14:00:00Z", updatedAt: "2026-07-24T14:00:00Z",
    },
  ],
  taskMessages: [
    { id: "task-message-demo-1", taskId: "task-demo-2", chapterId: "wor", senderId: "11111111-1111-4111-8111-111111111111", recipientId: "22222222-2222-4222-8222-222222222222", body: "Spanish draft is ready for your review.", createdAt: "2026-07-26T18:10:00Z" },
    { id: "task-message-demo-2", taskId: "task-demo-2", chapterId: "wor", senderId: "22222222-2222-4222-8222-222222222222", recipientId: "11111111-1111-4111-8111-111111111111", body: "Got it. I will return edits this afternoon.", createdAt: "2026-07-26T18:24:00Z" },
  ],
  taskComments: [
    { id: "task-comment-demo-1", taskId: "task-demo-1", chapterId: "wor", authorId: "11111111-1111-4111-8111-111111111111", body: "Room confirmation is complete. Agenda review is next.", mentionedUserIds: [], createdAt: "2026-07-26T18:10:00Z" },
    { id: "task-comment-demo-2", taskId: "task-demo-1", chapterId: "wor", authorId: "22222222-2222-4222-8222-222222222222", body: "I will check the final notice before it is sent.", mentionedUserIds: ["11111111-1111-4111-8111-111111111111"], createdAt: "2026-07-26T18:24:00Z" },
  ],
  taskCommentsUnavailable: false,
  taskCommentsTruncated: false,
  taskAttachments: [
    { id: "task-attachment-demo-1", taskId: "task-demo-1", chapterId: "wor", label: "Authorized meeting record", recordUrl: "/m/events", createdBy: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-26T18:30:00Z", updatedAt: "2026-07-26T18:30:00Z" },
  ],
  taskActivity: [
    { id: 1, taskId: "task-demo-1", chapterId: "wor", actorId: "22222222-2222-4222-8222-222222222222", action: "created", fromValue: null, toValue: "backlog", createdAt: "2026-07-24T13:00:00Z" },
    { id: 2, taskId: "task-demo-1", chapterId: "wor", actorId: "11111111-1111-4111-8111-111111111111", action: "assignee_changed", fromValue: null, toValue: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-25T13:00:00Z" },
    { id: 3, taskId: "task-demo-1", chapterId: "wor", actorId: "11111111-1111-4111-8111-111111111111", action: "attachment_added", fromValue: null, toValue: "task-attachment-demo-1", createdAt: "2026-07-26T18:30:00Z" },
  ],
  // Directed depends-on edges (task depends on dependsOn). The meeting
  // milestone carries TWO so the modal's depends-on list shows a stack, the
  // newsletter and the outreach calls each BLOCK one so the reverse list has
  // a demo card too, and one edge points at a done task so the tinted
  // mini-card palette shows more than one status on the tour. That edge's
  // timestamp rolls with its done prerequisite (task-demo-7 completes at day
  // -14; the edge is recorded three mornings later) so the demo graph never
  // says the dependency predates the task it depends on.
  taskDependencies: [
    { id: "task-dep-demo-1", chapterId: "wor", taskId: "task-demo-2", dependsOnId: "task-demo-7", createdAt: relativeDemoTimestamp(-11, 9) },
    { id: "task-dep-demo-2", chapterId: "wor", taskId: "task-demo-1", dependsOnId: "task-demo-5", createdAt: "2026-07-25T09:05:00Z" },
    { id: "task-dep-demo-3", chapterId: "wor", taskId: "task-demo-1", dependsOnId: "task-demo-3", createdAt: "2026-07-25T09:10:00Z" },
  ],
  taskSubtasks: [
    { id: "task-subtask-demo-1", chapterId: "wor", parentTaskId: "task-demo-1", subtaskId: "task-demo-2", createdAt: "2026-07-25T10:00:00Z" },
    { id: "task-subtask-demo-2", chapterId: "wor", parentTaskId: "task-demo-1", subtaskId: "task-demo-3", createdAt: "2026-07-25T10:05:00Z" },
  ],
  taskWatches: [{ taskId: "task-demo-1" }],
  workload: {
    entries: [
      { id: "wl-demo-1", receipt: "a3f81c92", counts: { priority: 4, pending: 11, unread_docs: 7, todos: 5, referrals: 1, ce_activities: 0, assistance_requests: 0, aged_cases: 4 }, meta: "full-time · 3h OT", note: "", createdAt: "2026-07-06T09:00:00-04:00", dateLabel: "Jul 6" },
      { id: "wl-demo-2", receipt: "7c1d90ab", counts: { priority: 5, pending: 14, unread_docs: 9, todos: 6, referrals: 0, ce_activities: 0, assistance_requests: 0, aged_cases: 6 }, meta: "full-time · 6h OT", note: "covered a colleague's caseload", createdAt: "2026-06-29T09:00:00-04:00", dateLabel: "Jun 29" },
      { id: "wl-demo-3", receipt: "22bf5e10", counts: { priority: 3, pending: 12, unread_docs: 5, todos: 4, referrals: 0, ce_activities: 0, assistance_requests: 0, aged_cases: 5 }, meta: "full-time", note: "", createdAt: "2026-06-22T09:00:00-04:00", dateLabel: "Jun 22" },
    ],
    stats: {
      enoughData: true,
      period: "2026-Q2",
      generatedAt: "2026-07-01T09:00:00Z",
      submittersBand: "50-99",
      categories: [
        { key: "priority", avg: 10, median: 9, p90: 18 },
        { key: "pending", avg: 24, median: 22, p90: 41 },
        { key: "unread_docs", avg: 14, median: 12, p90: 26 },
        { key: "todos", avg: 9, median: 8, p90: 16 },
        { key: "referrals", avg: 2, median: 2, p90: 5 },
        { key: "ce_activities", avg: 3, median: 2, p90: 7 },
        { key: "assistance_requests", avg: 2, median: 1, p90: 5 },
        { key: "aged_cases", avg: 7, median: 6, p90: 14 },
      ],
      tiles: { pctFullTime: 80, pctPartTime: 20, avgOtHours: 3.2 },
    },
    reminders: {
      available: true, enabled: false, cadence: "weekly", weekday: 1,
      localHour: 9, timezone: "America/New_York", nextDueAt: null,
      lastSentAt: null, preview: true,
    },
  },
  forms: [
    { id: "form-demo-1", templateKey: "grievance", status: "draft", step: 1, reviewNote: "",
      answers: { summary: "Denied a shift swap without a written reason", incident_date: "2026-07-14" }, submittedAt: null, cosigners: [] },
    { id: "form-demo-2", templateKey: "alt_work", status: "approved", step: 3, reviewNote: "Approved for your records.",
      answers: { requested: "Telework Tue/Thu", reason: "medical appointments" }, answers_es: { requested: "Teletrabajo martes/jueves" }, submittedAt: "2026-07-06T16:12:00Z",
      filerSignedAt: "2026-07-06T16:10:00Z", filerSignatureDigest: "demo-signature-preview",
      demoSignature: { signedAt: "2026-07-06T16:10:00Z", signatureDigest: "demo-signature-preview", strokes: [[{ x: 125, y: 650 }, { x: 270, y: 420 }, { x: 410, y: 650 }, { x: 610, y: 360 }, { x: 820, y: 600 }]] },
      artifactApprovedAt: "2026-07-07T14:30:00Z", artifactDigest: "demo-preview-not-an-official-record", files: [], cosigners: [] },
    { id: "form-demo-3", templateKey: "alliance_grievance", status: "draft", step: 2, reviewNote: "",
      answers: { summary: "Unsafe staffing ratios on the overnight ward", incident_date: "2026-07-15", narrative: "Three overnights this month ran one aide short of the posted minimum.", affected: "Overnight ward aides", remedy: "Backfill the minimum ratio and post the schedule 7 days out." },
      submittedAt: null,
      cosigners: [
        { id: "cs-demo-1", email: "ava.ramos@example.org", status: "accepted", invitedAt: "2026-07-16T10:00:00Z", respondedAt: "2026-07-16T15:00:00Z" },
        { id: "cs-demo-2", email: "renata.cole@example.org", status: "invited", invitedAt: "2026-07-17T09:00:00Z", respondedAt: null },
      ] },
  ],
  // An incoming co-sign invitation for the demo worker: pre-accept they see only
  // the one-line summary + filer name, never the full issue write-up.
  cosignRequests: [
    { formId: "cosign-demo-1", status: "invited", filerName: "Jordan Mills", summary: "Mandatory overtime without the 48-hour notice", invitedAt: "2026-07-21T15:00:00Z" },
  ],
  weekly: { done: 3, goal: null, streakDays: 0 },
  recognition: { totalVerified: 8, recentVerified: 3, currentRung: "organize", retiredPointsHidden: true },
  recognitionCatalog: {
    rules: [
      { recognitionKind: "training_complete", label: "Completed training", description: "A facilitator verified completion of a chapter-approved training.", weeklyCap: 2 },
      { recognitionKind: "orientation_complete", label: "Completed orientation", description: "A facilitator verified completion of member or volunteer orientation.", weeklyCap: 1 },
      { recognitionKind: "peer_outreach_complete", label: "Completed peer outreach", description: "An assigned, consensual outreach commitment was completed and verified.", weeklyCap: 5 },
      { recognitionKind: "committee_commitment_complete", label: "Completed committee commitment", description: "A voluntary committee commitment was completed and verified.", weeklyCap: 2 },
      { recognitionKind: "commitment_complete", label: "Completed voluntary commitment", description: "A specific, voluntary chapter commitment was completed and verified.", weeklyCap: 5 },
    ],
    events: [
      { id: "recognition-demo-1", recognitionKind: "training_complete", sourceLabel: "Organizing foundations", occurredAt: "2026-07-20T18:00:00Z", verifiedAt: "2026-07-20T20:00:00Z" },
      { id: "recognition-demo-2", recognitionKind: "peer_outreach_complete", sourceLabel: "New-member welcome calls", occurredAt: "2026-07-18T17:00:00Z", verifiedAt: "2026-07-18T19:00:00Z" },
    ],
  },
  peerContact: {
    available: true,
    canRequest: true,
    code: "PSG-DE40C0DE00DE40C0DE00",
    incoming: [{ id: "preview-peer-request-1", requesterName: "Marisol Vega", requesterInitials: "MV", createdAt: "2026-08-12T14:00:00Z", expiresAt: "2026-08-19T14:00:00Z" }],
    outgoing: [],
    conversations: [{
      id: "preview-peer-conversation-1",
      peerName: "Jordan Lee",
      peerInitials: "JL",
      updatedAt: "2026-08-12T13:30:00Z",
      messages: [
        { id: "preview-peer-message-1", sentByMe: false, body: "Thanks for sharing your code at the meeting.", createdAt: "2026-08-12T13:30:00Z" },
      ],
    }],
  },
  weeklyQuestions: [
    {
      id: "preview-weekly-question-member",
      body: "Which scheduling issue should the committee raise next?",
      options: ["Advance notice", "Shift swaps", "Mandatory overtime"],
      editorialState: "submitted",
      submittedByMe: true,
      boostedByMe: false,
      promotedByMe: false,
      promotionAvailable: true,
      priority: false,
      score: 4,
      createdAt: "2026-08-28T14:00:00Z",
    },
    {
      id: "preview-weekly-question-peer",
      body: "Which organizing-rights topic needs a short campaign explainer?",
      options: ["Talking on non-work time", "Supervisor questions", "Captive meetings"],
      editorialState: "submitted",
      submittedByMe: false,
      boostedByMe: false,
      promotedByMe: false,
      promotionAvailable: true,
      priority: false,
      score: 7,
      createdAt: "2026-08-28T13:00:00Z",
    },
  ],
  weekDays: [
    { label: "M", active: false },
    { label: "T", active: true },
    { label: "W", active: false },
    { label: "T", active: true },
    { label: "F", active: true },
    { label: "S", active: false },
    { label: "S", active: false, today: true, dayNumber: "19" },
  ],
  planItems: [
    {
      id: "ballot-2026",
      kind: "ballot",
      icon: "🗳",
      title: "Should Harborview Care United file the representation petition this month?",
      meta: "Closes Mon, Aug 31 · 7:59 PM",
      closesAt: "2026-08-31T19:59:00-04:00",
      action: "Vote",
      options: [
        { id: "ballot-2026-yes", label: "Yes — approve", order_index: 1 },
        { id: "ballot-2026-no", label: "No — reject", order_index: 2 },
        { id: "ballot-2026-abstain", label: "Abstain", order_index: 3 },
      ],
      selectedOption: "",
      receiptCode: "",
      quorum: { totalVotes: 1, quorumTarget: 200 },
    },
    {
      // Closed ballot with published results (UB-VOTE-02): demo mirrors what a
      // live member sees after close — per-option counts from get_ballot_tally,
      // never which option this member picked. Votes sum to totalVotes.
      id: "ballot-2025-contract-demo",
      kind: "ballot",
      icon: "🗳",
      title: "Should the committee hold an open meeting night in June?",
      meta: "Closed Fri, Jun 26 · Closed",
      action: "Voted",
      closed: true,
      closesAt: "2026-06-26T19:59:00-04:00",
      options: [
        { id: "ballot-2025-contract-demo-yes", label: "Yes — approve", order_index: 1 },
        { id: "ballot-2025-contract-demo-no", label: "No — reject", order_index: 2 },
        { id: "ballot-2025-contract-demo-abstain", label: "Abstain", order_index: 3 },
      ],
      selectedOption: "",
      receiptCode: "K7TQ2MRX",
      quorum: { totalVotes: 213, quorumTarget: 300 },
      results: [
        { optionId: "ballot-2025-contract-demo-yes", label: "Yes — approve", votes: 154 },
        { optionId: "ballot-2025-contract-demo-no", label: "No — reject", votes: 41 },
        { optionId: "ballot-2025-contract-demo-abstain", label: "Abstain", votes: 18 },
      ],
    },
    {
      id: "pulse-new-members",
      kind: "pulse",
      icon: "🩺",
      title: "Which outreach would help unreached evening-shift coworkers most?",
      meta: "2-min pulse · Closes Sep 4",
      closesAt: "2026-09-04T19:59:00-04:00",
      action: "Answer",
      options: [
        { id: "pulse-new-members-mentor", label: "A paired house visit", order_index: 1 },
        { id: "pulse-new-members-rights", label: "A rights conversation after shift", order_index: 2 },
        { id: "pulse-new-members-office-hours", label: "A committee coffee before work", order_index: 3 },
      ],
      selectedOption: "",
    },
    {
      id: "section-7",
      kind: "lesson",
      icon: "📚",
      title: "Section 7 · Know Your Organizing Rights",
      meta: "Use this if a supervisor asks who is organizing or whether you signed a card.",
      action: "Start",
    },
  ],
  conversations: [
    {
      id: "bfd2c08d-384c-4fd1-85e1-5a746ccd63b7",
      counterpartRole: "steward",
      sender: "Committee",
      initials: "CM",
      preview: "Write down what they asked. We will go over it before Thursday's huddle.",
      dateLabel: "Jul 12",
      unread: 1,
      messages: [
        { id: "m1", conversation_id: "bfd2c08d-384c-4fd1-85e1-5a746ccd63b7", sender_kind: "steward", sender_name: "Committee", body: "Write down what they asked. We will go over it before Thursday's huddle.", created_at: "2026-07-12T14:00:00Z", reactions: [{ id: "preview-reaction-1", actor_id: "11111111-1111-4111-8111-111111111111", reaction: "support" }], saved: true, reminder: { id: "preview-reminder-1", remind_at: "2026-08-13T14:00:00Z", status: "pending" } },
      ],
    },
    {
      id: "de22135f-f0a9-47ac-a574-13faa786c049",
      counterpartRole: "steward",
      sender: "Committee",
      initials: "CM",
      preview: "See you at the card count.",
      dateLabel: "Jun 28",
      unread: 0,
      messages: [
        { id: "m2", conversation_id: "de22135f-f0a9-47ac-a574-13faa786c049", sender_kind: "steward", sender_name: "Committee", body: "See you at the card count.", created_at: "2026-06-28T14:00:00Z" },
      ],
    },
  ],
  savedMessages: [{ id: "preview-saved-1", sourceKind: "private", available: true, preview: "Write down what they asked. We will go over it before Thursday's huddle.", targetId: "bfd2c08d-384c-4fd1-85e1-5a746ccd63b7", savedAt: "2026-08-12T13:00:00Z" }],
  messageReminders: [{ id: "preview-reminder-1", sourceKind: "private", available: true, preview: "Write down what they asked. We will go over it before Thursday's huddle.", targetId: "bfd2c08d-384c-4fd1-85e1-5a746ccd63b7", remindAt: "2026-08-13T14:00:00Z" }],
  broadcasts: [
    ["2024Q3", "card conversations"],
    ["2025Q1", "evening-shift outreach"],
    ["2024Q2", "card conversations"],
    ["2025Q3", "evening-shift outreach"],
    ["2026Q1", "evening-shift outreach"],
    ["2026Q2", "evening-shift outreach"],
  ].map(([quarter, focus], index) => ({
    id: `announcement-${index + 1}`,
    sender: "Committee",
    title: `Harborview Care United ${quarter} update`,
    body: `Campaign update for ${quarter}: the committee is tracking ${focus}, upcoming huddles, and next steps.`,
    publishedAt: "2026-07-18T14:00:00Z",
    // Demo content is written in English; the flag keeps the es demo honest.
    locale: "en",
    unread: true,
  })).concat(Array.from({ length: 14 }, (_, index) => ({
    id: `archive-${index + 1}`,
    sender: "Committee",
    title: `Campaign briefing ${index + 1}`,
    body: "Archived campaign briefing with huddle notes, outreach reminders, and worker follow-up actions.",
    publishedAt: "2026-05-02T14:00:00Z",
    locale: "en",
    unread: true,
  }))),
  // REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113: the fixture
  // app has no database to read the campaign's notice colour from; Harborview
  // Care United has picked blue for its chapter notices.
  noticeChapters: Object.fromEntries([
    ...Array.from({ length: 6 }, (_, index) => `announcement-${index + 1}`),
    ...Array.from({ length: 14 }, (_, index) => `archive-${index + 1}`),
  ].map((id) => [id, { name: "Harborview Care United", glow: "blue" }])),
  guideThreads: [],
  // Fictional PREVIEW organizing excerpts for the guided tour only. They
  // remain searchable in the demo, but live retrieval quarantines every legacy
  // seed.
  kbArticles: [
    {
      preview: true,
      slug: "captive-meeting",
      kind: "rights",
      title: "You do not have to agree in a captive meeting",
      title_es: "No tienes que estar de acuerdo en una reunión obligatoria",
      ref: "PREVIEW · Organizing rights · captive meeting",
      body: "The employer can require you to attend a meeting about the union. They cannot force you to speak, sign, or name coworkers. Write down what was said and tell a committee member.",
      body_es: "El empleador puede exigirte que asistas a una reunión sobre el sindicato. No puede obligarte a hablar, firmar ni nombrar a tus compañeros. Anota lo que se dijo y cuéntaselo a alguien del comité.",
      keywords: ["captive", "meeting", "supervisor", "speech"],
    },
    {
      preview: true,
      slug: "section-7-concerted-activity",
      kind: "rights",
      title: "You can talk about forming a union",
      title_es: "Puedes hablar de formar un sindicato",
      ref: "PREVIEW · Organizing rights · Section 7",
      body: "You and your coworkers may talk about pay, safety, and forming a union on non-work time. A supervisor cannot legally spy, threaten, promise favors, or interrogate you about organizing.",
      body_es: "Tú y tus compañeros pueden hablar de salarios, seguridad y formar un sindicato fuera del horario de trabajo. Un supervisor no puede legalmente espiarte, amenazarte, prometerte favores ni interrogarte sobre la organización.",
      keywords: ["section 7", "organizing", "supervisor", "concerted"],
    },
    {
      preview: true,
      slug: "supervisor-questions",
      kind: "faq",
      title: "What can a supervisor ask?",
      title_es: "¿Qué puede preguntar un supervisor?",
      ref: "PREVIEW · Organizing rights · supervisor questions",
      body: "You do not have to say who signed a card or what was said at a meeting. Write down what was asked, who was present, and the time. Tell a committee member or organizer.",
      body_es: "No tienes que decir quién firmó una tarjeta ni lo que se dijo en una reunión. Anota lo que te preguntaron, quién estaba presente y la hora. Cuéntaselo a alguien del comité o a un organizador.",
      keywords: ["supervisor", "card", "interrogation", "questions"],
    },
    {
      preview: true,
      slug: "cards-and-recognition",
      kind: "faq",
      title: "Cards, elections and recognition",
      title_es: "Tarjetas, elecciones y reconocimiento",
      ref: "PREVIEW · Organizing rights · cards and recognition",
      // The same sentence the native preview guide carries
      // (apps/mobile/src/data/preview.ts, cards-and-recognition).
      body: "A signed card shows that you support forming a union. A card majority is not certification: recognition comes either voluntarily from the employer or through an election, and those are separate paths. Bargaining a first contract starts only after the union is recognized or certified.",
      body_es: "Una tarjeta firmada muestra que apoyas formar un sindicato. Una mayoría de tarjetas no es una certificación: el reconocimiento llega voluntariamente del empleador o mediante una elección, y son caminos separados. La negociación de un primer contrato empieza solo después de que el sindicato es reconocido o certificado.",
      keywords: ["card", "majority", "recognition", "election", "certification"],
    },
  ],
  product: {
    // The staff knowledge manager intentionally starts empty in the tour.
    // Fictional kbArticles above are demo answer fixtures, never live sources.
    compassKnowledge: [],
    spaces: [
      {
        id: "space-demo-1",
        name: "Workplace issues",
        description: "Ongoing campaign conversations about scheduling, safety, and workload.",
        visibility: "chapter",
        updated_at: "2026-07-27T15:10:00Z",
        threads: [
          {
            id: "thread-demo-1",
            space_id: "space-demo-1",
            title: "Overtime scheduling and notice",
            kind: "issue",
            status: "open",
            updated_at: "2026-07-27T15:10:00Z",
            posts: [
              {
                id: "post-demo-1",
                thread_id: "thread-demo-1",
                body: "Use this thread to collect notice problems and coordinate the next group action.",
                created_at: "2026-07-27T14:00:00Z",
              },
              {
                id: "post-demo-2",
                thread_id: "thread-demo-1",
                body: "Three coworkers reported less than 48 hours of notice this week.",
                created_at: "2026-07-27T15:10:00Z",
              },
            ],
          },
        ],
      },
    ],
    intake: [
      {
        id: "intake-demo-1",
        category: "workplace_issue",
        title: "Weekend mandate notice",
        details: "The schedule changed after Friday afternoon without the posted notice window.",
        status: "triaged",
        created_at: "2026-07-26T17:30:00Z",
      },
    ],
    documents: [
      {
        id: "document-demo-1",
        title: "Overtime notice notes",
        document_type: "policy",
        summary: "Quick reference for notice, rotation, and voluntary overtime.",
        body: "Save the posted schedule and write down when management delivered each change.",
        version: 2,
        status: "published",
        updated_at: "2026-07-25T13:00:00Z",
      },
    ],
    records: [
      {
        id: "record-demo-1",
        record_type: "decision",
        title: "Track short-notice overtime",
        body: "The committee agreed to collect incidents in one thread before raising them with management as a group in August.",
        occurred_at: "2026-07-24T18:00:00Z",
      },
    ],
    handshakes: [
      {
        id: "handshake-demo-1",
        partner_org_id: "partner-demo-1",
        title: "Shared house-visit training",
        purpose: "Swap house-visit role-plays and meeting templates with a sister campaign. No worker names or lists.",
        data_scope: "docs_only",
        status: "requested",
        union_orgs: { name: "North County Transit Workers", city: "North County", state: "MA", affiliation: "Independent organizing committee" },
      },
    ],
    governance: [
      {
        id: "governance-demo-1",
        request_type: "export",
        details: "Export my submitted forms and case notes.",
        status: "reviewing",
        created_at: "2026-07-25T16:00:00Z",
      },
    ],
    partnerOrgs: [
      { id: "partner-demo-1", name: "North County Transit Workers", city: "North County", state: "MA", affiliation: "Independent organizing committee" },
      { id: "partner-demo-2", name: "Metro Dispatch Committee", city: "Metro", state: "MA", affiliation: "Independent organizing committee" },
    ],
  },
  // The demo steward's appointments desk (get_steward_appointments shape).
  stewardApptDesk: {
    schedule: { timezone: "America/New_York", minNoticeMinutes: 240, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, maxPerDay: 6, accepting: true },
    windows: [
      { id: "win-demo-1", weekday: 2, startMinute: 540, endMinute: 720 },
      { id: "win-demo-2", weekday: 4, startMinute: 780, endMinute: 960 },
    ],
    blackouts: [
      { id: "blk-demo-1", startDate: "2026-08-24", endDate: "2026-08-28" },
    ],
    connections: [],
    upcoming: [
      { id: "sappt-demo-1", place: "Boston office · Room 204", memberName: "Jordan Mills", type: "grievance_followup", durationMinutes: 30, startsAt: "2026-08-06T13:30:00Z", endsAt: "2026-08-06T14:00:00Z", status: "confirmed", reasonCategory: "discipline", routedVia: "steward" },
      { id: "sappt-demo-2", memberName: "Ava Ramos", type: "office_hours", durationMinutes: 20, startsAt: "2026-08-07T15:00:00Z", endsAt: "2026-08-07T15:20:00Z", status: "confirmed", reasonCategory: "scheduling", routedVia: "chapter" },
      // Third row so the demo's 2-per-page appointments pager actually shows
      // (sol  F9), same reason the thread list carries thr-demo-3.
      { id: "sappt-demo-5", memberName: "Marisol Vega", type: "contract_questions", durationMinutes: 45, startsAt: "2026-08-11T17:00:00Z", endsAt: "2026-08-11T17:45:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "chapter" },
    ],
    recent: [
      { id: "sappt-demo-3", place: "https://meet.example.org/onboarding", memberName: "Theo Nguyen", type: "onboarding", durationMinutes: 20, startsAt: "2026-07-22T14:00:00Z", status: "completed" },
      { id: "sappt-demo-4", memberName: "Jordan Bell", type: "office_hours", durationMinutes: 30, startsAt: "2026-07-18T16:00:00Z", status: "no_show" },
      { id: "sappt-demo-6", memberName: "Priya Shah", type: "grievance_followup", durationMinutes: 30, startsAt: "2026-07-15T13:00:00Z", status: "completed" },
    ],
    stats: { noShows30d: 1, completed30d: 4 },
  },
  stewardDesk: {
    kpis: { openRequests: 3, membersCovered: 214, awaitingReply: 2, broadcasts30d: 4 },
    workloadIntelligence: {
      available: true,
      eligibleWeeks: 6,
      categories: [
        { key: "priority", points: 6, slope: 0.4, latest: 10, forecast4Weeks: 11.6 },
        { key: "pending", points: 6, slope: 1.5, latest: 24, forecast4Weeks: 30 },
        { key: "aged_cases", points: 6, slope: -0.5, latest: 7, forecast4Weeks: 5 },
      ],
      rebalancing: {
        stewards: [
          { userId: "demo-steward-1", name: "R. Cole", activeCases: 18, dueSoon: 4, overdue: 2 },
          { userId: "demo-steward-2", name: "A. Ramos", activeCases: 7, dueSoon: 1, overdue: 0 },
        ],
        suggestions: [
          { fromUserId: "demo-steward-1", fromName: "R. Cole", toUserId: "demo-steward-2", toName: "A. Ramos", reviewCount: 3 },
        ],
      },
      preview: true,
    },
    queue: [
      { id: "req-demo-1", memberInitials: "JM", memberName: "Jordan Mills", lessonLabel: "Section 7", createdAt: "2026-07-21T15:10:00Z", status: "requested" },
      { id: "req-demo-2", memberInitials: "AR", memberName: "Ava Ramos", lessonLabel: "Supervisor questions", createdAt: "2026-07-20T18:30:00Z", status: "acknowledged" },
      { id: "req-demo-3", memberInitials: "TN", memberName: "Theo Nguyen", lessonLabel: "", createdAt: "2026-07-19T14:00:00Z", status: "requested" },
    ],
    threads: [
      {
        id: "thr-demo-1",
        memberInitials: "JM",
        memberName: "Jordan Mills",
        preview: "They scheduled a meeting for Thursday and won't say what it's about.",
        updatedAt: "2026-07-21T15:12:00Z",
        awaitingReply: true,
        messages: [
          { id: "tm-1", sender_kind: "member", sender_name: "Jordan Mills", body: "My supervisor scheduled a meeting for Thursday and won't say what it's about. Should I be worried?", created_at: "2026-07-21T15:12:00Z" },
        ],
      },
      {
        id: "thr-demo-2",
        memberInitials: "AR",
        memberName: "Ava Ramos",
        preview: "Thanks — I'll keep my notes and bring them to Thursday's huddle.",
        updatedAt: "2026-07-20T19:02:00Z",
        awaitingReply: true,
        messages: [
          { id: "tm-2", sender_kind: "steward", sender_name: "Committee", body: "Keep a copy of every accuracy notice they hand you. We will review it at the next committee huddle.", created_at: "2026-07-20T18:40:00Z" },
          { id: "tm-3", sender_kind: "member", sender_name: "Ava Ramos", body: "Thanks — I'll keep my notes and bring them to Thursday's huddle.", created_at: "2026-07-20T19:02:00Z" },
        ],
      },
      // Third thread so the demo's 2-per-page thread list actually shows the
      // UB-DESK-01 pager (the desk pages at 2 in the demo hat).
      {
        id: "thr-demo-3",
        memberInitials: "TL",
        memberName: "Tomas Lang",
        preview: "Got it — I'll bring the staffing sheets to Thursday's office hours.",
        updatedAt: "2026-07-19T16:20:00Z",
        awaitingReply: false,
        messages: [
          { id: "tm-4", sender_kind: "member", sender_name: "Tomas Lang", body: "Do you need the overnight staffing sheets before we bring the staffing issue to the committee?", created_at: "2026-07-19T15:55:00Z" },
          { id: "tm-5", sender_kind: "steward", sender_name: "Committee", body: "Yes — bring the last month. We'll compare them against the posted minimums together.", created_at: "2026-07-19T16:20:00Z" },
        ],
      },
    ],
    broadcasts: [
      { id: "bc-demo-1", locale: "en", publishedAt: "2026-07-18T14:00:00Z", retracted: false, readCount: 168, title: "Card-count update", body: "Evening-shift conversations put the campaign over the next majority check. Full recap and the next huddle are posted on Today." },
      { id: "bc-demo-2", locale: "en", publishedAt: "2026-07-11T14:00:00Z", retracted: false, readCount: 142, title: "Committee office hours moved", body: "Weekly committee office hours now run Wednesdays at noon on Zoom and in the Boston office. Bring any supervisor or scheduling questions." },
      { id: "bc-demo-3", locale: "en", publishedAt: "2026-07-03T14:00:00Z", retracted: false, readCount: 201, title: "Know your Section 7 rights", body: "You can talk with coworkers about forming a union on non-work time. A supervisor cannot legally interrogate you about who signed a card." },
    ],
    formsInbox: [
      { id: "form-inbox-1", userId: "demo-member-2", memberInitials: "JM", memberName: "Jordan Mills", templateKey: "grievance", status: "submitted", submittedAt: "2026-07-21T16:40:00Z",
        filerSignedAt: "2026-07-21T16:38:00Z", filerSignatureDigest: "demo-inbox-signature-1", files: [],
        answers: { summary: "Mandated overtime without the 48-hour notice", incident_date: "2026-07-18", narrative: "Third mandate this month; the notice arrived after the shift had already started.", remedy: "Follow the notice window and make the extra hours voluntary", witnesses: "A. Reyes" }, cosigners: [] },
      { id: "form-inbox-2", userId: "demo-member-3", memberInitials: "AR", memberName: "Ava Ramos", templateKey: "alt_work", status: "in_review", submittedAt: "2026-07-20T13:05:00Z",
        filerSignedAt: "2026-07-20T13:03:00Z", filerSignatureDigest: "demo-inbox-signature-2", files: [],
        answers: { requested: "Telework Tuesdays and Thursdays", reason: "Recurring medical appointments" }, cosigners: [] },
      { id: "form-inbox-3", userId: "demo-member-4", memberInitials: "TL", memberName: "Tomas Lang", templateKey: "alliance_grievance", status: "submitted", submittedAt: "2026-07-21T12:00:00Z",
        filerSignedAt: "2026-07-21T11:58:00Z", filerSignatureDigest: "demo-inbox-signature-3", files: [],
        answers: { summary: "Unsafe staffing ratios on the overnight ward", incident_date: "2026-07-15", narrative: "Three overnights this month ran one aide short of the posted minimum.", affected: "Overnight ward aides", remedy: "Backfill the minimum ratio and post the schedule 7 days out." },
        cosigners: [{ id: "cs-inbox-1", name: "Ava Ramos" }, { id: "cs-inbox-2", name: "Renata Cole" }] },
    ],
  },
  // One privacy-bounded appointment report store is shared by the three
  // authorized demo hats. Rows intentionally omit reason, place/link and all
  // contact fields; the in-memory twin may only change its two steward fields.
  chapterAppointmentSupervision: {
    rows: [
      {
        id: "demo-chapter-appt-3",
        memberName: "Renata Cole",
        appointmentType: "contract_questions",
        durationMinutes: 45,
        startsAt: relativeDemoTimestamp(7, 18),
        endsAt: relativeDemoTimestamp(7, 18, 45),
        status: "confirmed",
        stewardId: "staff-pc",
        stewardName: "Priya Chandran",
      },
      {
        id: "demo-chapter-appt-2",
        memberName: "Marcus Bell",
        appointmentType: "office_hours",
        durationMinutes: 30,
        startsAt: relativeDemoTimestamp(3, 15),
        endsAt: relativeDemoTimestamp(3, 15, 30),
        status: "confirmed",
        stewardId: "staff-so",
        stewardName: "Sam Okafor",
      },
      {
        id: "demo-chapter-appt-1",
        memberName: "Priya Nair",
        appointmentType: "onboarding",
        durationMinutes: 20,
        startsAt: relativeDemoTimestamp(-7, 14),
        endsAt: relativeDemoTimestamp(-7, 14, 20),
        status: "completed",
        stewardId: "staff-pc",
        stewardName: "Priya Chandran",
      },
    ],
    candidates: [
      { id: "staff-pc", name: "Priya Chandran" },
      { id: "staff-so", name: "Sam Okafor" },
    ],
  },
  // Seeded coordinator plane in loadCoordinatorDesk's exact output shape so
  // the demo hat renders the real data-driven component unchanged.
  coordinatorDesk: {
    kpis: {
      openCases: 4,
      dueThisWeek: 2,
      resolved: 2,
      resolutionRate: 33,
    },
    cases: [
      { id: "coord-case-1", reference: "ISS-2418", title: "Supervisor interrogation after a huddle", caseType: "Rights", status: "active", deadline: "2026-07-24", deadlineLabel: "Jul 24", overdue: false, memberName: "Renata Cole", memberInitials: "RC",
        updates: [
          { id: "cu-1", body: "Worker wrote down the questions; organizer will sit in on the next one-on-one.", createdAt: "Jun 18", createdAtValue: "2026-06-18T15:00:00Z" },
          { id: "cu-2", body: "Committee review documented the interrogation and who was present.", createdAt: "Jun 2", createdAtValue: "2026-06-02T15:00:00Z" },
        ] },
      { id: "coord-case-2", reference: "ISS-2431", title: "Overtime distribution", caseType: "Scheduling", status: "active", deadline: "2026-07-28", deadlineLabel: "Jul 28", overdue: false, memberName: "Marcus Bell", memberInitials: "MB",
        updates: [{ id: "cu-3", body: "First note logged; the employer claimed operational need without producing records.", createdAt: "Jun 14", createdAtValue: "2026-06-14T15:00:00Z" }] },
      { id: "coord-case-3", reference: "ISS-2440", title: "Schedule change after card talk", caseType: "Scheduling", status: "active", deadline: "2026-07-30", deadlineLabel: "Jul 30", overdue: false, memberName: "Priya Nair", memberInitials: "PN",
        updates: [] },
      { id: "coord-case-4", reference: "ISS-2447", title: "Retaliation after a card conversation", caseType: "Retaliation", status: "active", deadline: "2026-07-22", deadlineLabel: "Jul 22", overdue: true, memberName: "Devon Reyes", memberInitials: "DR",
        // The same overdue issue the seeded Campaign chair plane lists under
        // attention (att-case-2, ISS-2447), so the demo shows one campaign's
        // leadership review reaching the desk that works the issue.
        review: { reviewerName: "Taylor Morgan", reviewedAt: "2026-07-23T15:00:00Z", reviewedLabel: "Jul 23" },
        updates: [{ id: "cu-4", body: "Three adverse actions logged within 22 days of the protected conversation.", createdAt: "Jun 19", createdAtValue: "2026-06-19T15:00:00Z" }] },
      { id: "coord-case-5", reference: "ISS-2402", title: "Schedule change without notice", caseType: "Scheduling", status: "resolved", deadline: "", deadlineLabel: "", overdue: false, memberName: "Sam Okafor", memberInitials: "SO", updates: [] },
    ],
  },
  // Seeded VP plane in loadVpOverview's exact output shape.
  vpOverview: {
    reviews: [],
    overview: {
      memberCount: 812,
      newThisYear: 18,
      activeGrievances: 7,
      turnout: { title: "Petition vote", totalVotes: 213, quorumTarget: 300 },
      attention: [
        { id: "att-case-1", reference: "ISS-2291", title: "Evening-shift card count still short", deadline: "2026-07-18", memberName: "Sam Okafor" },
        { id: "att-case-2", reference: "ISS-2447", title: "Retaliation after a card conversation", deadline: "2026-07-22", memberName: "Devon Reyes" },
      ],
      upcomingEvents: [
        { id: "evt-exec-board", title: "Campaign lead huddle", startsAt: "2026-07-24T22:00:00Z", location: "Library room + Zoom", summary: "Card majority check, committee vacancies, outreach plan." },
        { id: "evt-bargaining-14", title: "Recognition strategy session", startsAt: "2026-08-04T14:00:00Z", location: "Off-site library room", summary: "Petition timing and evening-shift coverage." },
        { id: "evt-delegate-assembly", title: "Committee assembly", startsAt: "2026-08-16T13:00:00Z", location: "Campaign hall", summary: "Worksite reports and next-month priorities." },
      ],
      priorities: [
        { id: "ballot-2026", title: "Should we file the representation petition this month?", kind: "ballot" },
        { id: "survey-pulse", title: "Weekly pulse — mandated overtime", kind: "survey" },
      ],
      membershipTrend: [
        { year: 2021, count: 588 },
        { year: 2022, count: 634 },
        { year: 2023, count: 671 },
        { year: 2024, count: 718 },
        { year: 2025, count: 766 },
        { year: 2026, count: 812 },
      ],
    },
    roster: [
      { userId: "staff-tm", fullName: "Taylor Morgan", initials: "TM", memberSince: 2019, roles: ["vp"] },
      { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", memberSince: 2021, roles: ["steward"] },
      // Canon cast (prototype vestigial ids): Sam Okafor is Member & Steward;
      // Jordan Patel is the Grievance Coordinator; Avery Nguyen the Advisor.
      { userId: "staff-so", fullName: "Sam Okafor", initials: "SO", memberSince: 2022, roles: ["steward"] },
      { userId: "staff-jp", fullName: "Jordan Patel", initials: "JP", memberSince: 2020, roles: ["coordinator"] },
      { userId: "staff-an", fullName: "Avery Nguyen", initials: "AN", memberSince: 2020, roles: ["advisor"] },
      // Organizer is a staff hat: the
      // leadership roster lists the campaign's organizer with the others.
      { userId: "staff-ec", fullName: "Elena Cruz", initials: "EC", memberSince: 2024, roles: ["organizer"] },
    ],
  },
  // Seeded advisor plane in loadAdvisorDesk's exact output shape.
  advisorDesk: {
    overview: {
      membersCovered: 812,
      openGrievances: 7,
      resolvedGrievances: 21,
      stewardCount: 6,
      coverageRatio: 135,
      resolutionRate: 75,
      turnout: { title: "Petition vote", totalVotes: 213, quorumTarget: 300 },
      atRisk: { overdueCases: 2, unstaffed: false },
    },
    workload: {
      enoughData: true,
      period: "2026-Q2",
      submittersBand: "25-49",
      categories: [
        { key: "priority", avg: 34 },
        { key: "pending", avg: 28 },
        { key: "unread_docs", avg: 41 },
        { key: "todos", avg: 22 },
        { key: "referrals", avg: 9 },
        { key: "ce_activities", avg: 6 },
        { key: "assistance_requests", avg: 12 },
        { key: "aged_cases", avg: 17 },
      ],
      tiles: { pctFullTime: 80, pctPartTime: 20, avgOtHours: 3.5 },
    },
    roster: [
      { userId: "staff-tm", fullName: "Taylor Morgan", initials: "TM", memberSince: 2019, roles: ["vp"] },
      { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", memberSince: 2021, roles: ["steward"] },
      { userId: "staff-so", fullName: "Sam Okafor", initials: "SO", memberSince: 2022, roles: ["steward"] },
      { userId: "staff-jp", fullName: "Jordan Patel", initials: "JP", memberSince: 2020, roles: ["coordinator"] },
      { userId: "staff-an", fullName: "Avery Nguyen", initials: "AN", memberSince: 2020, roles: ["advisor"] },
      // Organizer is a staff hat: the
      // leadership roster lists the campaign's organizer with the others.
      { userId: "staff-ec", fullName: "Elena Cruz", initials: "EC", memberSince: 2024, roles: ["organizer"] },
    ],
  },
  // Seeded admin plane in loadAdminDesk's exact output shape.
  adminDesk: {
    formTemplates: ADMIN_FORM_TEMPLATE_ROWS,
    memberDirectory: {
      items: [
        { userId: "member-db", fullName: "Darnell Brooks", initials: "DB", memberSince: 2019, chapterId: "ma-dcf", chapterName: "North County Transit Workers", roles: [] },
        { userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, chapterId: "ma-dcf", chapterName: "North County Transit Workers", roles: [] },
        { userId: "member-mf", fullName: "Maria Fonseca", initials: "MF", memberSince: 2024, chapterId: "ma-dcf", chapterName: "North County Transit Workers", roles: [] },
        { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", memberSince: 2021, chapterId: "ma-dcf", chapterName: "North County Transit Workers", roles: ["steward"] },
      ],
      nextCursor: null,
    },
    organization: {
      scope: "organization",
      chapterId: null,
      canCreateChapter: true,
      chapters: [
        { id: "ma-dcf", name: "North County Transit Workers", region: "Massachusetts", isDefault: true, orderIndex: 1, memberCount: 812, staffCount: 7, roleCounts: { steward: 3, organizer: 1, coordinator: 1, advisor: 1, admin: 1, vp: 0 } },
        { id: "ma-dmh", name: "Lakeside Library Workers", region: "Massachusetts", isDefault: false, orderIndex: 2, memberCount: 436, staffCount: 4, roleCounts: { steward: 2, organizer: 0, coordinator: 1, advisor: 0, admin: 1, vp: 0 } },
        { id: "ma-dta", name: "Eastgate Warehouse Workers", region: "Massachusetts", isDefault: false, orderIndex: 3, memberCount: 291, staffCount: 3, roleCounts: { steward: 1, organizer: 0, coordinator: 1, advisor: 0, admin: 1, vp: 0 } },
      ],
    },
    // Credential-free visual-audit twin of the organization configuration
    // reader. These values are non-secret controls and labels only; passkey
    // credentials and recovery codes are never fixtures.
    configuration: {
      organizationId: DEMO_ORGANIZATION_ID,
      settings: [
        { key: "features.passkey_enrollment", kind: "boolean", category: "security", memberVisible: true, label: "Member passkey enrollment", description: "Allow signed-in members to add phishing-resistant passkeys to their own account.", value: true, defaultValue: true, minimum: null, maximum: null, allowedValues: null, overridden: true, updatedAt: "2026-09-01T14:00:00.000000+00:00", lastChange: { action: "setting_updated", at: "2026-09-01T14:00:00.000000+00:00", actorName: "Alex Rivera" } },
        { key: "features.mfa_recovery_code_enrollment", kind: "boolean", category: "security", memberVisible: true, label: "Recovery code enrollment", description: "Allow members with verified two-step authentication to generate or rotate recovery codes.", value: true, defaultValue: true, minimum: null, maximum: null, allowedValues: null, overridden: true, updatedAt: "2026-09-01T14:00:00.000000+00:00", lastChange: { action: "setting_updated", at: "2026-09-01T14:00:00.000000+00:00", actorName: "Alex Rivera" } },
        { key: "security.failed_login_retention_days", kind: "integer", category: "security", memberVisible: false, label: "Failed sign-in retention", description: "Days to retain organization-attributed failed sign-in records.", value: 90, defaultValue: 90, minimum: 7, maximum: 365, allowedValues: null, overridden: true, updatedAt: "2026-09-01T14:00:00.000000+00:00", lastChange: { action: "setting_updated", at: "2026-09-01T14:00:00.000000+00:00", actorName: "Alex Rivera" } },
        { key: "security.failed_login_alert_threshold", kind: "integer", category: "security", memberVisible: false, label: "Failed sign-in attention threshold", description: "Open failures in the last 24 hours that mark the operations inbox for attention.", value: 3, defaultValue: 5, minimum: 1, maximum: 100, allowedValues: null, overridden: true, updatedAt: "2026-09-01T14:00:00.000000+00:00", lastChange: { action: "setting_updated", at: "2026-09-01T14:00:00.000000+00:00", actorName: "Alex Rivera" } },
        // REQ-UG-CONFIGURABLE-THRESHOLDS-20261001 definitions at their defaults.
        ...DEMO_THRESHOLD_SETTINGS,
      ],
      labelKeys: [
        "nav.home", "nav.myCases", "nav.messages", "nav.inbox", "nav.knowRights",
        "nav.myChapter", "nav.settings", "staff.chapterWork", "nav.casework",
        "admin.title", "coordinator.title", "advisor.title", "vp.title",
      ],
      labelOverrides: { ...DEMO_ORGANIZATION_LABEL_OVERRIDES },
    },
    // Hashed references and generic client metadata mirror the operations
    // inbox without retaining an address, credential, token, or raw IP.
    failedLoginInbox: {
      openLast24Hours: 3,
      attentionThreshold: 3,
      items: [
        { id: "30000000-0000-4000-8000-000000000001", memberName: "Jordan Bell", memberReference: "A91F2C", method: "password", source: "web-saas", userAgent: "Safari on iPhone", status: "open", dispositionNote: null, occurredAt: recentDemoTimestamp(2), reviewedAt: null },
        { id: "30000000-0000-4000-8000-000000000002", memberName: "Maria Fonseca", memberReference: "7D40B8", method: "passkey", source: "web-saas", userAgent: "Chrome on Android", status: "open", dispositionNote: null, occurredAt: recentDemoTimestamp(5), reviewedAt: null },
        { id: "30000000-0000-4000-8000-000000000003", memberName: "Darnell Brooks", memberReference: "E38A61", method: "password", source: "native-ios", userAgent: "Union Ground iOS", status: "open", dispositionNote: null, occurredAt: recentDemoTimestamp(9), reviewedAt: null },
        { id: "30000000-0000-4000-8000-000000000004", memberName: "Former member", memberReference: "10C5D4", method: "password", source: "web-saas", userAgent: "Firefox on macOS", status: "reviewed", dispositionNote: "Confirmed address typo during assisted sign-in.", occurredAt: recentDemoTimestamp(30), reviewedAt: recentDemoTimestamp(29) },
      ],
    },
    // Test/e2e/visual-harness state only. Live SAMPLE resolves the SAMPLE
    // Supabase client and uses the same retention RPCs as production.
    retentionEngine: {
      organizationId: "50910400-0000-4000-8000-000000000001",
      schedulerConfigured: true,
      policies: [
        { dataClass: "organization_page_views", retentionDays: 180, minimumDays: 30, maximumDays: 3650, defaultDays: 180, executionEnabled: true, configured: true, updatedAt: "2026-08-27T14:20:00Z" },
        { dataClass: "organization_engagement_events", retentionDays: 365, minimumDays: 90, maximumDays: 3650, defaultDays: 365, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "integration_job_history", retentionDays: 365, minimumDays: 90, maximumDays: 3650, defaultDays: 365, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "public_event_rsvps", retentionDays: 90, minimumDays: 90, maximumDays: 90, defaultDays: 90, executionEnabled: true, configured: true, updatedAt: "2026-08-25T12:10:00Z" },
        { dataClass: "deleted_chapter_tasks", retentionDays: 90, minimumDays: 90, maximumDays: 90, defaultDays: 90, executionEnabled: false, configured: true, updatedAt: "2026-08-25T12:10:00Z" },
        { dataClass: "member_message_bodies", retentionDays: 1095, minimumDays: 365, maximumDays: 2555, defaultDays: 1095, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "casework_record_versions", retentionDays: 730, minimumDays: 180, maximumDays: 3650, defaultDays: 730, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "member_notifications", retentionDays: 365, minimumDays: 30, maximumDays: 3650, defaultDays: 365, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "ai_assistant_conversations", retentionDays: 180, minimumDays: 30, maximumDays: 3650, defaultDays: 180, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
        { dataClass: "ai_usage_counters", retentionDays: 30, minimumDays: 1, maximumDays: 365, defaultDays: 30, executionEnabled: false, configured: true, updatedAt: "2026-08-26T15:40:00Z" },
      ],
      runs: [
        { id: "retention-run-demo-1", dataClass: "organization_page_views", retentionDays: 180, mode: "scheduled", status: "completed", eligibleCount: 84, deletedCount: 84, remainingCount: 0, authorizationExpiresAt: "2026-08-27T04:17:00Z", createdAt: "2026-08-27T03:47:00Z", completedAt: "2026-08-27T03:47:02Z", failureCode: null, confirmationPhrase: null },
        { id: "retention-run-demo-2", dataClass: "public_event_rsvps", retentionDays: 90, mode: "manual", status: "completed", eligibleCount: 11, deletedCount: 11, remainingCount: 0, authorizationExpiresAt: "2026-08-25T12:25:00Z", createdAt: "2026-08-25T12:10:00Z", completedAt: "2026-08-25T12:10:01Z", failureCode: null, confirmationPhrase: null },
      ],
    },
    leadershipReviews: [{ caseId: "att-case-1", caseReference: "ISS-2291", caseTitle: "Evening-shift card count still short", reviewedAt: "2026-07-23T15:00:00Z", reviewedLabel: "Jul 23", reviewerName: "Taylor Morgan" }],
    roster: [
      { userId: "staff-ar", fullName: "Alex Rivera", initials: "AR", memberSince: 2018, roles: ["admin"] },
      { userId: "staff-an", fullName: "Avery Nguyen", initials: "AN", memberSince: 2020, roles: ["advisor"] },
      { userId: "staff-jp", fullName: "Jordan Patel", initials: "JP", memberSince: 2020, roles: ["coordinator"] },
      { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", memberSince: 2021, roles: ["steward"] },
      { userId: "staff-so", fullName: "Sam Okafor", initials: "SO", memberSince: 2022, roles: ["steward"] },
      { userId: "staff-tm", fullName: "Taylor Morgan", initials: "TM", memberSince: 2019, roles: ["vp"] },
      { userId: "staff-ec", fullName: "Elena Cruz", initials: "EC", memberSince: 2024, roles: ["organizer"] },
    ],
    events: DEMO_UPCOMING_EVENTS.map((event) => ({ ...event })),
    invitations: {
      chapter: { id: "ma-dcf", name: "North County Transit Workers" },
      items: [
        { id: "demo-invite-1", normalizedEmail: "rosa.delgado@example.org", fullName: "Rosa Delgado", chapterId: "ma-dcf", initialRole: null, locale: "es", status: "pending", deliveryVersion: 1, createdLabel: "Aug 12 · 1:50 PM", expiresLabel: "Aug 12 · 2:05 PM" },
        { id: "demo-invite-2", normalizedEmail: "james.okoye@example.org", fullName: "James Okoye", chapterId: "ma-dcf", initialRole: "steward", locale: "en", status: "accepted", deliveryVersion: 1, createdLabel: "Aug 11 · 9:15 AM", expiresLabel: "Aug 11 · 9:30 AM" },
      ],
    },
    audit: [
      { id: "audit-1", action: "grant_role", actorName: "Alex Rivera", targetName: "Jordan Patel", detail: { role: "coordinator" }, createdLabel: "Jul 20" },
      { id: "audit-2", action: "create_event", actorName: "Alex Rivera", targetName: null, detail: { eventId: "evt-2026-relief-rally", title: "Caseload-relief rally" }, createdLabel: "Jul 18" },
      { id: "audit-3", action: "revoke_role", actorName: "Alex Rivera", targetName: "Jordan Bell", detail: { role: "steward" }, createdLabel: "Jul 12" },
    ],
    // Pending requests in list_member_requests' shape: what this admin may
    // decide (BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102).
    memberRequests: { hasMore: false, items: [
      { id: "request-demo-1", kind: "invitation_suggestion", chapterId: "wor", chapterName: "Harborview Care United", requesterName: "Darnell Brooks", inviteeName: "Priya Natarajan", inviteeEmail: "priya@example.com", requestedRole: null, note: "Works nights in the Shrewsbury office.", status: "pending", createdAt: "2026-07-26T14:00:00Z", decidedAt: null },
      { id: "request-demo-2", kind: "access_request", chapterId: "wor", chapterName: "Harborview Care United", requesterName: "Maria Fonseca", inviteeName: null, inviteeEmail: null, requestedRole: "steward", note: "", status: "pending", createdAt: "2026-07-25T18:00:00Z", decidedAt: null },
    ] },
    governance: [
      { id: "governance-demo-1", requesterId: "member-db", requesterName: "Darnell Brooks", requestType: "export", details: "Export my submitted forms and case notes.", status: "submitted", response: null, createdAt: "2026-07-25T16:00:00Z", createdLabel: "Jul 25" },
    ],
    // Unprotected staff first — the live RPC sorts the same way.
    mfa: {
      enrolledMembers: 214,
      staff: [
        { userId: "staff-an", fullName: "Avery Nguyen", initials: "AN", roles: ["advisor"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
        { userId: "staff-so", fullName: "Sam Okafor", initials: "SO", roles: ["steward"], totpVerified: false, verifiedLabel: "", otherFactors: 1 },
        { userId: "staff-jp", fullName: "Jordan Patel", initials: "JP", roles: ["coordinator"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
        { userId: "staff-tm", fullName: "Taylor Morgan", initials: "TM", roles: ["vp"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
        { userId: "staff-ar", fullName: "Alex Rivera", initials: "AR", roles: ["admin"], totpVerified: true, verifiedLabel: "Jul 12", otherFactors: 0 },
        { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", roles: ["steward"], totpVerified: true, verifiedLabel: "Jun 30", otherFactors: 0 },
        // Organizers see who signed cards, so the staff two-step policy
        // covers them like every other staff hat.
        { userId: "staff-ec", fullName: "Elena Cruz", initials: "EC", roles: ["organizer"], totpVerified: true, verifiedLabel: "Aug 3", otherFactors: 0 },
      ],
    },
    mfaPolicy: {
      requireStaffMfa: false,
      staffTotal: 7,
      staffEnrolled: 3,
      callerEnrolled: true,
    },
    // Explicitly non-authoritative demo state. Production defaults OFF and has
    // no seeded attestation; this preview does the same, while still allowing
    // an admin to exercise the in-memory controls without contacting a provider.
    compassAiGovernance: {
      demo: true,
      enabled: false,
      gateway: "union-ground-mesh",
      model: "union-ground/compass-mesh:v1",
      requiredZeroDataRetention: true,
      requiredDisallowPromptTraining: true,
      attestationReady: false,
      latestAttestation: null,
      roleLimits: ["member", "steward", "coordinator", "advisor", "admin", "vp"]
        .map((role) => ({ role, hourlyLimit: 20 })),
      attestations: [],
    },
  },
  // Demo pool for the admin member search (not part of any loader shape).
  adminSearchPool: [
    { userId: "member-db", fullName: "Darnell Brooks", initials: "DB", memberSince: 2019, roles: [] },
    { userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, roles: [] },
    { userId: "member-mf", fullName: "Maria Fonseca", initials: "MF", memberSince: 2024, roles: [] },
    { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", memberSince: 2021, roles: ["steward"] },
  ],
  metrics: {
    casesHandled: 4,
    tasksDone: 0,
    openCases: 1,
    resolvedCases: 3,
    caseTypes: [
      { label: "Discipline", value: 1 },
      { label: "Telework", value: 1 },
      { label: "Scheduling", value: 1 },
      { label: "Safety", value: 1 },
    ],
    // Index 0 is the oldest of twelve trailing weeks, index 11 the current one
    // — the same shape bucketCasesPerWeek returns on the live path, so the
    // Numbers chart reads one contract in demo and signed-in mode.
    weeks: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    weeksPeak: 1,
  },
  cases: [
    {
      id: "b872b7c3-fdf2-497e-9d91-5b456724a1f0",
      reference: "ISS-2026-042",
      title: "Supervisor meeting with no stated reason",
      deadline: "Jun 21",
      type: "Rights",
      status: "active",
      overdue: true,
      // Server-stamped assignee names (assign_member_case) on the live row.
      stewardName: "Sam Okafor",
      coordinatorName: "Jordan Patel",
      // The ISO date behind the rendered label. loadMemberApp derives this as
      // `deadlineValue: item.deadline || ""` from the raw column, and
      // CasesView binds it to <input type="date">, so a demo row with a label
      // but no value opens the edit dialog with an empty date field the live
      // app would have prefilled. Year comes from the reference (ISS-2026-042).
      deadlineValue: "2026-06-21",
      transitions: [
        { id: "discipline-filed", from_step: "Intake", to_step: "Step 1", outcome: "Step 1 filed", created_at: "2026-06-08T15:00:00Z" },
        { id: "discipline-appealed", from_step: "Step 1", to_step: "Step 2", outcome: "Investigatory notes requested", created_at: "2026-06-14T15:00:00Z" },
      ],
      updates: [
        {
          id: "case-update-discipline-1",
          body: "Wrote down the supervisor's questions, who was present, and the time.",
          created_at: "2026-06-08T15:00:00Z",
        },
        {
          id: "case-update-discipline-2",
          body: "Committee reviewed the notes and planned a one-on-one follow-up.",
          created_at: "2026-06-14T15:00:00Z",
        },
      ],
    },
    {
      id: "resolved-telework",
      reference: "ISS-2026-312",
      title: "Schedule restored after a card talk",
      title_es: "Horario restablecido después de una conversación sobre tarjetas",
      deadline: "Mar 14",
      type: "Scheduling",
      status: "resolved",
      overdue: false,
      deadlineValue: "2026-03-14",
      updates: [],
    },
    {
      id: "resolved-safety",
      reference: "ISS-2025-944",
      title: "Safety equipment issued",
      deadline: "Dec 18",
      type: "Safety",
      status: "resolved",
      overdue: false,
      deadlineValue: "2025-12-18",
      updates: [],
    },
    {
      id: "resolved-scheduling",
      reference: "ISS-2025-721",
      title: "Scheduling shift corrected",
      deadline: "Oct 9",
      type: "Scheduling",
      status: "resolved",
      overdue: false,
      deadlineValue: "2025-10-09",
      updates: [],
    },
  ],
  rights: {
    selected: RIGHTS_LESSON_RECORDS[0].label,
    lessons: RIGHTS_LESSON_RECORDS.map((item) => item.label),
    lessonRecords: RIGHTS_LESSON_RECORDS,
    eyebrow: `${RIGHTS_LESSON_RECORDS[0].label} · walkthrough`,
    // The selected lesson's own four strings — one source, so the walkthrough
    // header and the Section 7 tab can never drift apart.
    title: RIGHTS_LESSON_RECORDS[0].title,
    description: RIGHTS_LESSON_RECORDS[0].description,
    steps: [...RIGHTS_LESSON_RECORDS[0].steps],
    script: RIGHTS_LESSON_RECORDS[0].script,
  },
};
