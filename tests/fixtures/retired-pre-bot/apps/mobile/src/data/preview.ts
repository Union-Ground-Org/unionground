// Historical fixture only. Never imported by the native application.
import type {
  CompassMessage,
  CompassReply,
  MemberCaseDetail,
  MemberConversationThread,
  MemberDashboard,
} from '../../../../../../../apps/mobile/src/models/member';
import { EVENT_TIME_ZONE, formatEventWhen } from '../../../../../../../apps/mobile/src/lib/deskCopy';
import { compassSourceWithDestination } from '../../../../../../../apps/mobile/src/lib/compassSourceNavigation';
import type { MemberStewardCard } from '../../../../../../../apps/mobile/src/lib/memberOrgContract';
import type { RecognitionRung } from '../lib/featureCatalog';

// Internal hat ids stay on the shared role names so role rows and gates keep
// working; each one wears an organizing identity (PREVIEW_HATS labels):
// member Worker, organizer Organizer, steward Committee, coordinator Campaign
// lead, advisor Advisor, admin Admin, vp Campaign chair.
export type PreviewHatKey = 'member' | 'organizer' | 'steward' | 'coordinator' | 'advisor' | 'admin' | 'vp';
export type PreviewShell = 'tabs' | 'swipe';

// The `chapter*` field names are the shared health contract with the live
// adapter; in this product each entry is one organizing campaign.
export type PreviewHealthChapter = {
  chapterId: string;
  chapterName: string;
  measuredOn: string | null;
  cohortProtected: boolean;
  memberCount: number | null;
  score: number | null;
  drivers: Record<string, number> | null;
  trend: { measuredOn: string; score: number }[];
  recordedAt?: string | null;
  recordedBy?: string | null;
  revisedAt?: string | null;
  revisedBy?: string | null;
  coaching: { id: string; summary: string; nextAction: string; attentionLevel: string; createdAt: string; authorName?: string }[];
};

// Harborview leads the list because the health widget reads the first
// unprotected entry, and its 184 matches the campaign snapshot's eligible
// estimate (previewCampaign.ts). Metro Dispatch is small enough that showing
// its score could point at individual dispatchers, so it stays protected.
export const PREVIEW_HEALTH_PORTFOLIO: PreviewHealthChapter[] = [
  {
    chapterId: 'preview-campaign-harborview', chapterName: 'Harborview Care United', measuredOn: '2026-08-15', cohortProtected: false, memberCount: 184, score: 74,
    drivers: { participation: 82, caseTimeliness: 71, stewardCapacity: 63, trainingCoverage: 68, communicationReach: 86, governanceReadiness: 72 },
    trend: [
      { measuredOn: '2023-09-15', score: 38 }, { measuredOn: '2023-12-15', score: 41 },
      { measuredOn: '2024-03-15', score: 45 }, { measuredOn: '2024-06-15', score: 47 },
      { measuredOn: '2024-09-15', score: 52 }, { measuredOn: '2024-12-15', score: 55 },
      { measuredOn: '2025-03-15', score: 58 }, { measuredOn: '2025-06-15', score: 61 },
      { measuredOn: '2025-09-15', score: 64 }, { measuredOn: '2025-12-15', score: 67 },
      { measuredOn: '2026-03-15', score: 70 }, { measuredOn: '2026-08-15', score: 74 },
    ],
    recordedAt: '2026-08-15T13:20:00Z', recordedBy: 'Priya Shah', revisedAt: '2026-08-16T15:45:00Z', revisedBy: 'Jordan Kim',
    coaching: [{ id: 'preview-health-note-1', summary: 'Night-shift committee coverage trails evening shift: two of fourteen committee members work nights.', nextAction: 'Pair a night-shift CNA with Maya Thompson before the September open meeting.', attentionLevel: 'support', createdAt: '2026-08-18T14:30:00Z', authorName: 'Priya Shah' }],
  },
  {
    chapterId: 'preview-campaign-north-county', chapterName: 'North County Transit Workers', measuredOn: '2026-08-15', cohortProtected: false, memberCount: 236, score: 66,
    drivers: { participation: 70, caseTimeliness: 64, stewardCapacity: 61, trainingCoverage: 59, communicationReach: 78, governanceReadiness: 64 },
    trend: [
      { measuredOn: '2024-09-15', score: 44 }, { measuredOn: '2024-12-15', score: 48 },
      { measuredOn: '2025-03-15', score: 51 }, { measuredOn: '2025-06-15', score: 55 },
      { measuredOn: '2025-09-15', score: 58 }, { measuredOn: '2025-12-15', score: 60 },
      { measuredOn: '2026-03-15', score: 63 }, { measuredOn: '2026-08-15', score: 66 },
    ],
    recordedAt: '2026-08-15T13:40:00Z', recordedBy: 'Priya Shah',
    coaching: [],
  },
  {
    chapterId: 'preview-campaign-small', chapterName: 'Metro Dispatch Committee', measuredOn: '2026-08-15', cohortProtected: true, memberCount: null, score: null, drivers: null, trend: [], coaching: [],
  },
];

export type PreviewCompassHistory = {
  threadID: string | null;
  title: string | null;
  messages: CompassMessage[];
  threads: { id: string; title: string; messages: CompassMessage[] }[];
};

export type PreviewDeskItem = {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  href?: string;
};

export type PreviewEvent = {
  id: string;
  title: string;
  // Offset-aware start instant (Eastern time, the fictional campaign's zone).
  // `when` is derived from it so a weekday can never disagree with its date
  // and every row shares one grammar on every device.
  startsAt: string;
  when: string;
  place: string;
  summary: string;
};

export type PreviewAppointment = {
  id: string;
  withName: string;
  when: string;
  place: string;
  type: string;
  status: string;
};

export type PreviewForm = {
  id: string;
  title: string;
  status: string;
  updated: string;
};

export type PreviewBallot = {
  id: string;
  title: string;
  meta: string;
  status: string;
  // Offset-aware close instant. When present, open/closed is derived from this
  // date against PREVIEW_NOW, never from a restated status string alone.
  closesAt?: string;
};

export type PreviewLesson = {
  id: string;
  title: string;
  summary: string;
  script: string;
};

export type PreviewKnowledge = {
  id: string;
  title: string;
  ref: string;
  body: string;
  keywords: string[];
};

export type PreviewTaskStatus = 'backlog' | 'to_do' | 'in_progress' | 'needs_review' | 'done';

export type PreviewTask = {
  id: string;
  taskKey: string;
  title: string;
  status: PreviewTaskStatus;
  priority: 'high' | 'medium' | 'low';
  taskType: 'general' | 'meeting_event' | 'review_approval' | 'member_follow_up' | 'document_request' | 'issue_incident';
  workstream: string;
  assignee: string | null;
  startDate: string | null;
  dueDate: string | null;
  doneAt: string | null;
  progress: number;
  blocked: boolean;
  milestone: boolean;
};

export type PreviewFieldNote = {
  id: string;
  taskId: string;
  author: string;
  when: string;
  body: string;
};

export type PreviewChapterWork = {
  tasks: PreviewTask[];
  fieldNotes: PreviewFieldNote[];
  roster: string[];
};

export type PreviewHandshake = {
  id: string;
  partnerOrgId: string;
  title: string;
  purpose: string;
  dataScope: 'docs_only' | 'no_member_data' | 'aggregate_only';
  status: 'draft' | 'requested' | 'accepted' | 'active' | 'declined' | 'closed';
  orgName: string;
  orgCity: string;
  orgState: string;
  orgAffiliation: string;
};

export type PreviewPartnerOrg = {
  id: string;
  name: string;
  city: string;
  state: string;
  affiliation: string;
};

export type PreviewChapterEntry = {
  id: string;
  name: string;
  region: string;
  current: boolean;
  memberCount: number;
  staffCount: number;
  roleLine: string;
  activity: { id: string; title: string; detail: string; dateLabel: string }[];
  sharedResources: { id: string; title: string; detail: string }[];
};

export type PreviewDesk = {
  summary: string;
  chapterName: string;
  kpis: { label: string; value: string }[];
  queue: PreviewDeskItem[];
  tasks: PreviewDeskItem[];
  events: PreviewEvent[];
  appointments: PreviewAppointment[];
  forms: PreviewForm[];
  ballots: PreviewBallot[];
  lessons: PreviewLesson[];
  workload: { id: string; dateLabel: string; meta: string }[];
  // Contributions are acknowledged, never scored: Union Ground has no
  // points, tiers or perk claims (see RECOGNITION_RUNGS in featureCatalog).
  rewards: {
    actionsYtd: number;
    totalVerified: number;
    recentVerified: number;
    currentRung: RecognitionRung;
    acknowledgements: { id: string; recognitionKind: string; sourceLabel: string; dateLabel: string }[];
  } | null;
  chapterWork: PreviewChapterWork | null;
  handshakes: PreviewHandshake[];
  partnerOrgs: PreviewPartnerOrg[];
};

export type PreviewHat = {
  key: PreviewHatKey;
  label: string;
  description: string;
};

// Fictional, in-memory authorization scope for PREVIEW features. It is
// never sent to the live catalog adapter or treated as a real tenant ID. The
// learning fixtures key their store on the same id, so changing one without
// the other would empty the preview lessons.
export const PREVIEW_ORGANIZATION_ID = 'preview-harborview-care-united';

// Canonical role nouns (b03a-3): whatever names a hat — the pill, the switch
// sheet, the VoiceOver label, and the profile role line under the greeting —
// uses the same noun. Desks keep their work noun ("Committee desk", "Issue
// queue"); only the hat itself is named from this list.
export const PREVIEW_HATS: PreviewHat[] = [
  { key: 'member', label: 'Worker', description: 'Darnell Foster · issues, meetings, and organizing rights' },
  { key: 'organizer', label: 'Organizer', description: 'Elena Cruz · one-on-ones, card drive, and campaign stage' },
  { key: 'steward', label: 'Committee', description: 'Maya Thompson · worker requests, forms review, check-ins' },
  { key: 'coordinator', label: 'Campaign lead', description: 'Andre Lewis · issue queue, assignments, follow-up dates' },
  { key: 'advisor', label: 'Advisor', description: 'Priya Shah · campaign health and recognition planning' },
  { key: 'admin', label: 'Admin', description: 'Rosa Martinez · roles, templates, two-step sign-in' },
  { key: 'vp', label: 'Campaign chair', description: 'Jordan Kim · support trend, priorities, and first-contract prep' },
]

export const PREVIEW_NOW = '2026-08-13T12:00:00.000Z';
const now = PREVIEW_NOW;
const campaign = 'Harborview Care United';
// Shared with the learning fixtures, which already scope records to 'hbv'.
const campaignCode = 'hbv';

// The contact roster keeps the shape get_member_chapter_stewards() returns so
// the finder sheet needs no preview branch. Two contacts in one campaign is
// the case the finder has to prove: each card's Contact must reach that
// person and never the other one. Direct contact is opt-in, so the committee
// member exposes none and offers only the in-app conversation.
export const PREVIEW_STEWARD_ROSTER: MemberStewardCard[] = [
  {
    id: 'preview-contact-organizer',
    name: 'Elena Cruz',
    roleLabel: 'organizer',
    chapterID: campaignCode,
    chapterLabel: campaign,
    acceptsAppointments: true,
    contact: { conversation: true, email: 'elena.cruz@example.invalid', phone: null },
  },
  {
    id: 'preview-contact-committee',
    name: 'Maya Thompson',
    roleLabel: 'committee',
    chapterID: campaignCode,
    chapterLabel: campaign,
    acceptsAppointments: false,
    contact: { conversation: true, email: null, phone: null },
  },
];

export function previewBallotIsOpen(
  ballot: Pick<PreviewBallot, 'status' | 'closesAt'>,
  clock: string = PREVIEW_NOW,
): boolean {
  if (ballot.closesAt) {
    const close = Date.parse(ballot.closesAt);
    const at = Date.parse(clock);
    return Number.isFinite(close) && Number.isFinite(at) && close > at;
  }
  return ballot.status === 'open';
}

const PREVIEW_BALLOT_OPTIONS: readonly string[] = ['Yes', 'No', 'Abstain'];

export type PreviewBallotCardState = {
  open: boolean;
  label: 'Open vote' | 'Closed';
  options: readonly string[];
  canCast: boolean;
};

export function previewBallotCardState(
  ballot: Pick<PreviewBallot, 'status' | 'closesAt'>,
  clock: string = PREVIEW_NOW,
): PreviewBallotCardState {
  const open = previewBallotIsOpen(ballot, clock);
  return {
    open,
    label: open ? 'Open vote' : 'Closed',
    options: open ? PREVIEW_BALLOT_OPTIONS : [],
    canCast: open,
  };
}

export function previewWorkDayDiff(dateValue: string, clock: string = PREVIEW_NOW): number {
  const target = new Date(`${dateValue}T12:00:00`);
  const today = new Date(`${clock.slice(0, 10)}T12:00:00`);
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((targetStart.getTime() - todayStart.getTime()) / 86_400_000);
}

export function previewWorkIsOverdue(
  task: Pick<PreviewTask, 'status' | 'dueDate'>,
  clock: string = PREVIEW_NOW,
): boolean {
  return task.status !== 'done' && task.dueDate != null && previewWorkDayDiff(task.dueDate, clock) < 0;
}

export function previewEventCheckInCode(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return 'HBV-EVENT';
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: EVENT_TIME_ZONE }).format(date).slice(0, 3).toUpperCase();
  const day = new Intl.DateTimeFormat('en-US', { day: '2-digit', timeZone: EVENT_TIME_ZONE }).format(date);
  return `HBV-${month}${day}`;
}

export function previewEventCheckInPresentation(startsAt: string, checkedIn: boolean): {
  code: string;
  checkedIn: boolean;
  actionLabel: string;
  statusLabel: string;
} {
  const code = previewEventCheckInCode(startsAt);
  return {
    code,
    checkedIn,
    actionLabel: `Check in · ${code}`,
    statusLabel: `Checked in · ${code}`,
  };
}

export function appendPreviewEventDraft(
  current: PreviewEvent[],
  input: { title: string; place: string },
  clock: string = PREVIEW_NOW,
): PreviewEvent[] {
  const title = input.title.trim();
  const place = input.place.trim();
  if (!title || !place) return current;
  const [year, month, day] = clock.slice(0, 10).split('-').map(Number);
  const startsAt = `${new Date(Date.UTC(year!, month! - 1, day! + 7)).toISOString().slice(0, 10)}T14:00:00-04:00`;
  return [
    {
      id: `authored-${current.length + 1}`,
      title,
      startsAt,
      when: formatEventWhen(startsAt, new Date(clock)),
      place,
      summary: 'Preview session draft. Not published to the campaign calendar.',
    },
    ...current,
  ];
}

export function togglePreviewEventCheckIn(current: readonly string[], eventId: string): string[] {
  return current.includes(eventId) ? [...current] : [...current, eventId];
}

function previewBallot(id: string, title: string, meta: string, closesAt: string): PreviewBallot {
  const open = previewBallotIsOpen({ status: 'open', closesAt });
  return {
    id,
    title,
    closesAt,
    status: open ? 'open' : 'closed',
    meta: open ? meta : meta.replaceAll('Closes', 'Closed'),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hat(key: PreviewHatKey): PreviewHat {
  return PREVIEW_HATS.find((item) => item.key === key) ?? PREVIEW_HATS[0]!;
}

function profile(
  id: string,
  firstName: string,
  fullName: string,
  initials: string,
  // The canonical role noun for this hat (b03a-3) — the same word the pill and
  // the switch sheet show, never a desk's work noun.
  role: string,
  memberSince: number,
): MemberDashboard['member'] {
  return {
    id,
    firstName,
    fullName,
    initials,
    roleLine: `${role} · ${campaign}`,
    memberSince,
    chapterID: campaignCode,
    language: 'en',
  };
}

// `status` stays the machine value ('active' or 'resolved') that the Work
// screen and the open-issue counts filter on; `step` carries the organizing
// word a person reads ('Listening', 'Committee review', and so on).
function caseItem(
  id: string,
  reference: string,
  title: string,
  deadline: string | null,
  caseType: string,
  step: string,
  status: string,
  updatedAt = now,
) {
  return { id, reference, title, deadline, caseType, step, status, updatedAt };
}

function notification(id: string, title: string, body: string, kind: string, readAt: string | null, createdAt = now, href?: string) {
  return { id, title, body, kind, readAt, createdAt, href };
}

function conversation(
  id: string,
  title: string,
  initials: string,
  latestMessage: string,
  unreadCount: number,
  updatedAt = now,
  counterpartRole?: 'steward',
  stewardUserId?: string,
) {
  return { id, counterpartRole, stewardUserId, title, initials, createdAt: updatedAt, updatedAt, unreadCount, latestMessage };
}

// An authored multi-turn thread (owner feedback 2026-08-25: "messages should
// be much more involved"). The script is [senderKind, senderName, body,
// createdAt][]; the conversation summary derives from the last line so the
// inbox preview and the thread can never disagree.
type StorylineLine = readonly [senderKind: 'member' | 'steward', senderName: string, body: string, createdAt: string];

function storylineThread(
  id: string,
  title: string,
  initials: string,
  unreadCount: number,
  script: readonly StorylineLine[],
) {
  const last = script[script.length - 1]!;
  const summary = conversation(id, title, initials, last[2], unreadCount, last[3]);
  const messages = script.map(([senderKind, senderName, body, createdAt], index) => ({
    id: `${id}-m${String(index + 1).padStart(2, '0')}`,
    conversationID: id,
    senderKind,
    senderName,
    body,
    readAt: unreadCount > 0 && index >= script.length - unreadCount ? null : createdAt,
    createdAt,
  }));
  return { summary, lookup: { conversation: summary, messages } };
}

// Campaign activity: four years of dated campaign history for the Home feed
// (owner feedback 2026-08-25: at least two pages of seeded content). Fully
// deterministic — a fixed-seed PRNG over fixed month tables, nothing reads
// the wall clock.
export type PreviewActivityItem = {
  id: string;
  kind: 'broadcast' | 'event' | 'ballot';
  title: string;
  detail: string;
  when: string;
  attended?: boolean;
};

const ACTIVITY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const ACTIVITY_TOPICS = [
  'card drive update', 'one-on-one count', 'overnight staffing log', 'committee coverage by shift',
  'house-visit training recap', 'open meeting agenda', 'organizing rights refresher', 'schedule notice survey',
] as const;
const ACTIVITY_POLLS = [
  'open meeting night', 'campaign priorities', 'listening session format',
  'translation needs', 'next delegation topic',
] as const;
const ACTIVITY_EVENTS = [
  ['Committee meeting', 'Harbor Street library · Room B'],
  ['House-visit training', 'Community center · 41 Pier Rd'],
  ['Open meeting', 'Harbor Street library + video call'],
  ['After-shift check-in', 'Diner across from the main entrance'],
  ['Listening session', 'Community center · Room 2'],
] as const;

export const PREVIEW_CHAPTER_ACTIVITY: PreviewActivityItem[] = (() => {
  // 184 eligible, 119 cards: any fixed value works; this one is easy to trace
  // back to the campaign snapshot.
  let state = 184119 >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const items: PreviewActivityItem[] = [];
  // Anchor month: August 2026 (the fixture "now"), walking backwards ~44
  // months so the feed reaches the 2023 edge of the rolling history.
  for (let back = 0; back < 44; back += 1) {
    const totalMonths = 2026 * 12 + 7 - back;
    const year = Math.floor(totalMonths / 12);
    const monthIndex = totalMonths % 12;
    const label = (day: number) => `${ACTIVITY_MONTHS[monthIndex]} ${day}${year === 2026 ? '' : `, ${year}`}`;
    items.push({
      id: `activity-bc-${back}-a`,
      kind: 'broadcast',
      title: `${campaign} weekly: ${pick(ACTIVITY_TOPICS)}`,
      detail: 'Campaign update',
      when: label(3 + Math.floor(next() * 10)),
    });
    items.push({
      id: `activity-bc-${back}-b`,
      kind: 'broadcast',
      title: `${campaign} weekly: ${pick(ACTIVITY_TOPICS)}`,
      detail: 'Campaign update',
      when: label(14 + Math.floor(next() * 10)),
    });
    const [eventTitle, place] = pick(ACTIVITY_EVENTS);
    items.push({
      id: `activity-evt-${back}`,
      kind: 'event',
      title: eventTitle,
      detail: place,
      when: label(10 + Math.floor(next() * 15)),
      attended: next() < 0.62,
    });
    if (back % 3 === 2) {
      // Committee polls only. Response counts stay under the 151 coworkers
      // reached, so no poll claims more voices than the campaign has.
      items.push({
        id: `activity-bal-${back}`,
        kind: 'ballot',
        title: `Committee poll: ${pick(ACTIVITY_POLLS)}`,
        detail: `${20 + Math.floor(next() * 120)} responses`,
        when: label(20 + Math.floor(next() * 8)),
      });
    }
  }
  return items;
})();

// Every Guide answer ends by pointing at people who can look at the facts.
// The guides describe organizing in general terms; they never say what the
// law requires for the reader's own situation.
const QUALIFIED_HELP = 'For your own situation, talk with your organizer, who can connect you with a qualified labor lawyer.';

// Order matters: the Guide answers from the first article whose keyword
// appears, so narrower topics sit before broader ones.
export const PREVIEW_KNOWLEDGE: PreviewKnowledge[] = [
  {
    id: 'talking-with-coworkers',
    title: 'Talking with coworkers about the campaign',
    ref: 'PSG guide · Talking with coworkers',
    body: 'Many workers talk about pay, schedules and organizing on non-work time: breaks, meals, and before or after a shift, away from resident care. The NLRB’s public “Your Rights” pages describe protections for this kind of conversation in general terms. Whether and how they apply to you depends on your employer, your job and the facts.',
    keywords: ['talk', 'coworker', 'break', 'non-work', 'lunch', 'conversation'],
  },
  {
    id: 'acting-together',
    title: 'Acting together on a workplace issue',
    ref: 'NLRB public page · Concerted activity (general information)',
    body: 'When two or more coworkers raise an issue together — a petition about overnight staffing, a group asking for posted schedules, a delegation to the administrator — the NLRB’s public page on concerted activity describes this kind of group action in general terms. The committee helps plan who speaks, what you ask for, and how to keep everyone together.',
    keywords: ['together', 'concerted', 'petition', 'delegation', 'group'],
  },
  {
    id: 'write-it-down',
    title: 'Write down what you saw',
    ref: 'PSG guide · Keeping notes',
    body: 'Write it down the same day: the date, time and unit, who was there, the exact words used, and what happened next. If your schedule changed after a meeting, write that down too. Keep your copy at home, not on a work phone or work email, and share it only with the committee. Your notes are facts, not a conclusion about the law.',
    keywords: ['write', 'notes', 'document', 'record', 'supervisor', 'retaliation', 'schedule'],
  },
  {
    id: 'keep-the-list-private',
    title: 'Keeping the worker list private',
    ref: 'PSG guide · Protecting the list',
    body: 'The committee never shares who has signed a card, who came to a meeting, or who is on the committee. Contact details stay in the committee workspace, never in group chats, on work devices, or on a public page. If someone asks who is involved, offer to connect them with an organizer instead.',
    keywords: ['list', 'private', 'names', 'contact', 'share', 'privacy', 'who signed'],
  },
  {
    id: 'cards-and-recognition',
    title: 'What signing a card means',
    ref: 'PSG guide · Cards and recognition',
    body: 'A signed card shows that you support forming a union. A card majority is not certification: recognition comes either voluntarily from the employer or through an election, and those are separate paths. Bargaining a first contract starts only after the union is recognized or certified.',
    keywords: ['card', 'sign', 'recognition', 'election', 'majority', 'certif', 'contract'],
  },
];

const organizingLessons: PreviewLesson[] = [
  { id: 'talk-on-break', title: 'Talking on non-work time', summary: 'Use this when a coworker asks whether it is okay to talk about the campaign during a break.', script: 'I talk about the campaign on my break and after my shift, not while I am with residents. You can say no, and I will not bring it up again.' },
  { id: 'acting-together', title: 'Acting together', summary: 'Use this before a group of coworkers raises an issue with a supervisor together.', script: 'We are coworkers from the evening and night shifts raising this together. We want to talk about overnight staffing, and we are asking for a written answer.' },
  { id: 'write-it-down', title: 'Write down what you saw', summary: 'Use this right after something happens on the floor that the committee should know about.', script: 'Date, time and unit. Who was there. What was said, in their words. What happened next. I keep this copy at home and share it with the committee only.' },
  { id: 'keep-the-list-private', title: 'Keep the list private', summary: 'Use this when someone asks who has signed a card or who is on the committee.', script: 'I do not share who has signed or who is involved. If you want to know more about the campaign, I can connect you with an organizer.' },
  { id: 'manager-asks', title: 'If a manager asks about the campaign', summary: 'Use this when a supervisor asks you about meetings. Then write down what happened and bring it to an organizer.', script: 'I would rather not talk about that right now. I need to get back to my residents.' },
];

function campaignEvent(id: string, title: string, startsAt: string, place: string, summary: string): PreviewEvent {
  return { id, title, startsAt, when: formatEventWhen(startsAt, new Date(now)), place, summary };
}

const campaignEvents: PreviewEvent[] = [
  campaignEvent('evt-demo', 'August committee meeting', '2026-08-30T14:00:00-04:00', 'Harbor Street library · Room B', 'Committee coverage by shift, one-on-one follow-ups, and the open-meeting night poll.'),
  campaignEvent('evt-history-demo', 'July open meeting', '2026-07-30T14:00:00-04:00', 'Harbor Street library + video call', 'Coworkers ranked campaign priorities and heard the delegation plan for overnight staffing.'),
];

const houseVisitTraining = campaignEvent('evt-house-visit', 'House-visit training', '2026-08-22T10:00:00-04:00', 'Community center · 41 Pier Rd', 'Role-play first visits, stay safe on the doorstep, and keep names out of shared notes.');
const staffingDelegation = campaignEvent('evt-delegation', 'Delegation on overnight staffing', '2026-08-27T15:30:00-04:00', 'Administrator’s office · main building', 'Coworkers from evening and night shift deliver the staffing petition together.');
const leadershipMeeting = campaignEvent('evt-campaign-board', 'Campaign leadership meeting', '2025-07-24T18:00:00-04:00', 'Harbor Street library · Room B', 'Issue queue review, committee vacancies, and delegation planning.');

// Mirrors the desktop demo board fixture (campaign "hbv", tasks HBV-1..HBV-8):
// every status, both flags, one undated task, and one blocked task.
function campaignTask(
  id: string,
  taskKey: string,
  title: string,
  status: PreviewTaskStatus,
  priority: PreviewTask['priority'],
  taskType: PreviewTask['taskType'],
  workstream: string,
  assignee: string | null,
  startDate: string | null,
  dueDate: string | null,
  doneAt: string | null,
  progress: number,
  blocked = false,
  milestone = false,
): PreviewTask {
  return { id, taskKey, title, status, priority, taskType, workstream, assignee, startDate, dueDate, doneAt, progress, blocked, milestone };
}

const campaignWorkFixture: PreviewChapterWork = {
  roster: ['Elena Cruz', 'Maya Thompson', 'Andre Lewis', 'Tomás Reyes'],
  tasks: [
    campaignTask('task-hbv-1', 'HBV-1', 'Prepare August committee meeting', 'backlog', 'high', 'meeting_event', 'Committee', 'Andre Lewis', '2026-07-28', '2026-08-24', null, 40, false, true),
    campaignTask('task-hbv-2', 'HBV-2', 'Translate open-meeting flyer into Spanish', 'to_do', 'medium', 'document_request', 'Communications', 'Maya Thompson', null, null, null, 0),
    campaignTask('task-hbv-3', 'HBV-3', 'Follow up evening-shift first conversations', 'in_progress', 'high', 'member_follow_up', 'Outreach', 'Elena Cruz', '2026-08-10', '2026-08-21', null, 50),
    campaignTask('task-hbv-4', 'HBV-4', 'Map the night-shift floor on 4 East', 'in_progress', 'high', 'issue_incident', 'Mapping', 'Tomás Reyes', '2026-08-03', '2026-08-10', null, 20, true),
    campaignTask('task-hbv-5', 'HBV-5', 'Review staffing petition wording', 'needs_review', 'medium', 'review_approval', 'Delegation', 'Maya Thompson', '2026-08-11', '2026-08-18', null, 80, false, true),
    campaignTask('task-hbv-6', 'HBV-6', 'Approve house-visit safety checklist', 'needs_review', 'low', 'review_approval', 'Training', null, '2026-08-12', '2026-09-05', null, 60),
    campaignTask('task-hbv-7', 'HBV-7', 'Publish campaign priorities poll', 'done', 'medium', 'general', 'Committee', 'Andre Lewis', '2026-07-20', '2026-07-28', '2026-07-30', 100, false, true),
    campaignTask('task-hbv-8', 'HBV-8', 'Update committee coverage by shift', 'done', 'low', 'general', 'Committee', 'Elena Cruz', '2026-08-01', '2026-08-08', '2026-08-06', 100),
  ],
  fieldNotes: [
    { id: 'note-demo-1', taskId: 'task-hbv-4', author: 'Tomás Reyes', when: 'Aug 12, 2026', body: 'Night shift on 4 East has 23 coworkers and we have mapped 17. @Maya Thompson knows the two float CNAs who cover weekends.' },
    { id: 'note-demo-2', taskId: 'task-hbv-3', author: 'Elena Cruz', when: 'Aug 14, 2026', body: 'Eight first conversations after evening handoff. Best window is 11:15 PM in the parking lot; staffing came up in every one.' },
  ],
};

// Mirrors fallbackData.product.handshakes and partnerOrgs: sister campaigns
// trade training material, never worker names, and the one handshake stays
// at "requested" (the only shipped state).
const handshakeFixtures: PreviewHandshake[] = [
  {
    id: 'handshake-demo-1',
    partnerOrgId: 'partner-demo-1',
    title: 'Shared house-visit training',
    purpose: 'Swap house-visit role-plays and meeting templates with a sister campaign. No worker names or lists.',
    dataScope: 'docs_only',
    status: 'requested',
    orgName: 'North County Transit Workers',
    orgCity: 'North County',
    orgState: 'MA',
    orgAffiliation: 'Independent organizing committee',
  },
];

const partnerOrgFixtures: PreviewPartnerOrg[] = [
  { id: 'partner-demo-1', name: 'North County Transit Workers', city: 'North County', state: 'MA', affiliation: 'Independent organizing committee' },
  { id: 'partner-demo-2', name: 'Metro Dispatch Committee', city: 'Metro', state: 'MA', affiliation: 'Independent organizing committee' },
];

// Mirrors the desktop campaign rail: every visible campaign carries a
// populated landing archive plus shared resources. All rows are aggregate or
// public-by-design; no worker-level record crosses a campaign boundary.
const CAMPAIGN_ACTIVITY = [
  ['Campaign update posted', 'Aggregate conversation and card-drive totals, no names', 'Aug 20'],
  ['Committee meeting recap shared', 'Decisions, turnout, and assigned follow-ups', 'Aug 13'],
  ['One-on-one times opened', 'Private times with an organizer are available', 'Aug 6'],
  ['Staffing log summary posted', 'Aggregate short-staffing counts by shift', 'Jul 29'],
  ['Card drive milestone', 'Campaign-wide total and next action', 'Jul 22'],
  ['House-visit training scheduled', 'Agenda, location, and accessibility details', 'Jul 15'],
  ['Quarterly participation briefing', 'Privacy-bounded trends for the campaign', 'Jun 30'],
  ['Issue wins recap', 'Resolved issues without coworker details', 'Jun 12'],
] as const;
const SHARED_RESOURCES = [
  ['Organizing calendar', 'Meeting and training dates for every partner campaign'],
  ['House-visit training library', 'Role-plays, scripts, and safety checklists shared across campaigns'],
  ['Organizing rights guide', 'Plain-language PSG guides with links to public NLRB pages'],
  ['New committee member kit', 'First-week checklist with campaign contacts kept separate'],
] as const;
function previewCampaignEntry(
  id: string,
  name: string,
  region: string,
  current: boolean,
  memberCount: number,
  staffCount: number,
  roleLine: string,
): PreviewChapterEntry {
  return {
    id, name, region, current, memberCount, staffCount, roleLine,
    activity: CAMPAIGN_ACTIVITY.map(([title, detail, dateLabel], index) => ({ id: `${id}-activity-${index + 1}`, title, detail, dateLabel })),
    sharedResources: SHARED_RESOURCES.map(([title, detail], index) => ({ id: `${id}-shared-${index + 1}`, title, detail })),
  };
}
// memberCount is the eligible-worker estimate; Harborview's 184 and 14
// committee members match the campaign snapshot.
export const PREVIEW_CHAPTERS: PreviewChapterEntry[] = [
  previewCampaignEntry(campaignCode, campaign, 'Fictional Harborview Care · evening, night, CNAs, dietary, housekeeping, rehab', true, 184, 20, '14 committee · 2 organizers · 1 campaign lead · 1 advisor · 1 admin · 1 campaign chair'),
  previewCampaignEntry('nct', 'North County Transit Workers', 'Bus operators and mechanics · North County', false, 236, 18, '16 committee · 1 organizer · 1 campaign lead'),
  previewCampaignEntry('mdc', 'Metro Dispatch Committee', 'Emergency dispatchers · Metro', false, 58, 8, '7 committee · 1 organizer'),
];

const staffCampaignFeatures = {
  chapterWork: campaignWorkFixture,
  handshakes: handshakeFixtures,
  partnerOrgs: partnerOrgFixtures,
};

const workerCampaignFeatures = {
  chapterWork: null,
  handshakes: handshakeFixtures,
  partnerOrgs: partnerOrgFixtures,
};

type PreviewBundle = {
  dashboard: MemberDashboard;
  desk: PreviewDesk;
  cases: Record<string, MemberCaseDetail>;
  conversations: Record<string, MemberConversationThread>;
};

const memberCaseId = 'b872b7c3-fdf2-497e-9d91-5b456724a1f0';
const memberBreakRoomId = 'a872b7c3-fdf2-497e-9d91-5b456724a1f1';
const memberLiftId = 'a872b7c3-fdf2-497e-9d91-5b456724a1f2';
const memberHolidayId = 'a872b7c3-fdf2-497e-9d91-5b456724a1f3';
const memberScheduleId = 'a872b7c3-fdf2-497e-9d91-5b456724a1f4';
const memberThreadId = 'bfd2c08d-384c-4fd1-85e1-5a746ccd63b7';
const memberThreadTwoId = 'de22135f-f0a9-47ac-a574-13faa786c049';

const memberCase = caseItem(memberCaseId, 'HCU-104', 'Overnight staffing on 3 West', '2026-08-27', 'Staffing', 'Delegation scheduled', 'active', '2026-07-12T14:00:00.000Z');
const memberBreakRoom = caseItem(memberBreakRoomId, 'HCU-087', 'Night-shift break room reopened', '2026-03-14', 'Breaks', 'Resolved', 'resolved', '2026-03-14T17:00:00.000Z');
const memberLift = caseItem(memberLiftId, 'HCU-052', 'Broken lift on 3 West replaced', '2025-12-18', 'Equipment', 'Resolved', 'resolved', '2025-12-18T17:00:00.000Z');
const memberHoliday = caseItem(memberHolidayId, 'HCU-041', 'Holiday schedule posted on time', '2025-10-09', 'Scheduling', 'Resolved', 'resolved', '2025-10-09T17:00:00.000Z');
const memberSchedule = caseItem(memberScheduleId, 'HCU-131', 'Schedule changed without notice', '2026-08-28', 'Scheduling', 'Listening', 'active', '2026-08-12T16:00:00.000Z');

const memberThreadOneLatest = 'The committee voted to plan a delegation on overnight staffing. Would you be one of the speakers?';
const memberThreadTwoLatest = 'Bring the last two posted schedules on Thursday so we can see when each change went up.';

// --- Authored storyline threads (2026-08-25 involved-messages wave). ---
// Worker side: three settled arcs with named committee members, all read
// (the KPI-counted unread thread stays the organizer note above).
const memberOvertimeThread = storylineThread('c1af3d02-91b4-4c2e-8a67-2f4f5f0a1101', 'Keisha Grant', 'KG', 0, [
  ['member', 'Darnell Foster', 'Got mandated to stay past 11 again last night. That is the fourth time this month on evening shift.', '2026-05-04T15:20:00.000Z'],
  ['steward', 'Keisha Grant', 'You are not the only one. Three other CNAs on 3 West said the same at the after-shift check-in. Are you writing down the dates?', '2026-05-04T18:05:00.000Z'],
  ['member', 'Darnell Foster', 'I have four dates, the hours I stayed, and who else got held over. Sandra signed up for extra shifts and never got called.', '2026-05-05T12:40:00.000Z'],
  ['steward', 'Keisha Grant', 'That is useful. The committee is putting everyone’s dates on one sheet so we can show the pattern without anyone standing alone.', '2026-05-07T16:30:00.000Z'],
  ['steward', 'Keisha Grant', 'Twelve of us asked together at the Tuesday huddle: post a volunteer list first and use it before anyone is mandated.', '2026-05-08T10:15:00.000Z'],
  ['member', 'Darnell Foster', 'I was there. The unit manager said she would take it to the administrator.', '2026-05-08T13:00:00.000Z'],
  ['steward', 'Keisha Grant', 'Update: the volunteer list went up on 3 West this morning. Keep logging mandates so we know if it holds.', '2026-05-14T17:45:00.000Z'],
]);
const memberLiftThread = storylineThread('c1af3d02-91b4-4c2e-8a67-2f4f5f0a1102', 'Maya Thompson', 'MT', 0, [
  ['member', 'Darnell Foster', 'The sit-to-stand lift on 3 West is broken again. We are doing transfers with two people and no lift.', '2025-11-10T07:50:00.000Z'],
  ['steward', 'Maya Thompson', 'Thank you for telling me. Can you take a photo of the out-of-service tag and write down the date and which transfers you did without it?', '2025-11-10T12:20:00.000Z'],
  ['member', 'Darnell Foster', 'Photo taken. The night lead says she reported it in October and nothing happened.', '2025-11-11T08:05:00.000Z'],
  ['steward', 'Maya Thompson', 'The committee is collecting the same from days and nights so it is everyone’s issue, not one person’s complaint. I logged it as HCU-052.', '2025-11-11T15:30:00.000Z'],
  ['member', 'Darnell Foster', 'Should we do anything in the meantime? Two people already hurt their backs this fall.', '2025-11-12T21:10:00.000Z'],
  ['steward', 'Maya Thompson', 'Keep asking for help on every transfer and keep writing it down. Twenty coworkers signed the note to the unit manager asking for a repair date.', '2025-11-12T21:40:00.000Z'],
  ['steward', 'Maya Thompson', 'Good news: a new lift arrives the week of December 15, with a loaner from rehab until then.', '2025-12-10T18:00:00.000Z'],
  ['member', 'Darnell Foster', 'The new lift is on the floor. Night shift says thank you.', '2025-12-18T08:30:00.000Z'],
]);
const memberBreaksThread = storylineThread('c1af3d02-91b4-4c2e-8a67-2f4f5f0a1103', 'Luis Ortega', 'LO', 0, [
  ['member', 'Darnell Foster', 'The break room on nights has been locked since January. We eat standing at the nurses’ station.', '2026-02-02T13:10:00.000Z'],
  ['steward', 'Luis Ortega', 'Same in dietary. How many nights this month did you get a full break?', '2026-02-02T16:45:00.000Z'],
  ['member', 'Darnell Foster', 'Two out of nine. I wrote down each night and how long I actually got.', '2026-02-03T09:20:00.000Z'],
  ['steward', 'Luis Ortega', 'Housekeeping says the same. The committee wants to ask together at the March huddle: unlock the room and cover breaks.', '2026-02-03T11:00:00.000Z'],
  ['steward', 'Luis Ortega', 'Twelve of us went in together this morning. The administrator said she would look into it by Friday.', '2026-03-05T15:30:00.000Z'],
  ['member', 'Darnell Foster', 'The room was unlocked when I came in tonight.', '2026-03-11T18:05:00.000Z'],
  ['steward', 'Luis Ortega', 'Great. Keep logging breaks for two more weeks so we know it sticks.', '2026-03-11T19:00:00.000Z'],
  ['member', 'Darnell Foster', 'Two weeks of full breaks. I gave my log to Maya for the committee.', '2026-03-14T17:20:00.000Z'],
]);

// Committee side: the two live intake threads carry their whole arcs. The
// render convention puts senderKind "member" on the wearer's side, so the
// coworker speaks as "steward" here (same as the derived lookups).
const committeeMillsThread = storylineThread('d4444444-4444-4444-8444-444444444441', 'Jordan Mills', 'JM', 1, [
  ['steward', 'Jordan Mills', 'My supervisor put a meeting about “scheduling” on my calendar for Thursday. That was two days after I spoke up at the huddle.', '2026-08-11T15:40:00.000Z'],
  ['member', 'Maya Thompson', 'Thanks for telling me. Write down the day you spoke up, what you said, and when the invite came. Keep it at home, not on a work phone.', '2026-08-11T17:25:00.000Z'],
  ['steward', 'Jordan Mills', 'Done. Shonda was at the huddle and heard what I said, so she can back up the date.', '2026-08-12T09:10:00.000Z'],
  ['member', 'Maya Thompson', 'Good. I logged this as HCU-142 for Thursday’s committee review, and Elena can do a one-on-one with you before the meeting.', '2026-08-12T11:35:00.000Z'],
  ['member', 'Maya Thompson', 'If you have a question about your rights in that meeting, Elena can connect you with a qualified labor lawyer. The committee will not guess.', '2026-08-12T11:38:00.000Z'],
  ['steward', 'Jordan Mills', 'Yes to the one-on-one. The meeting is still on for Thursday and they will not say what it is about.', '2026-08-13T11:12:00.000Z'],
]);
const committeeRamosThread = storylineThread('d4444444-4444-4444-8444-444444444442', 'Ava Ramos', 'AR', 1, [
  ['steward', 'Ava Ramos', 'After the huddle the charge nurse said “people who go to those meetings get the worst shifts.” Should I write that down?', '2026-07-17T14:05:00.000Z'],
  ['member', 'Maya Thompson', 'Yes. Write the exact words, the date, the time, and who else was there. Facts only, no conclusions.', '2026-07-17T15:30:00.000Z'],
  ['steward', 'Ava Ramos', 'Done. Two other CNAs were at the station. I did not say anything back.', '2026-07-18T10:20:00.000Z'],
  ['member', 'Maya Thompson', 'That was a good call. I will bring the note to committee review without your name unless you say it is okay.', '2026-07-18T12:10:00.000Z'],
  ['member', 'Maya Thompson', 'Elena will go over it with Priya, our advisor, and point you to qualified help if you want it.', '2026-07-19T09:45:00.000Z'],
  ['steward', 'Ava Ramos', 'Okay to use my name. I will keep my notes and tell you if my schedule changes.', '2026-07-20T19:02:00.000Z'],
]);

// Organizer side: a first conversation still in progress and the committee
// coverage thread, both authored end to end.
const organizerLiuThread = storylineThread('d5555555-5555-4555-8555-555555555551', 'Grace Liu', 'GL', 1, [
  ['steward', 'Grace Liu', 'Maya said you wanted to talk. I am new on nights in dietary and I do not really know what the campaign is.', '2026-08-10T22:15:00.000Z'],
  ['member', 'Elena Cruz', 'Thanks for reaching out, and no pressure at all. What is the hardest part of nights in dietary right now?', '2026-08-10T23:02:00.000Z'],
  ['steward', 'Grace Liu', 'Our breaks get cut short almost every night. Trays go out late and we eat standing up.', '2026-08-11T21:40:00.000Z'],
  ['member', 'Elena Cruz', 'You are not the only one saying that. Coworkers in dietary started writing down their break times. Want to see what they found?', '2026-08-11T22:05:00.000Z'],
  ['member', 'Elena Cruz', 'We could meet before your shift Wednesday at the diner, off site and on your own time. I will bring the break-log summary, with no names on it.', '2026-08-11T22:07:00.000Z'],
  ['steward', 'Grace Liu', 'Wednesday at 9:30 works. Can my coworker Ruth come too?', '2026-08-12T23:05:00.000Z'],
]);
const organizerCoverageThread = storylineThread('d5555555-5555-4555-8555-555555555552', 'Maya Thompson', 'MT', 0, [
  ['steward', 'Maya Thompson', 'Coverage check: evening shift has seven of us on the committee, days five, nights only two.', '2026-08-05T16:10:00.000Z'],
  ['member', 'Elena Cruz', 'Nights is the gap. Which units on nights have nobody?', '2026-08-05T17:00:00.000Z'],
  ['steward', 'Maya Thompson', '4 East and dietary. Tomás is mapping 4 East this week.', '2026-08-05T17:22:00.000Z'],
  ['member', 'Elena Cruz', 'Two coworkers suggested the same 4 East CNA. I will ask her for a one-on-one after the house-visit training.', '2026-08-06T09:15:00.000Z'],
  ['steward', 'Maya Thompson', 'And Grace Liu on dietary nights reached out to me. She seems ready to talk.', '2026-08-08T20:40:00.000Z'],
  ['member', 'Elena Cruz', 'Perfect. I will meet Grace Wednesday and update the coverage map after.', '2026-08-09T10:30:00.000Z'],
]);

const bundles: Record<PreviewHatKey, PreviewBundle> = {
  member: {
    dashboard: {
      member: profile('11111111-1111-4111-8111-111111111111', 'Darnell', 'Darnell Foster', 'DF', 'Worker', 2023),
      notifications: [
        notification('22222222-2222-4222-8222-222222222201', 'Committee poll closes Thursday', 'Vote on holding the September open meeting on a Thursday night before 7:59 PM.', 'vote', null, '2026-08-12T13:00:00.000Z', '/feature/voting'),
        notification('22222222-2222-4222-8222-222222222202', 'Delegation date set', 'Coworkers deliver the overnight staffing petition on Thursday, Aug 27. HCU-104 has the plan.', 'case', null, '2026-08-12T10:00:00.000Z', `/issue/${memberCaseId}`),
        notification('22222222-2222-4222-8222-222222222203', 'One-on-one times moved', 'Elena Cruz now holds one-on-ones on Wednesday afternoons at the library and by video call.', 'chapter', now, '2026-08-11T14:00:00.000Z', '/feature/appointments'),
        notification('22222222-2222-4222-8222-222222222204', 'New campaign update', 'The August Harborview Care United update is posted: 151 coworkers reached and the next open meeting.', 'chapter', '2026-08-11T15:00:00.000Z', '2026-08-10T14:00:00.000Z', '/feature/chapter'),
        notification('22222222-2222-4222-8222-222222222205', 'One-on-one confirmed', 'One-on-one with Elena Cruz, Wed Aug 19, Harbor Street library · Room B.', 'appointment', '2026-08-08T12:00:00.000Z', '2026-08-07T18:00:00.000Z', '/feature/appointments'),
      ],
      cases: [memberCase, memberSchedule, memberBreakRoom, memberLift, memberHoliday],
      conversations: [
        // Bound to the organizer on the preview roster, so the contact finder
        // shows both branches: the organizer opens this thread, and the
        // committee contact has none yet and opens Messages to start one.
        conversation(memberThreadId, 'Elena Cruz', 'EC', memberThreadOneLatest, 1, '2026-07-12T14:00:00.000Z', 'steward', PREVIEW_STEWARD_ROSTER[0]?.id),
        conversation(memberThreadTwoId, 'Committee (private)', 'CM', memberThreadTwoLatest, 0, '2026-06-28T14:00:00.000Z'),
        memberBreaksThread.summary,
        memberOvertimeThread.summary,
        memberLiftThread.summary,
      ],
      weeklyActions: [
        { actionKey: 'demo-rights-1', actionKind: 'rights', occurredAt: '2026-08-11T19:30:00.000Z' },
        { actionKey: 'demo-message-1', actionKind: 'message', occurredAt: '2026-08-12T13:20:00.000Z' },
        { actionKey: 'demo-form-1', actionKind: 'form', occurredAt: '2026-08-06T16:12:00.000Z' },
        { actionKey: 'demo-checkin-1', actionKind: 'checkin', occurredAt: '2026-08-04T23:10:00.000Z' },
      ],
    },
    desk: {
      summary: 'Your overnight staffing issue has a delegation date, a committee poll closes Thursday, and Elena Cruz left you an unread note.',
      chapterName: campaign,
      // b04b-1: these three restate numbers `dashboardMetrics` computes from
      // the records above, so they have to agree with them. "Open cases" keeps
      // the label My reports computes under; renaming it here alone would print
      // the same count twice under two names.
      kpis: [
        { label: 'Open issues', value: '2' },
        { label: 'Unread updates', value: '2' },
        { label: 'Unread messages', value: '1' },
      ],
      queue: [
        { id: memberCaseId, title: 'HCU-104 · Overnight staffing on 3 West', subtitle: 'Delegation scheduled · Thu Aug 27 · Elena Cruz / Maya Thompson', status: 'due soon', href: `/issue/${memberCaseId}` },
        { id: memberScheduleId, title: 'HCU-131 · Schedule changed without notice', subtitle: 'Listening · Jul 14 change posted with no notice', status: 'active', href: `/issue/${memberScheduleId}` },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21', title: 'Vote in the open-meeting night poll', subtitle: 'Closes Thu · 7:59 PM', status: 'open' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22', title: 'Finish the organizing rights lessons', subtitle: '3 of 5 lessons remaining', status: 'in progress' },
      ],
      events: campaignEvents,
      appointments: [
        { id: 'appt-demo-1', withName: 'Elena Cruz', when: 'Wed, Aug 19 · 3:00–3:30 PM', place: 'Harbor Street library · Room B', type: 'One-on-one', status: 'confirmed' },
        { id: 'appt-demo-2', withName: 'Elena Cruz', when: 'Tue, Jul 14 · 11:00–11:20 AM', place: 'Video call', type: 'First one-on-one', status: 'completed' },
      ],
      forms: [
        { id: 'form-demo-1', title: 'Issue report · schedule changed without notice', status: 'draft', updated: 'Jul 14' },
        { id: 'form-demo-2', title: 'Staffing log · July nights', status: 'submitted', updated: 'Jul 7' },
        { id: 'form-demo-3', title: 'Delegation speaker sign-up', status: 'draft', updated: 'Jul 17' },
      ],
      workload: [
        { id: 'wl-demo-1', dateLabel: 'Tue, Aug 12', meta: '8.0 hrs · night shift · 3 West · two CNAs on the floor' },
        { id: 'wl-demo-2', dateLabel: 'Mon, Aug 11', meta: '8.0 hrs · evening shift · 3 West' },
        { id: 'wl-demo-3', dateLabel: 'Sat, Aug 9', meta: '12.0 hrs · weekend · mandated overtime' },
      ],
      rewards: {
        actionsYtd: 27,
        totalVerified: 8,
        recentVerified: 3,
        currentRung: 'organize',
        acknowledgements: [
          { id: 'recognition-demo-1', recognitionKind: 'training_complete', sourceLabel: 'Organizing foundations', dateLabel: 'Jul 20, 2026' },
          { id: 'recognition-demo-2', recognitionKind: 'peer_outreach_complete', sourceLabel: 'New-coworker welcome calls', dateLabel: 'Jul 18, 2026' },
        ],
      },
      ballots: [
        // Committee votes and polls only. The first is open at PREVIEW_NOW
        // (Aug 13), so the worker preview reaches a selectable ballot and its
        // cast control; the three below are closed. The ids are the ones the
        // ballot-clock tests already pin.
        previewBallot('ballot-overtime-2026', 'Hold the September open meeting on a Thursday night', 'Closes Thu, Aug 20 · 7:59 PM', '2026-08-20T19:59:00-04:00'),
        previewBallot('ballot-2026', 'Make safe overnight staffing the top campaign priority', 'Closes Tue, Jul 21 · 7:59 PM', '2026-07-21T19:59:00-04:00'),
        previewBallot('ballot-2025', 'Go public with the campaign this fall', 'Closed Jun 26 · 142 votes · receipt K7TQ2MRX', '2026-06-26T19:59:00-04:00'),
        previewBallot('pulse-new-members', 'Would a buddy for coworkers new to the campaign help?', '2-min pulse · Closes Jul 24', '2026-07-24T19:59:00-04:00'),
      ],
      lessons: organizingLessons,
      ...workerCampaignFeatures,
    },
    cases: {
      [memberCaseId]: {
        item: memberCase,
        updates: [
          { id: '55555555-5555-4555-8555-555555555501', caseID: memberCaseId, body: 'Listening: coworkers on 3 West logged eleven night shifts in April with two CNAs for the whole unit. Darnell kept the dates and who was on, at home.', createdAt: '2026-05-03T14:00:00.000Z' },
          { id: '55555555-5555-4555-8555-555555555502', caseID: memberCaseId, body: 'Committee review: staffing logs from evening and night shift match. The committee chose a petition and a delegation over one person raising it alone.', createdAt: '2026-05-22T16:10:00.000Z' },
          { id: '55555555-5555-4555-8555-555555555503', caseID: memberCaseId, body: 'Delegation scheduled: 61 coworkers signed the staffing petition. Elena Cruz and Maya Thompson are lining up speakers for Thursday, Aug 27.', createdAt: '2026-07-12T14:00:00.000Z' },
        ],
      },
      [memberScheduleId]: {
        item: memberSchedule,
        updates: [
          { id: '55555555-5555-4555-8555-555555555511', caseID: memberScheduleId, body: 'Listening: the Jul 14 schedule went up two days before it started. Two coworkers in dietary said the same happened to them. Darnell’s note: “Supervisor changed my schedule after the meeting.”', createdAt: '2026-08-12T16:00:00.000Z' },
        ],
      },
      [memberBreakRoomId]: { item: memberBreakRoom, updates: [{ id: '55555555-5555-4555-8555-555555555521', caseID: memberBreakRoomId, body: 'Resolved: the night-shift break room is unlocked again after twelve coworkers asked together at the March huddle.', createdAt: '2026-03-14T17:00:00.000Z' }] },
      [memberLiftId]: { item: memberLift, updates: [{ id: '55555555-5555-4555-8555-555555555531', caseID: memberLiftId, body: 'Resolved: the broken lift on 3 West was replaced after the committee gathered photos and dates from three shifts. Closed December 18.', createdAt: '2025-12-18T17:00:00.000Z' }] },
      [memberHolidayId]: { item: memberHoliday, updates: [{ id: '55555555-5555-4555-8555-555555555541', caseID: memberHolidayId, body: 'Resolved: the holiday schedule went up four weeks ahead after coworkers asked together in September.', createdAt: '2025-10-09T17:00:00.000Z' }] },
    },
    conversations: {
      [memberThreadId]: {
        conversation: conversation(memberThreadId, 'Elena Cruz', 'EC', memberThreadOneLatest, 1, '2026-07-12T14:00:00.000Z'),
        messages: [
          { id: '77777777-7777-4777-8777-777777777701', conversationID: memberThreadId, senderKind: 'member', senderName: 'Darnell Foster', body: 'Three nights this week we had two CNAs for all of 3 West. I wrote down the dates and who was on.', readAt: '2026-07-11T18:12:00.000Z', createdAt: '2026-07-11T18:12:00.000Z' },
          { id: '77777777-7777-4777-8777-777777777702', conversationID: memberThreadId, senderKind: 'steward', senderName: 'Elena Cruz', body: 'Thank you, that is exactly what the committee needs. Keep your notes at home, not on a work phone. I will bring them to committee review.', readAt: '2026-07-12T13:40:00.000Z', createdAt: '2026-07-12T13:40:00.000Z' },
          { id: '77777777-7777-4777-8777-777777777703', conversationID: memberThreadId, senderKind: 'steward', senderName: 'Elena Cruz', body: memberThreadOneLatest, readAt: null, createdAt: '2026-07-12T14:00:00.000Z' },
        ],
      },
      [memberThreadTwoId]: {
        conversation: conversation(memberThreadTwoId, 'Committee (private)', 'CM', memberThreadTwoLatest, 0, '2026-06-28T14:00:00.000Z'),
        messages: [
          { id: '77777777-7777-4777-8777-777777777711', conversationID: memberThreadTwoId, senderKind: 'member', senderName: 'Darnell Foster', body: 'My weekend schedule changed after I had already left for the day. Nobody told me. Do you need the posted sheets?', readAt: '2026-06-28T13:10:00.000Z', createdAt: '2026-06-28T13:10:00.000Z' },
          { id: '77777777-7777-4777-8777-777777777712', conversationID: memberThreadTwoId, senderKind: 'steward', senderName: 'Maya Thompson', body: memberThreadTwoLatest, readAt: '2026-06-28T14:00:00.000Z', createdAt: '2026-06-28T14:00:00.000Z' },
        ],
      },
      [memberBreaksThread.summary.id]: memberBreaksThread.lookup,
      [memberOvertimeThread.summary.id]: memberOvertimeThread.lookup,
      [memberLiftThread.summary.id]: memberLiftThread.lookup,
    },
  },
  organizer: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111110', 'Elena', 'Elena Cruz', 'EC', 'Organizer', 2022),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222201', 'Six first conversations to log', 'Evening shift on 3 West finished six first conversations this week. Log them before Thursday.', 'message', null, '2026-08-12T22:30:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222202', 'Card drive at 119 of 184', 'Night shift is the gap: 4 East and dietary have the fewest signed cards.', 'report', null, '2026-08-12T15:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222203', 'One-on-one booked · Darnell Foster', 'Wed, Aug 19 · 3:00 PM at Harbor Street library.', 'appointment', now, '2026-08-08T12:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222204', 'Night-shift committee seat open', '4 East nights still has no committee member. Two coworkers suggested the same CNA.', 'chapter', now, '2026-08-06T09:15:00.000Z'),
      ],
      cases: [
        caseItem('f3333333-3333-4333-8333-333333333371', 'HCU-104', 'Overnight staffing on 3 West', '2026-08-27', 'Staffing', 'Delegation scheduled', 'active', '2026-08-12T10:00:00.000Z'),
        caseItem('f3333333-3333-4333-8333-333333333372', 'HCU-145', 'Mandated overtime on evening shift', '2026-08-25', 'Overtime', 'Committee review', 'active', '2026-08-11T16:00:00.000Z'),
        caseItem('f3333333-3333-4333-8333-333333333373', 'HCU-119', 'Short breaks in dietary', null, 'Breaks', 'Paused', 'active', '2026-07-30T16:00:00.000Z'),
      ],
      conversations: [
        organizerLiuThread.summary,
        organizerCoverageThread.summary,
        conversation(memberThreadId, 'Darnell Foster', 'DF', memberThreadOneLatest, 0, '2026-07-12T14:00:00.000Z'),
      ],
      weeklyActions: [
        { actionKey: 'preview-organizer-1', actionKind: 'message', occurredAt: now },
        { actionKey: 'preview-organizer-2', actionKind: 'checkin', occurredAt: now },
        { actionKey: 'preview-organizer-3', actionKind: 'case', occurredAt: now },
      ],
    },
    desk: {
      summary: 'Twelve conversations to have this week, 119 of 184 cards signed, and night shift on 4 East still has no committee member.',
      chapterName: campaign,
      // Committee by shift adds up to the snapshot's 14 committee members.
      kpis: [
        { label: 'Conversations to have', value: '12' },
        { label: 'Cards signed', value: '119/184' },
        { label: 'One-on-ones this week', value: '5' },
        { label: 'Committee by shift', value: 'Eve 7 · Day 5 · Night 2' },
      ],
      queue: [
        { id: 'org-queue-1', title: 'Grace Liu · first conversation', subtitle: 'Dietary · nights · Wed 9:30 PM at the diner', status: 'scheduled', href: `/conversation/${organizerLiuThread.summary.id}` },
        { id: 'org-queue-2', title: 'Follow up: 4 East night CNAs', subtitle: 'Six coworkers not yet reached · Tomás Reyes mapping', status: 'due soon' },
        { id: 'f3333333-3333-4333-8333-333333333372', title: 'HCU-145 · Mandated overtime on evening shift', subtitle: 'Committee review Thursday', status: 'active', href: '/issue/f3333333-3333-4333-8333-333333333372' },
        { id: 'org-queue-4', title: 'Committee recruit for 4 East nights', subtitle: 'Two coworkers suggested the same CNA', status: 'open' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11', title: 'Card drive: night-shift push', subtitle: '119 of 184 signed · next check Aug 31', status: 'in progress' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12', title: 'One-on-one with Darnell Foster', subtitle: 'Delegation speaker prep · Wed Aug 19', status: 'to do' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13', title: 'Update committee coverage map', subtitle: 'Evening 7 · day 5 · night 2', status: 'in review' },
      ],
      events: [houseVisitTraining, staffingDelegation, ...campaignEvents],
      appointments: [
        { id: 'org-appt-1', withName: 'Darnell Foster', when: 'Wed, Aug 19 · 3:00–3:30 PM', place: 'Harbor Street library · Room B', type: 'One-on-one', status: 'confirmed' },
        { id: 'org-appt-2', withName: 'Grace Liu', when: 'Wed, Aug 19 · 9:30–10:00 PM', place: 'Diner across from the main entrance', type: 'First conversation', status: 'confirmed' },
      ],
      forms: [
        { id: 'org-form-1', title: 'Conversation log · week of Aug 10', status: 'submitted', updated: 'Aug 14' },
        { id: 'org-form-2', title: 'House-visit plan · 4 East nights', status: 'draft', updated: 'Aug 12' },
      ],
      ballots: [
        previewBallot('ballot-committee-open-meeting', 'Committee vote: hold the September open meeting at the library', 'Closes Tue, Aug 18 · 9:00 PM', '2026-08-18T21:00:00-04:00'),
      ],
      lessons: organizingLessons,
      workload: [
        { id: 'wl-organizer-1', dateLabel: 'Thu, Aug 13', meta: '4 one-on-ones · 2 house visits planned' },
        { id: 'wl-organizer-2', dateLabel: 'Wed, Aug 12', meta: 'Card drive · 3 cards signed on evening shift' },
      ],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {
      [organizerLiuThread.summary.id]: organizerLiuThread.lookup,
      [organizerCoverageThread.summary.id]: organizerCoverageThread.lookup,
    },
  },
  steward: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111111', 'Maya', 'Maya Thompson', 'MT', 'Committee', 2023),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222211', 'Jordan Mills asked to talk', 'A supervisor set a Thursday meeting about scheduling. Jordan wants to talk before then.', 'message', null, '2026-08-13T11:10:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222212', 'Form submitted · Jordan Mills', 'Issue report: mandated overtime on evening shift, three times in two weeks.', 'form', null, '2026-07-21T16:40:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222213', 'Ava Ramos needs a check-in', 'She wrote down what was said after the huddle and is waiting to go over it.', 'message', null, '2026-07-20T19:02:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222214', 'Committee meeting Sunday, Aug 30', '2:00 PM at Harbor Street library. Five coworkers already confirmed.', 'chapter', now, '2026-08-11T14:00:00.000Z'),
      ],
      cases: [
        caseItem('c3333333-3333-4333-8333-333333333331', 'HCU-142', 'Supervisor meeting about schedules', '2026-08-20', 'Scheduling', 'Listening', 'active', '2026-08-13T11:10:00.000Z'),
        caseItem('c3333333-3333-4333-8333-333333333332', 'HCU-104', 'Overnight staffing on 3 West', '2026-08-27', 'Staffing', 'Delegation scheduled', 'active', '2026-07-12T14:00:00.000Z'),
        caseItem('c3333333-3333-4333-8333-333333333333', 'HCU-138', 'Broken lift on 4 East', '2026-08-22', 'Equipment', 'Committee review', 'active', '2026-07-21T12:00:00.000Z'),
      ],
      conversations: [
        committeeMillsThread.summary,
        committeeRamosThread.summary,
        conversation('d4444444-4444-4444-8444-444444444443', 'Kevin Tran', 'KT', 'Got it. I will bring the lift photos on Thursday.', 0, '2026-07-19T16:20:00.000Z'),
        conversation(memberThreadTwoId, 'Darnell Foster', 'DF', memberThreadTwoLatest, 0, '2026-06-28T14:00:00.000Z'),
      ],
      weeklyActions: [
        { actionKey: 'preview-committee-1', actionKind: 'message', occurredAt: now },
        { actionKey: 'preview-committee-2', actionKind: 'case', occurredAt: now },
        { actionKey: 'preview-committee-3', actionKind: 'scan', occurredAt: now },
      ],
    },
    desk: {
      summary: 'Three open worker requests, two unread threads, and two submitted forms waiting on your review.',
      chapterName: campaign,
      kpis: [
        { label: 'Open requests', value: '3' },
        { label: 'Awaiting reply', value: '2' },
        { label: 'Coworkers covered', value: '38' },
      ],
      queue: [
        { id: 'c3333333-3333-4333-8333-333333333331', title: 'Jordan Mills · supervisor meeting', subtitle: 'Thursday · huddle notes written · one-on-one offered', status: 'requested', href: '/issue/c3333333-3333-4333-8333-333333333331' },
        { id: 'c3333333-3333-4333-8333-333333333332', title: 'Darnell Foster · overnight staffing', subtitle: 'Delegation Thu Aug 27 · speakers confirmed', status: 'active', href: '/issue/c3333333-3333-4333-8333-333333333332' },
        { id: 'c3333333-3333-4333-8333-333333333333', title: 'Kevin Tran · broken lift on 4 East', subtitle: 'Committee review · photos from three shifts', status: 'draft', href: '/issue/c3333333-3333-4333-8333-333333333333' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa31', title: 'Wednesday check-ins', subtitle: 'After evening handoff · Harbor Street library', status: 'to do' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa32', title: 'Review Ava Ramos huddle note', subtitle: 'Facts only · okay to use her name', status: 'in review' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa33', title: 'Send the evening-shift broadcast', subtitle: 'Open meeting reminder · time and place only, no names', status: 'draft' },
      ],
      events: [houseVisitTraining, ...campaignEvents],
      appointments: [
        { id: 'committee-appt-1', withName: 'Kevin Tran', when: 'Mon, Aug 17 · 11:00–11:30 AM', place: 'Video call', type: 'Check-in', status: 'confirmed' },
        { id: 'committee-appt-2', withName: 'Darnell Foster', when: 'Thu, Aug 20 · 3:00–3:30 PM', place: 'Harbor Street library · Room B', type: 'Delegation speaker prep', status: 'confirmed' },
      ],
      forms: [
        { id: 'form-inbox-1', title: 'Jordan Mills · issue report: mandated overtime', status: 'submitted', updated: 'Jul 21' },
        { id: 'form-inbox-2', title: 'Ava Ramos · huddle note', status: 'in review', updated: 'Jul 20' },
        { id: 'form-inbox-3', title: 'Kevin Tran · equipment report: 4 East lift', status: 'submitted', updated: 'Jul 21' },
      ],
      ballots: [
        previewBallot('ballot-committee-open-meeting', 'Committee vote: hold the September open meeting at the library', 'Closes Tue, Aug 18 · 9:00 PM', '2026-08-18T21:00:00-04:00'),
      ],
      lessons: organizingLessons,
      workload: [
        { id: 'wl-committee-1', dateLabel: 'Wed, Aug 12', meta: 'Check-ins · 3 coworkers after evening handoff' },
        { id: 'wl-committee-2', dateLabel: 'Tue, Aug 11', meta: 'Forms review · July staffing logs' },
      ],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {
      [committeeMillsThread.summary.id]: committeeMillsThread.lookup,
      [committeeRamosThread.summary.id]: committeeRamosThread.lookup,
    },
  },
  coordinator: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111112', 'Andre', 'Andre Lewis', 'AL', 'Campaign lead', 2021),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222231', 'HCU-121 follow-up is overdue', 'Mandated overtime on weekends · Devon Reyes. The follow-up date was Jul 22.', 'case', null, '2026-07-23T15:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222232', 'Delegation scheduled', 'HCU-104 overnight staffing · Thursday, Aug 27. Speakers assigned.', 'case', null, '2026-08-12T10:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222233', 'Issue paused · short breaks', 'HCU-119 is paused until dietary coworkers finish the break log.', 'case', now, '2026-07-30T16:00:00.000Z'),
      ],
      cases: [
        caseItem('e3333333-3333-4333-8333-333333333341', 'HCU-121', 'Mandated overtime on weekends', '2026-07-22', 'Overtime', 'Action planned', 'active', '2026-07-23T15:00:00.000Z'),
        caseItem('e3333333-3333-4333-8333-333333333342', 'HCU-104', 'Overnight staffing on 3 West', '2026-08-27', 'Staffing', 'Delegation scheduled', 'active', '2026-08-12T10:00:00.000Z'),
        caseItem('e3333333-3333-4333-8333-333333333343', 'HCU-133', 'Schedule changes without notice', '2026-08-18', 'Scheduling', 'Committee review', 'active', '2026-08-04T15:00:00.000Z'),
        caseItem('e3333333-3333-4333-8333-333333333344', 'HCU-138', 'Broken lift on 4 East', '2026-08-28', 'Equipment', 'Listening', 'active', '2026-07-20T12:00:00.000Z'),
        caseItem('e3333333-3333-4333-8333-333333333345', 'HCU-098', 'Night breaks covered', null, 'Breaks', 'Resolved', 'resolved', '2026-07-08T12:00:00.000Z'),
      ],
      conversations: [
        conversation('d4444444-4444-4444-8444-444444444451', 'Maya Thompson', 'MT', 'The staffing petition wording is ready for your review.', 1, '2026-08-12T09:40:00.000Z'),
        conversation('d4444444-4444-4444-8444-444444444452', 'Jordan Kim', 'JK', 'I read the HCU-121 notes: three weekend mandates in 22 days.', 0, '2026-07-23T15:12:00.000Z'),
      ],
      weeklyActions: [
        { actionKey: 'preview-coord-1', actionKind: 'case', occurredAt: now },
        { actionKey: 'preview-coord-2', actionKind: 'case', occurredAt: now },
      ],
    },
    desk: {
      summary: 'Four open issues, two follow-up dates this week, one delegation scheduled, and HCU-121 past its follow-up date.',
      chapterName: campaign,
      kpis: [
        { label: 'Open issues', value: '4' },
        { label: 'Follow-ups this week', value: '2' },
        { label: 'Delegations scheduled', value: '1' },
      ],
      queue: [
        { id: 'e3333333-3333-4333-8333-333333333341', title: 'HCU-121 · Mandated overtime on weekends', subtitle: 'Devon Reyes · assigned Maya Thompson · follow-up was Jul 22', status: 'overdue', href: '/issue/e3333333-3333-4333-8333-333333333341' },
        { id: 'e3333333-3333-4333-8333-333333333342', title: 'HCU-104 · Overnight staffing on 3 West', subtitle: 'Assigned Elena Cruz · delegation Thu Aug 27', status: 'delegation', href: '/issue/e3333333-3333-4333-8333-333333333342' },
        { id: 'e3333333-3333-4333-8333-333333333343', title: 'HCU-133 · Schedule changes without notice', subtitle: 'Assigned Keisha Grant · follow-up Aug 18', status: 'due soon', href: '/issue/e3333333-3333-4333-8333-333333333343' },
        { id: 'e3333333-3333-4333-8333-333333333344', title: 'HCU-138 · Broken lift on 4 East', subtitle: 'Unassigned · follow-up Aug 28', status: 'open', href: '/issue/e3333333-3333-4333-8333-333333333344' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa41', title: 'Prepare August committee meeting', subtitle: 'Room, agenda, video host, flyer', status: 'in progress' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa42', title: 'Assign 4 East night follow-ups', subtitle: 'Blocked until the floor map is finished', status: 'blocked' },
      ],
      events: [leadershipMeeting, staffingDelegation, ...campaignEvents],
      appointments: [
        { id: 'coord-appt-1', withName: 'Devon Reyes', when: 'Thu, Aug 20 · 2:00–2:45 PM', place: 'Harbor Street library · Room B', type: 'Issue follow-up', status: 'confirmed' },
      ],
      forms: [
        { id: 'form-inbox-1', title: 'Jordan Mills · issue report: mandated overtime', status: 'submitted', updated: 'Jul 21' },
      ],
      ballots: [
        previewBallot('ballot-committee-open-meeting', 'Committee vote: hold the September open meeting at the library', 'Closes Tue, Aug 18 · 9:00 PM', '2026-08-18T21:00:00-04:00'),
      ],
      lessons: organizingLessons,
      workload: [
        { id: 'wl-coord-1', dateLabel: 'Fri, Aug 14', meta: 'Issue queue review · 4 follow-up dates' },
      ],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {},
  },
  advisor: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111113', 'Priya', 'Priya Shah', 'PS', 'Advisor', 2022),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222241', 'Recognition planning memo due Aug 25', 'Jordan Kim asked for a plain-language summary of the election and voluntary recognition paths.', 'rights', null, '2026-08-12T09:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222242', 'Consult request · huddle note', 'Elena Cruz wants to go over Ava Ramos’s note before Thursday.', 'message', null, '2026-08-11T16:00:00.000Z'),
      ],
      cases: [
        caseItem('c3333333-3333-4333-8333-333333333351', 'HCU-146', 'Comments about meetings at the huddle', '2026-08-25', 'Workplace conduct', 'Committee review', 'active', '2026-08-12T09:00:00.000Z'),
      ],
      conversations: [
        conversation('d4444444-4444-4444-8444-444444444461', 'Elena Cruz', 'EC', 'Can we go over Ava’s note before Thursday? I want to point her to qualified help, not guess.', 1, '2026-08-11T16:00:00.000Z'),
      ],
      weeklyActions: [{ actionKey: 'preview-advisor-1', actionKind: 'rights', occurredAt: now }],
    },
    desk: {
      summary: 'Campaign health at 74, participation strongest on evening shift, and a recognition-planning memo due August 25.',
      chapterName: campaign,
      kpis: [
        { label: 'Campaign health', value: '74' },
        { label: 'Coworkers reached', value: '151/184' },
        { label: 'Committee', value: '14' },
      ],
      queue: [
        { id: 'advisor-queue-1', title: 'Recognition paths memo', subtitle: 'Election and voluntary recognition in plain language · due Aug 25', status: 'review' },
        { id: 'd4444444-4444-4444-8444-444444444461', title: 'Ava Ramos huddle note', subtitle: 'Elena Cruz · Thursday · refer to qualified help', status: 'requested', href: '/conversation/d4444444-4444-4444-8444-444444444461' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa51', title: 'Participation check by shift', subtitle: 'Night shift trails evening on first conversations', status: 'to do' },
      ],
      events: campaignEvents,
      appointments: [],
      forms: [],
      ballots: [],
      lessons: organizingLessons,
      workload: [
        { id: 'wl-advisor-1', dateLabel: 'This week', meta: 'Participation · night shift under target on 2 units' },
      ],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {},
  },
  admin: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111114', 'Rosa', 'Rosa Martinez', 'RM', 'Admin', 2024),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222251', 'Campaign lead role pending', 'Andre Lewis’s campaign lead role is waiting on your confirmation.', 'admin', null, '2026-07-20T11:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222252', 'Issue report template saved', 'Version 1 is ready to publish to the worker form catalog.', 'form', now, '2026-08-10T11:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222253', 'Two-step sign-in coverage', '3 of 7 hats have a verified authenticator.', 'admin', now, '2026-08-09T09:00:00.000Z'),
      ],
      cases: [],
      conversations: [
        conversation('d4444444-4444-4444-8444-444444444471', 'Jordan Kim', 'JK', 'Please confirm the campaign lead role before Friday’s leadership meeting.', 0, '2026-08-12T10:15:00.000Z'),
      ],
      weeklyActions: [{ actionKey: 'preview-admin-1', actionKind: 'form', occurredAt: now }],
    },
    desk: {
      summary: 'Seven hats, one open role grant, six active form templates, and three verified authenticators.',
      chapterName: campaign,
      kpis: [
        { label: 'Hats', value: '7' },
        { label: 'Open grants', value: '1' },
        { label: 'Active templates', value: '6' },
      ],
      queue: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa61', title: 'Confirm campaign lead role', subtitle: 'Andre Lewis · requested Jul 20', status: 'pending' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa62', title: 'Publish issue report template v1', subtitle: 'Worker form catalog · draft', status: 'draft' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa63', title: 'Close two-step sign-in gaps', subtitle: 'Elena, Maya, Andre, and Priya still unverified', status: 'review' },
      ],
      events: campaignEvents,
      appointments: [],
      forms: [
        { id: 'tmpl-issue-report', title: 'Issue report', status: 'active', updated: 'Jul 23' },
        { id: 'tmpl-staffing-log', title: 'Staffing log', status: 'active', updated: 'Jul 23' },
        { id: 'tmpl-one-on-one', title: 'One-on-one notes', status: 'draft', updated: 'Aug 10' },
      ],
      ballots: [],
      lessons: [],
      workload: [],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {},
  },
  vp: {
    dashboard: {
      member: profile('a1111111-1111-4111-8111-111111111115', 'Jordan', 'Jordan Kim', 'JK', 'Campaign chair', 2023),
      notifications: [
        notification('b2222222-2222-4222-8222-222222222261', 'Support trend is up', 'Signed cards rose from 104 to 119 since June. A card majority shows support; it is not recognition.', 'report', null, '2026-08-09T14:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222262', 'HCU-121 needs attention', 'Mandated overtime on weekends · the follow-up date was Jul 22.', 'case', null, '2026-07-22T12:00:00.000Z'),
        notification('b2222222-2222-4222-8222-222222222263', 'Priorities poll closed', 'Safe overnight staffing finished first and schedule notice second.', 'vote', now, '2026-07-21T20:00:00.000Z'),
      ],
      cases: [
        caseItem('e3333333-3333-4333-8333-333333333341', 'HCU-121', 'Mandated overtime on weekends', '2026-07-22', 'Overtime', 'Action planned', 'active', '2026-07-23T15:00:00.000Z'),
        caseItem('c3333333-3333-4333-8333-333333333361', 'HCU-127', 'Delegation request not answered', '2026-07-18', 'Staffing', 'Action planned', 'active', '2026-07-18T12:00:00.000Z'),
      ],
      conversations: [
        conversation('d4444444-4444-4444-8444-444444444481', 'Andre Lewis', 'AL', 'The priorities summary is ready for your review before the committee meeting.', 1, '2026-08-12T11:20:00.000Z'),
      ],
      weeklyActions: [{ actionKey: 'preview-vp-1', actionKind: 'vote', occurredAt: now }],
    },
    desk: {
      summary: '119 of 184 coworkers have signed cards, 14 serve on the committee, and first-contract priorities are drafted. Bargaining starts only after recognition.',
      chapterName: campaign,
      // b03b-11: a fraction beside another count read as a share of the
      // wrong whole. Both fractions here name 184, the eligible estimate the
      // summary sentence uses, and neither is called a vote.
      kpis: [
        { label: 'Cards signed', value: '119/184' },
        { label: 'Coworkers reached', value: '151/184' },
        { label: 'Committee', value: '14' },
      ],
      queue: [
        { id: 'e3333333-3333-4333-8333-333333333341', title: 'HCU-121 · Mandated overtime on weekends', subtitle: 'Devon Reyes · follow-up was Jul 22', status: 'attention', href: '/issue/e3333333-3333-4333-8333-333333333341' },
        { id: 'c3333333-3333-4333-8333-333333333361', title: 'HCU-127 · Delegation request not answered', subtitle: 'Andre Lewis · follow-up was Jul 18', status: 'attention', href: '/issue/c3333333-3333-4333-8333-333333333361' },
      ],
      tasks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa71', title: 'Campaign leadership meeting', subtitle: 'Priorities, committee vacancies, delegation', status: 'upcoming' },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa72', title: 'First-contract priorities draft', subtitle: 'For after recognition · safe staffing and schedule notice first', status: 'upcoming' },
      ],
      events: [
        leadershipMeeting,
        campaignEvent('evt-priorities-session', 'First-contract priorities session', '2026-08-04T18:00:00-04:00', 'Harbor Street library · Room B', 'Coworkers ranked what to bring to the table once the union is recognized. No bargaining happens before then.'),
        campaignEvent('evt-open-meeting-september', 'September open meeting', '2026-09-17T19:00:00-04:00', 'Harbor Street library + video call', 'Support trend, the delegation report, and the go-public timeline.'),
      ],
      appointments: [],
      forms: [],
      ballots: [
        { id: 'ballot-2025', title: 'Go public with the campaign this fall', meta: 'Closed · 112 yes / 21 no / 9 abstain', status: 'closed' },
        previewBallot('ballot-2026', 'Make safe overnight staffing the top campaign priority', 'Closes Tue, Jul 21 · 7:59 PM', '2026-07-21T19:59:00-04:00'),
        previewBallot('ballot-committee-open-meeting', 'Committee vote: hold the September open meeting at the library', 'Closes Tue, Aug 18 · 9:00 PM', '2026-08-18T21:00:00-04:00'),
      ],
      lessons: [],
      workload: [],
      rewards: null,
      ...staffCampaignFeatures,
    },
    cases: {},
    conversations: {},
  },
};

const HISTORY_YEARS = [2025, 2024, 2023] as const;

function withRollingHistory(bundle: PreviewBundle, key: PreviewHatKey): PreviewBundle {
  const role = hat(key).label;
  const historyCases = HISTORY_YEARS.map((year, index) => caseItem(
    `history-${key}-case-${year}`,
    `HCU-${String(year).slice(-2)}${index + 1}`,
    `${role} follow-up resolved`,
    null,
    'Campaign follow-up',
    'Resolved',
    'resolved',
    `${year}-08-15T15:00:00.000Z`,
  ));
  const historyNotifications = HISTORY_YEARS.map((year, index) => notification(
    `history-${key}-notification-${year}`,
    `${year} campaign year in review`,
    `${role} activity, resolved issues, meetings, and coworker follow-ups from ${year} are available in this workspace.`,
    'chapter',
    `${year}-08-18T16:00:00.000Z`,
    `${year}-08-18T16:00:00.000Z`,
    `/issue/${historyCases[index]!.id}`,
  ));
  const historyConversations = HISTORY_YEARS.map((year) => conversation(
    `history-${key}-conversation-${year}`,
    year === 2025 ? 'Morgan Ellis' : year === 2024 ? 'Casey Brooks' : 'Riley Chen',
    year === 2025 ? 'ME' : year === 2024 ? 'CB' : 'RC',
    `${year} follow-up complete. The final notes and next steps are in the thread.`,
    0,
    `${year}-08-20T14:30:00.000Z`,
  ));
  const desk = clone(bundle.desk);
  desk.events.push(...HISTORY_YEARS.map((year) => campaignEvent(
    `history-${key}-event-${year}`,
    `${year} summer open meeting`,
    `${year}-08-24T18:00:00-04:00`,
    'Harbor Street library + video call',
    `${role} year-in-review, resolved issues, and campaign priorities.`,
  )));
  desk.appointments.push(...HISTORY_YEARS.map((year) => ({
    id: `history-${key}-appointment-${year}`,
    withName: year === 2025 ? 'Morgan Ellis' : year === 2024 ? 'Casey Brooks' : 'Riley Chen',
    when: `Aug 20, ${year} · 2:30 PM`,
    place: 'Harbor Street library · Room B',
    type: `${role} follow-up`,
    status: 'completed',
  })));
  desk.forms.push(...HISTORY_YEARS.map((year) => ({
    id: `history-${key}-form-${year}`,
    title: `${year} issue follow-up`,
    status: 'completed',
    updated: `Aug ${year}`,
  })));
  desk.ballots.push(...HISTORY_YEARS.map((year) => ({
    id: `history-${key}-ballot-${year}`,
    title: `${year} campaign priorities poll`,
    meta: `Closed Aug ${year} · receipt retained`,
    status: 'closed',
  })));
  desk.workload.push(...HISTORY_YEARS.map((year) => ({
    id: `history-${key}-workload-${year}`,
    dateLabel: `Aug 20, ${year}`,
    meta: `${role} follow-up · completed`,
  })));
  if (desk.chapterWork) {
    desk.chapterWork.tasks.push(...HISTORY_YEARS.map((year) => campaignTask(
      `history-${key}-task-${year}`,
      `HBV-${String(year).slice(-2)}`,
      `Close ${year} campaign follow-ups`,
      'done',
      'medium',
      'member_follow_up',
      'Committee',
      bundle.dashboard.member.fullName,
      `${year}-08-01`,
      `${year}-08-24`,
      `${year}-08-22`,
      100,
    )));
  }
  return {
    ...bundle,
    dashboard: {
      ...bundle.dashboard,
      notifications: [...bundle.dashboard.notifications, ...historyNotifications],
      cases: [...bundle.dashboard.cases, ...historyCases],
      conversations: [...bundle.dashboard.conversations, ...historyConversations],
    },
    desk,
  };
}

function withDerivedLookups(bundle: PreviewBundle): PreviewBundle {
  const cases = { ...bundle.cases };
  for (const item of bundle.dashboard.cases) {
    if (!cases[item.id]) {
      cases[item.id] = {
        item,
        updates: [{
          id: `${item.id.slice(0, 8)}-0000-4000-8000-00000000c001`,
          caseID: item.id,
          body: `${item.reference} is at ${item.step}. ${item.caseType} issue last updated for ${campaign}.`,
          createdAt: item.updatedAt,
        }],
      };
    }
  }
  const conversations = { ...bundle.conversations };
  for (const item of bundle.dashboard.conversations) {
    if (!conversations[item.id]) {
      conversations[item.id] = {
        conversation: item,
        messages: item.latestMessage
          ? [{
            id: `${item.id.slice(0, 8)}-0000-4000-8000-00000000m001`,
            conversationID: item.id,
            senderKind: 'steward',
            senderName: item.title,
            body: item.latestMessage,
            readAt: item.unreadCount ? null : item.updatedAt,
            createdAt: item.updatedAt,
          }]
          : [],
      };
    }
  }
  return { ...bundle, cases, conversations };
}

const PREVIEW_BUNDLES = Object.fromEntries(
  (Object.keys(bundles) as PreviewHatKey[]).map((key) => [key, withDerivedLookups(withRollingHistory(bundles[key], key))]),
) as Record<PreviewHatKey, PreviewBundle>;

export function isPreviewHatKey(value: string): value is PreviewHatKey {
  return PREVIEW_HATS.some((item) => item.key === value);
}

export function previewHat(key: PreviewHatKey): PreviewHat {
  return hat(key);
}

export function previewDashboardFor(key: PreviewHatKey): MemberDashboard {
  return clone(PREVIEW_BUNDLES[key].dashboard);
}

export function previewDeskFor(key: PreviewHatKey): PreviewDesk {
  return clone(PREVIEW_BUNDLES[key].desk);
}

export function previewCaseDetailsFor(key: PreviewHatKey): Record<string, MemberCaseDetail> {
  return clone(PREVIEW_BUNDLES[key].cases);
}

export function previewConversationThreadsFor(key: PreviewHatKey): Record<string, MemberConversationThread> {
  return clone(PREVIEW_BUNDLES[key].conversations);
}

export function previewCompassHistoryFor(key: PreviewHatKey): PreviewCompassHistory {
  const role = previewHat(key).label;
  const threads = [2025, 2024, 2023].map((year) => {
    const source = PREVIEW_KNOWLEDGE[(year - 2023) % PREVIEW_KNOWLEDGE.length]!;
    return {
      id: `preview-compass-${key}-${year}`,
      title: `${year} · ${role} follow-up`,
      messages: [
        {
          id: `preview-compass-${key}-${year}-question`,
          role: 'user' as const,
          body: `${year} archive: what guidance did we use for this ${role.toLowerCase()} follow-up?`,
        },
        {
          id: `preview-compass-${key}-${year}-answer`,
          role: 'assistant' as const,
          body: `${source.body} ${QUALIFIED_HELP} This guidance was kept with the ${year} campaign archive.`,
          sources: [compassSourceWithDestination({ id: `kb:${source.id}`, kind: 'resource', title: source.title, ref: source.ref })],
        },
      ],
    };
  });
  const latest = threads[0]!;
  return clone({ threadID: latest.id, title: latest.title, messages: latest.messages, threads });
}

export function previewCaseDetail(id: string, hat: PreviewHatKey): MemberCaseDetail | null {
  const detail = PREVIEW_BUNDLES[hat].cases[id];
  return detail ? clone(detail) : null;
}

export function previewConversationThread(id: string, hat: PreviewHatKey): MemberConversationThread | null {
  const thread = PREVIEW_BUNDLES[hat].conversations[id];
  return thread ? clone(thread) : null;
}

export function previewCompassReply(question: string): CompassReply {
  const haystack = question.toLowerCase();
  const match = PREVIEW_KNOWLEDGE.find((article) => article.keywords.some((keyword) => haystack.includes(keyword)));
  if (!match) {
    return {
      answer: `The Guide cannot answer that from the approved campaign sources in this preview. It does not guess. ${QUALIFIED_HELP}`,
      sources: [],
    };
  }
  return {
    answer: `${match.body} ${QUALIFIED_HELP}`,
    sources: [compassSourceWithDestination({ id: `kb:${match.id}`, kind: 'resource', title: match.title, ref: match.ref })],
  };
}

export const previewDashboard = previewDashboardFor('member');
export const previewCaseDetails = previewCaseDetailsFor('member');
export const previewConversationThreads = previewConversationThreadsFor('member');
