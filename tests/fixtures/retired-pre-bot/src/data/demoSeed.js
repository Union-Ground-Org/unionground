// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Org-scale seed for the PREVIEW tour.
//
// fallback.js stays the hand-authored core: the demo cast (Darnell Foster,
// Sam Okafor, Jordan Patel…), the rows the guided tour points at, and the
// invariants tests/fallback.test.js pins. This module takes that core and
// deterministically expands it to the size of a real, busy regional organizing network:
//
//   20 campaigns · 12,000 workers · 480 committee members · 4 years of history
//
// Everything is generated from a fixed-seed PRNG anchored to a fixed date, so
// two loads (or two test runs) produce byte-identical data and the demo never
// drifts between sessions. The core rows are PINNED FIRST in every expanded
// list — the tour's assertions (the petition ballot, task WOR-1, the
// committee thread) keep pointing at the same rows, and because the core rows are also
// the newest, appending older history after them preserves newest-first order.
//
// Scale strategy: aggregate numbers (member counts, KPIs, tallies, trends)
// carry the full 12k story; list surfaces get hundreds of rows — enough to
// exercise every pager many times over — except the member roster, which is
// genuinely 12,000 rows because the admin directory search filters over it.
// The roster lives at top-level keys (memberRoster, adminSearchPool) rather
// than inside adminDesk, because the demo hats deep-clone adminDesk on entry.

export const DEMO_SEED_PROFILE = {
  chapters: 20,
  members: 12000,
  stewards: 480,
  historyYears: 4,
  // The frozen "today" of the tour. All history runs back from here; nothing
  // reads the wall clock, so the dataset is reproducible.
  anchorDate: "2026-08-24T12:00:00Z",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Deterministic PRNG (mulberry32). One fixed seed for the whole dataset.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
    pick(list) { return list[Math.floor(next() * list.length)]; },
    chance(probability) { return next() < probability; },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Label helpers mirror the fixture's convention: times are authored in UTC and
// labeled as US Eastern (UTC-4, the demo org's home offset in its summer
// anchor month — close enough for fictional labels the tour never re-derives).
function easternDate(iso) {
  return new Date(Date.parse(iso) - 4 * 60 * 60 * 1000);
}

function monthDayLabel(iso) {
  const date = easternDate(iso);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function weekdayMonthDayLabel(iso) {
  const date = easternDate(iso);
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function timeLabel(iso) {
  const date = easternDate(iso);
  const hours24 = date.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours12}:${minutes} ${hours24 < 12 ? "AM" : "PM"}`;
}

const FIRST_NAMES = [
  "Ava", "Marisol", "Devon", "Renata", "Theo", "Jordan", "Priya", "Marcus", "Rosa", "James",
  "Aaliyah", "Miguel", "Chen", "Fatima", "Kwame", "Elena", "Dmitri", "Yuki", "Omar", "Grace",
  "Luis", "Nadia", "Sean", "Tanya", "Victor", "Wanda", "Xavier", "Yolanda", "Zoe", "Andre",
  "Bianca", "Carlos", "Dana", "Emeka", "Farah", "Gustavo", "Hana", "Ivan", "Jasmine", "Khalil",
  "Lena", "Mateo", "Nia", "Oscar", "Paloma", "Quinn", "Rafael", "Simone", "Tomas", "Uma",
];
const LAST_NAMES = [
  "Foster", "Vega", "Reyes", "Cole", "Nguyen", "Mills", "Shah", "Bell", "Delgado", "Okoye",
  "Johnson", "Rivera", "Chen", "Ali", "Mensah", "Petrov", "Tanaka", "Hassan", "Kim", "Sullivan",
  "Ortiz", "Ivanova", "Murphy", "Brooks", "Silva", "Jackson", "Moreau", "Diallo", "Park", "Walsh",
  "Ramos", "Kowalski", "Byrne", "Santos", "Adeyemi", "Lindgren", "Costa", "Novak", "Griffin", "Osei",
  "Herrera", "Nakamura", "Doyle", "Fonseca", "Abebe", "Larsen", "Marchetti", "Sokolov", "Boateng", "Quigley",
];

// Public events are left out of Union Ground, so every seeded meeting stays
// private. The draw is still taken so every later seeded value stays put.
function privateEvent(random, publicChance) {
  random.chance(publicChance);
  return false;
}

function personName(random) {
  return `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
}

function initialsOf(fullName) {
  return fullName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

// The 20-chapter map. "wor" is the tour's home chapter and the three ma-*
// chapters keep the ids/names the pinned adminDesk rows already reference.
const CHAPTER_TABLE = [
  { id: "wor", name: "Harborview Care United" },
  { id: "ma-dcf", name: "North County Transit Workers" },
  { id: "ma-dmh", name: "Lakeside Library Workers" },
  { id: "ma-dta", name: "Eastgate Warehouse Workers" },
  { id: "bos-dds", name: "Harborview Care Boston" },
  { id: "spr-dds", name: "Harborview Care Springfield" },
  { id: "cape-dds", name: "Harborview Care Cape" },
  { id: "mer-dds", name: "Harborview Care Merrimack" },
  { id: "berk-dds", name: "Harborview Care Berkshires" },
  { id: "dcf-wor", name: "North County Transit North Depot" },
  { id: "dcf-spr", name: "North County Transit South Depot" },
  { id: "dcf-ns", name: "North County Transit Harbor Depot" },
  { id: "dmh-metro", name: "Lakeside Library Central" },
  { id: "dmh-west", name: "Lakeside Library West" },
  { id: "dmh-se", name: "Lakeside Library South" },
  { id: "dmh-cen", name: "Lakeside Library East" },
  { id: "dta-spr", name: "Eastgate Warehouse Dock A" },
  { id: "dta-wor", name: "Eastgate Warehouse Dock B" },
  { id: "dta-cape", name: "Eastgate Warehouse Dock C" },
  { id: "mass-north", name: "Riverside Home Care Workers" },
];

// Split a total across buckets with random weights, rounding so the parts sum
// to EXACTLY the total — the 12,000 / 480 numbers are the product promise.
function distributeExactly(total, buckets, random) {
  const weights = buckets.map(() => 0.6 + random.next());
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const counts = weights.map((w) => Math.floor((w / weightSum) * total));
  let remainder = total - counts.reduce((sum, c) => sum + c, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % counts.length, remainder -= 1) counts[index] += 1;
  return counts;
}

function buildChapters(profile, random) {
  const memberCounts = distributeExactly(profile.members, CHAPTER_TABLE, random);
  // Stewards proportional to membership (~1:37), corrected to sum exactly.
  const stewardCounts = CHAPTER_TABLE.map((_, index) =>
    Math.max(4, Math.round((memberCounts[index] / profile.members) * profile.stewards)));
  let drift = profile.stewards - stewardCounts.reduce((sum, c) => sum + c, 0);
  for (let index = 0; drift !== 0; index = (index + 1) % stewardCounts.length) {
    const step = drift > 0 ? 1 : -1;
    if (stewardCounts[index] + step >= 4) { stewardCounts[index] += step; drift -= step; }
  }
  return CHAPTER_TABLE.map((chapter, index) => ({
    id: chapter.id,
    name: chapter.name,
    region: "Massachusetts",
    isDefault: index === 0,
    orderIndex: index + 1,
    memberCount: memberCounts[index],
    stewardCount: stewardCounts[index],
    // Organizers count as staff like every other staff hat (owner decision
    // D2, October 15, 2026): one or two per campaign, derived from the index
    // so the seeded random sequence is unchanged.
    staffCount: stewardCounts[index] + (1 + (index % 2)) + 3 + (index === 0 ? 1 : 0),
    roleCounts: { steward: stewardCounts[index], organizer: 1 + (index % 2), coordinator: 1, advisor: 1, admin: 1, vp: index === 0 ? 1 : 0 },
  }));
}

function buildRoster(chapters, random) {
  const roster = [];
  let serial = 0;
  for (const chapter of chapters) {
    for (let index = 0; index < chapter.memberCount; index += 1) {
      serial += 1;
      const fullName = personName(random);
      roster.push({
        userId: `seed-m-${serial}`,
        fullName,
        initials: initialsOf(fullName),
        // Long-tenured tail plus a steady stream of recent hires: a real
        // local's seniority curve, and it feeds the 4-year growth trend.
        memberSince: random.chance(0.55) ? random.int(2022, 2026) : random.int(1998, 2021),
        chapterId: chapter.id,
        chapterName: chapter.name,
        roles: index < chapter.stewardCount ? ["steward"] : [],
      });
    }
  }
  return roster;
}

function buildChapterLandings(chapters, profile, random, iso) {
  const activityTopics = [
    ["Campaign briefing published", "Workers can read the latest card-count update and the questions for the next huddle."],
    ["Campaign meeting recap shared", "Decisions, attendance, and assigned follow-ups were added to the campaign archive."],
    ["Committee office hours opened", "Workers can reserve confidential time with the committee."],
    ["Workplace safety update posted", "The committee shared aggregate hazard follow-up without exposing worker details."],
    ["Scheduling issue milestone", "Organizers posted the next group action and a campaign-level participation total."],
    ["New committee orientation scheduled", "The welcome team published the agenda, location, and accessibility details."],
  ];
  const sharedTopics = [
    ["Statewide organizing calendar", "Organization-wide dates and preparation notes for every participating campaign."],
    ["Organizer training library", "Shared organizing-rights, one-on-one, and house-visit materials available across campaigns."],
    ["Health and safety playbook", "Reusable checklists and aggregate lessons from campaign walkthroughs."],
    ["New committee welcome kit", "Common orientation materials with campaign-specific contact details kept separate."],
    ["Scheduling issue campaign hub", "Shared action dates, public resources, and campaign participation totals."],
    ["Accessibility and language guide", "Organization-wide standards for meetings, documents, and worker communications."],
  ];

  return chapters.map((chapter, chapterIndex) => {
    const activity = Array.from({ length: 24 }, (_, index) => {
      const [title, body] = activityTopics[(chapterIndex + index) % activityTopics.length];
      const occurredAt = iso(4 + chapterIndex + index * 23, 9 + (index % 8));
      return {
        id: `preview-chapter-activity-${chapter.id}-${index + 1}`,
        title,
        body,
        occurredAt,
        dateLabel: `${monthDayLabel(occurredAt)}${new Date(occurredAt).getUTCFullYear() === 2026 ? "" : `, ${new Date(occurredAt).getUTCFullYear()}`}`,
        kind: ["broadcast", "meeting", "appointment", "safety", "campaign", "orientation"][(chapterIndex + index) % 6],
      };
    });
    const sharedResources = sharedTopics.map(([title, description], index) => ({
      id: `preview-shared-resource-${chapter.id}-${index + 1}`,
      title,
      description,
      scope: "organization",
      updatedAt: iso(7 + chapterIndex * 2 + index * 31, 15),
      updatedLabel: monthDayLabel(iso(7 + chapterIndex * 2 + index * 31, 15)),
    }));
    const openCases = Math.max(6, Math.round(chapter.memberCount * (0.011 + random.next() * 0.006)));
    const upcomingEvents = 3 + (chapterIndex % 5);
    const turnoutPercent = 61 + ((chapterIndex * 7) % 28);
    return {
      ...chapter,
      landing: {
        summary: `${chapter.name} has four years of campaign activity, aggregate workplace-log context, meetings, and organization-wide resources ready to explore.`,
        updatedAt: profile.anchorDate,
        activitySummary: {
          openCases,
          activeCampaigns: 2 + (chapterIndex % 4),
          upcomingEvents,
          turnoutPercent,
        },
        activity,
        sharedResources,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// seedDemoData(core) — the seed function. Pure: `core` is never mutated.
// ---------------------------------------------------------------------------
export function seedDemoData(core, profileOverrides = {}) {
  const profile = { ...DEMO_SEED_PROFILE, ...profileOverrides };
  const random = makeRandom(509509);
  const anchorMs = Date.parse(profile.anchorDate);
  const historyDays = profile.historyYears * 365;
  const anchorYear = new Date(anchorMs).getUTCFullYear();
  const iso = (daysAgo, hour = 14, minute = 0) =>
    new Date(anchorMs - daysAgo * DAY_MS - (12 - hour) * 60 * 60 * 1000 + minute * 60 * 1000).toISOString().replace(".000Z", "Z");

  const data = structuredClone(core);
  const chapters = buildChapters(profile, random);
  const roster = buildRoster(chapters, random);
  const chapterLandings = buildChapterLandings(chapters, profile, random, iso);
  const home = chapters[0];
  const homeRoster = roster.filter((person) => person.chapterId === home.id);
  const homeStewards = homeRoster.filter((person) => person.roles.includes("steward"));

  // Full-org tables for any surface (or future surface) that wants them.
  data.seedProfile = { ...profile };
  data.chapters = chapterLandings;
  data.sharedChapterResources = chapterLandings.flatMap((chapter) => chapter.landing.sharedResources);
  data.memberRoster = roster;

  // --- Member-facing communication: 4 years of weekly chapter broadcasts. ---
  // Core keeps its 20 pinned rows (and its newest dates); older history lands
  // after them so the feed stays newest-first and very deep.
  const broadcastTopics = [
    "card-count update", "committee office hours", "petition delivery recap", "scheduling issue campaign",
    "health & safety walkthrough", "new committee orientation", "organizing-rights clinic", "captive-meeting debrief",
    "committee election notice", "solidarity action recap",
  ];
  for (let week = 3; week < profile.historyYears * 52; week += 1) {
    const publishedAt = iso(week * 7 + random.int(0, 2), random.int(9, 17));
    data.broadcasts.push({
      id: `seed-bc-${week}`,
      sender: "Committee",
      title: `${home.name} weekly: ${random.pick(broadcastTopics)}`,
      body: `Weekly ${home.name} briefing: meeting notes, organizing-rights reminders, open issues in aggregate, and worker follow-up actions for the week of ${monthDayLabel(publishedAt)}.`,
      publishedAt,
      locale: random.chance(0.12) ? "es" : "en",
      unread: false,
    });
  }

  // --- Member notifications: a busy but mostly-read bell. ---
  const notificationKinds = [
    ["Ballot closes soon", "A campaign ballot is closing this week — cast your vote.", "ballot"],
    ["New campaign update", "A new campaign update is ready.", "chapter"],
    ["Meeting reminder", "A campaign meeting you RSVP'd to starts soon.", "event"],
    ["Issue update", "The committee posted an update on your issue.", "case"],
    ["Committee reply", "The committee answered your message.", "reply"],
    ["Form status", "A form you filed changed status.", "form"],
  ];
  for (let index = 0; index < 24; index += 1) {
    const [title, body, fixture_copy_key] = random.pick(notificationKinds);
    const createdAt = iso(random.int(3, historyDays), random.int(8, 20));
    data.notifications.push({ id: `seed-n-${index + 1}`, title, body, fixture_copy_key, read_at: iso(random.int(0, 2), 21), created_at: createdAt });
  }

  // --- Events: monthly meetings plus trainings and actions, 4 years deep. ---
  const eventKinds = [
    ["Campaign meeting", "Off-site library room + Zoom", "Card-count report, open organizing update, worker Q&A."],
    ["Committee training", "Juniper hall · 30 Example Way", "Organizing-rights refreshers and one-on-one practice for new committee members."],
    ["Issue clinic", "Cedar Ridge office · Room 12", "Drop-in help documenting workplace issues and gathering coworker support."],
    ["Caseload-relief rally", "State House steps", "Statewide action for enforceable caseload caps."],
    ["New committee orientation", "Campaign hall, Room 2", "Welcome session: organizing rights, the campaign plan, and how to plug in."],
  ];
  for (let month = 1; month <= profile.historyYears * 12; month += 1) {
    const perMonth = random.int(2, 3);
    for (let slot = 0; slot < perMonth; slot += 1) {
      const [title, location, summary] = slot === 0 ? eventKinds[0] : random.pick(eventKinds.slice(1));
      const startsAt = iso(month * 30 - random.int(0, 24), 18);
      const attended = random.chance(0.62);
      data.events.push({
        id: `seed-evt-${month}-${slot}`,
        title, startsAt,
        dateLabel: weekdayMonthDayLabel(startsAt), timeLabel: timeLabel(startsAt),
        location, summary,
        chapterId: home.id, chapterName: home.name,
        isPublic: privateEvent(random, 0.3), isPublicAcrossAgencies: privateEvent(random, 0.1),
        rsvpStatus: attended ? "going" : (random.chance(0.3) ? "declined" : null),
        checkedIn: attended && random.chance(0.8),
        isPast: true,
      });
    }
  }
  for (let ahead = 1; ahead <= 5; ahead += 1) {
    const [title, location, summary] = ahead === 1 ? eventKinds[0] : random.pick(eventKinds.slice(1));
    const startsAt = iso(-(ahead * 9 + random.int(0, 4)), 18);
    data.events.push({
      id: `seed-evt-up-${ahead}`,
      title, startsAt,
      dateLabel: weekdayMonthDayLabel(startsAt), timeLabel: timeLabel(startsAt),
      location, summary,
      chapterId: home.id, chapterName: home.name,
      isPublic: privateEvent(random, 0.4), isPublicAcrossAgencies: privateEvent(random, 0.15),
      rsvpStatus: null, checkedIn: false, isPast: false,
    });
  }

  // --- Steward bench: the home chapter's full steward roster is bookable. ---
  const bench = homeStewards.slice(0, Math.max(home.stewardCount, 12)).map((person) => ({ id: person.userId, name: person.fullName }));
  data.apptStewards = [...data.apptStewards, ...bench.filter((s) => !data.apptStewards.some((p) => p.name === s.name))];

  // --- Member appointment history across the four years. ---
  const apptTypes = ["contract_questions", "office_hours", "grievance_followup", "onboarding"];
  const apptReasons = ["pay", "scheduling", "discipline", "general", "safety"];
  for (let index = 0; index < 14; index += 1) {
    const startsAt = iso(random.int(30, historyDays), random.int(9, 16));
    const duration = random.pick([20, 30, 45]);
    const steward = random.pick(data.apptStewards);
    data.appointments.push({
      id: `seed-appt-${index + 1}`,
      place: random.chance(0.5) ? "Boston office · Room 204" : "https://meet.example.org/steward",
      stewardId: steward.id, stewardName: steward.name,
      type: random.pick(apptTypes), durationMinutes: duration,
      startsAt, endsAt: new Date(Date.parse(startsAt) + duration * 60000).toISOString().replace(".000Z", "Z"),
      status: random.chance(0.9) ? "completed" : "cancelled",
      reasonCategory: random.pick(apptReasons), routedVia: random.chance(0.5) ? "steward" : "chapter",
      dateLabel: weekdayMonthDayLabel(startsAt), timeLabel: timeLabel(startsAt),
      endTimeLabel: timeLabel(new Date(Date.parse(startsAt) + duration * 60000).toISOString()),
    });
  }

  // --- Direct messages: a deep, active steward inbox for the demo member. ---
  // Each seeded thread follows an authored storyline — a real workplace issue
  // with an opening, evidence-gathering, a filing, and an outcome — instead of
  // random one-line pairs (owner feedback 2026-08-25: "messages should be much
  // more involved"). The openers/replies below survive as short-form fragments
  // for the surfaces that only show one line (forms inbox, intake, hub posts).
  const memberOpeners = [
    "My supervisor changed the posted schedule again without notice.",
    "A supervisor asked me who has been talking about the union.",
    "We were short-staffed on the overnight again — third time this month.",
    "I was told to attend a meeting tomorrow. What should I do?",
    "The overtime list skipped me twice. Are others seeing this too?",
    "Management called a mandatory meeting about the union campaign.",
  ];
  const stewardReplies = [
    "Thanks for flagging it — I'll check whether others on your unit saw the same change.",
    "Keep every notice they hand you; receiving it doesn't mean you agree.",
    "I added it to the committee's issue map today.",
    "Ask whether it could lead to discipline, and ask for a coworker to be present.",
    "Write down what was said, who was there, and the time.",
    "Logged. If it happens again this pay period, we'll raise it as a group.",
  ];
  // A campaign that is still forming
  // has no contract, grievance steps, hearings or Weingarten right, so each
  // storyline is an organizing situation of the same shape and length. The
  // "steward" speaker key is the shared role id; on screen it is the
  // committee. The disciplinary-meeting thread follows decision D4.
  const messageStorylines = [
    ["Unfair scheduling raised as a group issue", [
      ["member", "My supervisor changed the posted schedule again without notice — my Thursday overnight just became a Saturday double."],
      ["steward", "Thanks for telling me. You're not the only one — three people on evenings said the same this month. When did the new one go up?"],
      ["member", "Yesterday afternoon, effective this week. Two other people on my unit got moved too."],
      ["steward", "Then this is a group issue, not just yours. Photograph the posting board with the print date visible so it's on record."],
      ["member", "Photos sent — you can see the date stamp in the corner of both sheets."],
      ["steward", "Good. The committee will add it to the issue map tonight and ask the others on your unit whether they want to raise it together."],
      ["member", "Will we get the original schedule back this week?"],
      ["steward", "I can't promise that. A group asking together is harder to ignore than one person, and five of you signed the note asking for two weeks' notice."],
      ["steward", "Update: the five of you delivered the note together. The manager restored Monday's schedule and said changes will be posted earlier. We'll keep tracking it."],
      ["member", "That's a huge relief. Thank you for helping us do this together."],
    ]],
    ["A petition to management", [
      ["member", "Half the evening shift is talking about the mandatory overtime. Could we put something in writing to management?"],
      ["steward", "Yes — a short petition signed by the people affected is a good first step. What do people most want changed?"],
      ["member", "Sandra and I asked around: 48 hours' notice before a mandate, and a fair sign-up list for extra shifts."],
      ["steward", "Those are clear, reasonable asks. Keep it to one page and stick to facts: dates, how many people, and what you're asking for."],
      ["member", "Can they punish people for signing it?"],
      ["steward", "Signing stays voluntary. If anything changes for someone after they sign, tell me right away and we'll write it down."],
      ["steward", "The committee reviewed the draft and twenty-three people on evenings signed. We'll ask the manager for a meeting to deliver it as a group."],
      ["member", "Understood. I'll keep a copy of the signed version at home, not on my work phone."],
      ["steward", "Good instinct. Delivery is set for Thursday at 2 — you don't have to speak, and I'll send everyone a recap the same day."],
    ]],
    ["Called into a meeting with HR", [
      ["member", "I was told to attend a meeting with the program director tomorrow at 9. HR will be there. What should I do?"],
      ["steward", "First, ask whether the meeting could lead to discipline. Then ask for a coworker to be present. They may say no, but asking is still worth it."],
      ["member", "They said it's 'just a conversation about the incident report from Tuesday.'"],
      ["steward", "Stay calm and stick to what you know. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything they hand you."],
      ["member", "I asked whether Maya from my shift could sit in. They said yes, as long as she only listens."],
      ["steward", "Good. Before then, write down your own timeline of Tuesday while it's fresh. Keep it at home; it's for you and the committee."],
      ["member", "Done. Honestly the report has the times wrong — I was on the med pass when they say I was in the day room."],
      ["steward", "That's important. The med pass record shows the times, so you can point to it. Right after the meeting, write down who was there and what was said."],
      ["steward", "Thanks for your notes from the meeting. They checked the med pass record and closed the report with no action. The committee kept a copy of your notes."],
      ["member", "Thank you. I would have walked in alone and answered everything."],
    ]],
    ["Captive-audience meeting", [
      ["member", "Management just announced a mandatory meeting tomorrow about 'the union campaign.' Everyone on days has to go."],
      ["steward", "That's often called a captive-audience meeting. Go, stay calm, and remember you don't have to speak, sign anything, or name coworkers."],
      ["member", "What if they ask who's involved?"],
      ["steward", "You can say you'd rather not talk about it. Afterward, write down what was said, who spoke, and the time."],
      ["member", "Notes from today: they said a union would 'cost everyone their flexibility' and asked people to 'come talk privately.'"],
      ["steward", "Thank you — that's exactly the detail the committee needs. We'll compare notes from both sessions tonight."],
      ["steward", "The committee wrote a short fact sheet answering the main claims. We'll share it in one-on-ones this week, not on work email."],
      ["member", "Got it. I'll bring a few copies to my next one-on-one."],
    ]],
    ["Safety complaint on the overnight", [
      ["member", "We were short radios again on the overnight — third time this month. One radio for two buildings."],
      ["steward", "That's a real safety problem. Log each occurrence in the incident system tonight, even if nothing happened, and keep your own note at home."],
      ["member", "Logged all three dates. The overnight lead has been asking for a second radio since March."],
      ["steward", "Her requests are on record? That's our timeline. The committee will help the overnight crew put a written safety complaint together."],
      ["member", "Anything we should do meanwhile? It genuinely isn't safe during transports."],
      ["steward", "If a transport comes up with one radio, call the on-call supervisor and say you need a second for safety — and write down who you spoke to."],
      ["steward", "Update: eleven overnight workers signed the safety complaint. Management ordered two radios and set up an interim loaner starting tomorrow."],
      ["member", "The loaner arrived this morning. Night shift says thank you."],
    ]],
    ["Warning after a union conversation", [
      ["member", "Two days after I talked with coworkers about the union in the break room, I got a written warning about 'attitude.'"],
      ["steward", "I'm sorry. Send me a photo of the warning, and write down when you talked with coworkers and who was there."],
      ["member", "Uploaded. I've never had a warning before in four years here."],
      ["steward", "That timing matters. Start a timeline: the conversation, the warning, and anything else that changed. Facts only, no conclusions."],
      ["member", "What if they say it's about something else?"],
      ["steward", "They may. Your notes are facts, not a legal conclusion, and an organizer can talk with you about options, including getting legal advice."],
      ["steward", "The committee reviewed your timeline. Three others noticed changes after the same break-room conversation, and we're keeping it all together."],
      ["steward", "Update: an organizer connected you with a free worker-rights clinic for advice. Keep your copy of the warning somewhere safe, away from work."],
      ["member", "Received and saved. I appreciate you walking me through each step."],
    ]],
    ["Workload raised as a group issue", [
      ["member", "My caseload hit 42 this week. The performance standard letter says 35. Is there anything we can actually do?"],
      ["steward", "Yes — start by logging the count weekly in the workplace log so the overage is on record, not anecdotal."],
      ["member", "I've been logging since June. It's been over 35 for nine straight weeks."],
      ["steward", "Nine weeks of records is strong. Let's find out whether it's just you — I'll ask the committee to check in with others in your office."],
      ["member", "It isn't — intake keeps assigning to our office because we 'absorb it.'"],
      ["steward", "Twelve coworkers in your office shared their counts. The committee is turning it into a group issue and a one-page summary for management."],
      ["steward", "Update: the group delivered the summary together, and management agreed to redistribute intake next month. Keep logging weekly — the numbers made the case."],
      ["member", "Posting numbers or it didn't happen. Thanks — I'll tell the team to keep logging."],
    ]],
    ["Mileage reimbursement stalled", [
      ["member", "My April and May mileage reimbursements still haven't paid out. Payroll says 'processing.'"],
      ["steward", "Do you have the submission confirmations? Dates help, and you're probably not the only one waiting."],
      ["member", "Yes, both — April 30 and May 28, with supervisor approval the same week."],
      ["steward", "Thanks. Three others on the field team are waiting too. The committee will help you all send one short, polite note to payroll together."],
      ["steward", "Payroll answered the group note: April pays this Thursday, May the following cycle, and they flagged the backlog to the regional office."],
      ["member", "April landed today. I'll confirm May when it posts."],
      ["steward", "Noted. If May slips past the date they gave, tell me and we'll follow up as a group."],
      ["member", "May posted too. All set on my end — thank you."],
    ]],
    ["A one-on-one about signing a card", [
      ["member", "Elena asked me to sign a union card at lunch. I want to, but I'm nervous about what it means."],
      ["steward", "That's a fair question. A signed card shows that you support forming a union. It isn't a vote, and it isn't certification."],
      ["member", "Will my manager find out I signed?"],
      ["steward", "Who has signed stays private to the committee. We don't share the list, and we never post names."],
      ["member", "What happens after enough people sign?"],
      ["steward", "The campaign chooses a path: voluntary recognition from the employer, or an election. Those are separate paths, and the committee decides together."],
      ["steward", "If you'd like, we can have a one-on-one this week to talk through your questions before you decide. There's no pressure either way."],
      ["member", "Let's do Thursday. I think I'm ready, but I want to hear more first."],
    ]],
    ["Leave paperwork bounced", [
      ["member", "HR bounced my medical leave form for a 'missing provider signature' that is definitely on page 3."],
      ["steward", "That's frustrating. Scan the copy you submitted so you have proof of what you sent and when."],
      ["member", "Scanned. Signature and date, page 3, bottom right."],
      ["steward", "Good. Send HR the page with a short note asking them to correct the record, and keep a copy of the email."],
      ["member", "They want me to resubmit the whole packet 'to be safe.'"],
      ["steward", "Ask them to confirm in writing which date they're using. If you're unsure about your leave rights, an organizer can point you to free legal help."],
      ["steward", "Update from your note: HR corrected the record and approved the leave from your original submission date."],
      ["member", "Confirmed this morning. Thank you for helping me keep the paper trail."],
    ]],
  ];
  for (let index = 0; index < 28; index += 1) {
    const conversationId = `seed-conv-${index + 1}`;
    const ageDays = Math.round(4 + (historyDays - 12) * (index / 28));
    const steward = homeStewards[index % homeStewards.length];
    const [, script] = messageStorylines[index % messageStorylines.length];
    // A storyline unfolds over days: the opener sits deepest, each following
    // message lands hours-to-days later, and the last message sets the
    // thread's inbox position.
    let messageDaysAgo = ageDays + script.length;
    const messages = script.map(([kind, body], m) => {
      messageDaysAgo -= random.chance(0.6) ? 1 : 0;
      return {
        id: `seed-msg-${index + 1}-${m + 1}`,
        conversation_id: conversationId,
        sender_kind: kind,
        sender_name: kind === "member" ? data.member.fullName : steward.fullName,
        body,
        created_at: iso(Math.max(ageDays, messageDaysAgo), random.int(8, 20), random.int(0, 59)),
      };
    });
    const last = messages[messages.length - 1];
    // The freshest few threads read as live: their closing steward update is
    // still unread, so the inbox shows real activity instead of a read museum.
    const unread = index < 3 && last.sender_kind === "steward" ? 1 : 0;
    data.conversations.push({
      id: conversationId,
      sender: `${steward.fullName} · Committee`,
      initials: steward.initials,
      preview: last.body,
      dateLabel: monthDayLabel(last.created_at),
      unread,
      messages,
    });
  }

  // --- Ballots and pulses: every season of the four years voted on. ---
  const ballotSubjects = [
    "campaign action priorities", "petition demands", "committee chair election",
    "recognition-path choice", "fall meeting schedule", "first-contract survey priorities",
  ];
  const turnoutBase = Math.round(home.memberCount * 0.55);
  for (let index = 0; index < 15; index += 1) {
    const closedAt = iso(60 + index * 90 + random.int(0, 20), 19);
    const year = new Date(closedAt).getUTCFullYear();
    const totalVotes = turnoutBase + random.int(-140, 220);
    const yes = Math.round(totalVotes * (0.58 + random.next() * 0.3));
    const abstain = random.int(8, Math.max(9, Math.round(totalVotes * 0.06)));
    const ballotId = `seed-ballot-${index + 1}`;
    data.planItems.push({
      id: ballotId, kind: "ballot", icon: "🗳",
      title: `${year} ${home.name}: ${random.pick(ballotSubjects)}`,
      meta: `Closed ${weekdayMonthDayLabel(closedAt)} · Closed`,
      action: "Voted", closed: true, closesAt: closedAt,
      options: [
        { id: `${ballotId}-yes`, label: "Yes — approve", order_index: 1 },
        { id: `${ballotId}-no`, label: "No — reject", order_index: 2 },
        { id: `${ballotId}-abstain`, label: "Abstain", order_index: 3 },
      ],
      selectedOption: "", receiptCode: `SD${String(1000 + index)}X`,
      quorum: { totalVotes, quorumTarget: Math.round(home.memberCount * 0.4) },
      results: [
        { optionId: `${ballotId}-yes`, label: "Yes — approve", votes: yes },
        { optionId: `${ballotId}-no`, label: "No — reject", votes: totalVotes - yes - abstain },
        { optionId: `${ballotId}-abstain`, label: "Abstain", votes: abstain },
      ],
    });
  }

  // --- The member's own case history: one active core case + settled years. ---
  // Union Ground issues cite no contract article and move through no
  // grievance step, so a seeded issue carries a type and a title only.
  const caseKinds = [
    ["Scheduling", "Schedule change raised as a group"],
    ["Overtime", "Mandatory overtime petition"],
    ["Safety", "Safety complaint on the overnight"],
    ["Retaliation", "Warning after a union conversation"],
    ["Rights", "Captive meeting documented"],
  ];
  for (let index = 0; index < 9; index += 1) {
    const [type, title] = random.pick(caseKinds);
    const closedDays = random.int(120, historyDays);
    const deadlineValue = iso(closedDays).slice(0, 10);
    const year = Number(deadlineValue.slice(0, 4));
    data.cases.push({
      id: `seed-case-${index + 1}`,
      reference: `ISS-${year}-${random.int(100, 980)}`,
      title, deadline: monthDayLabel(iso(closedDays)),
      type, status: "resolved", overdue: false,
      deadlineValue, updates: [],
    });
  }
  const memberResolved = data.cases.filter((item) => item.status === "resolved").length;
  data.metrics = {
    ...data.metrics,
    casesHandled: data.cases.length,
    openCases: data.cases.filter((item) => item.status === "active").length,
    resolvedCases: memberResolved,
    caseTypes: caseKinds.map(([label]) => ({
      label,
      value: Math.max(1, data.cases.filter((item) => item.type === label).length),
    })),
    weeks: data.metrics.weeks.map(() => random.int(0, 3)),
  };

  // --- Participation: Union Ground has no points economy, so the seed
  // fills the weekly rhythm only (no ledger, tier or points total). ---
  data.weekly = { done: 5, goal: 5, streakDays: 12 };
  data.weekDays = data.weekDays.map((day) => ({ ...day, active: day.today ? day.active : true }));

  // --- Workload: a weekly diary covering the whole window. ---
  for (let week = 4; week < profile.historyYears * 52; week += 1) {
    const logged = iso(week * 7, 9);
    data.workload.entries.push({
      id: `seed-wl-${week}`, receipt: `sd${String(100000 + week * 37).slice(-6)}`,
      counts: {
        priority: random.int(2, 8), pending: random.int(8, 20), unread_docs: random.int(3, 12),
        todos: random.int(2, 9), referrals: random.int(0, 3), ce_activities: random.int(0, 2),
        assistance_requests: random.int(0, 3), aged_cases: random.int(2, 9),
      },
      meta: random.chance(0.85) ? `full-time${random.chance(0.4) ? ` · ${random.int(1, 8)}h OT` : ""}` : "part-time",
      note: random.chance(0.12) ? "covered a colleague's caseload" : "",
      createdAt: logged, dateLabel: monthDayLabel(logged),
    });
  }

  // --- Steward desk: the hat that proves "480 committee members, very busy". ---
  // Main's fixture dropped the caseload arrays the branch-era desk carried;
  // recreate them so the expansion stays shape-stable either way.
  const desk = data.stewardDesk;
  desk.queue = desk.queue ?? [];
  desk.threads = desk.threads ?? [];
  desk.broadcasts = desk.broadcasts ?? [];
  desk.caseload = desk.caseload ?? [];
  desk.formsInbox = desk.formsInbox ?? [];
  desk.kpis = { openRequests: 14, membersCovered: home.memberCount, awaitingReply: 9, broadcasts30d: 6 };
  // Union Ground's organizing-rights lessons (src/data/fallback.js).
  const lessonLabels = ["Section 7", "Supervisor questions", "Cards & majority", "Captive meeting", "Retaliation", ""];
  for (let index = 0; index < 12; index += 1) {
    const person = random.pick(homeRoster);
    desk.queue.push({
      id: `seed-req-${index + 1}`, memberInitials: person.initials, memberName: person.fullName,
      lessonLabel: random.pick(lessonLabels), createdAt: iso(random.int(0, 30), random.int(8, 19)),
      status: random.chance(0.5) ? "requested" : "acknowledged",
    });
  }
  // Desk threads reuse the storyline scripts so the steward inbox reads as
  // ongoing casework in progress — each thread is a mid-arc excerpt, not a
  // one-line ping-pong.
  for (let index = 0; index < 36; index += 1) {
    const person = random.pick(homeRoster);
    const [, script] = messageStorylines[index % messageStorylines.length];
    const excerptLength = random.int(3, Math.min(6, script.length));
    const openedDaysAgo = random.int(1 + excerptLength, historyDays);
    const messages = script.slice(0, excerptLength).map(([kind, body], m) => ({
      id: `seed-thr-${index + 1}-m${m + 1}`,
      sender_kind: kind,
      sender_name: kind === "member" ? person.fullName : "Committee",
      body,
      created_at: iso(openedDaysAgo - m, random.int(8, 20), random.int(0, 59)),
    }));
    const last = messages[messages.length - 1];
    desk.threads.push({
      id: `seed-thr-${index + 1}`, memberInitials: person.initials, memberName: person.fullName,
      preview: last.body, updatedAt: last.created_at,
      awaitingReply: last.sender_kind === "member" && random.chance(0.6),
      messages,
    });
  }
  for (let week = 3; week < profile.historyYears * 52; week += 1) {
    const publishedAt = iso(week * 7 + 1, 14);
    desk.broadcasts.push({
      id: `seed-desk-bc-${week}`, locale: random.chance(0.12) ? "es" : "en", publishedAt, retracted: random.chance(0.02),
      readCount: Math.round(home.memberCount * (0.35 + random.next() * 0.4)),
      title: `${random.pick(broadcastTopics)} — week of ${monthDayLabel(publishedAt)}`,
      body: "Weekly campaign briefing: card-count status, committee office hours, and the actions workers asked for.",
    });
  }
  for (let index = 0; index < 30; index += 1) {
    const person = random.pick(homeRoster);
    const [type, title] = random.pick(caseKinds);
    const resolved = random.chance(0.75);
    const openedDays = random.int(20, historyDays);
    const year = new Date(Date.parse(iso(openedDays))).getUTCFullYear();
    desk.caseload.push({
      id: `seed-sc-${index + 1}`, memberName: person.fullName, memberInitials: person.initials,
      reference: `ISS-${year}-${random.int(100, 980)}`, title,
      caseType: type,
      status: resolved ? "resolved" : "active",
      deadline: iso(resolved ? openedDays - random.int(10, 60) : -random.int(3, 30)).slice(0, 10),
      updatedAt: iso(resolved ? openedDays - random.int(10, 60) : random.int(0, 12), 15),
      assignedAt: iso(openedDays, 14), coordinatorName: "Jordan Patel",
      updates: [], updatesTotal: 0, review: null,
    });
  }
  desk.caseloadWindow = {
    active: desk.caseload.filter((item) => item.status === "active").length,
    resolved: desk.caseload.filter((item) => item.status === "resolved").length,
  };
  const formTemplates = ["grievance", "alt_work", "alliance_grievance", "fmla_self", "service_request", "non_selection"];
  for (let index = 0; index < 22; index += 1) {
    const person = random.pick(homeRoster);
    const submittedAt = iso(random.int(1, historyDays), random.int(9, 18));
    data.stewardDesk.formsInbox.push({
      id: `seed-fi-${index + 1}`, userId: person.userId, memberInitials: person.initials, memberName: person.fullName,
      templateKey: random.pick(formTemplates), status: random.pick(["submitted", "in_review", "approved"]),
      submittedAt, filerSignedAt: submittedAt, filerSignatureDigest: `seed-signature-${index + 1}`, files: [],
      answers: { summary: random.pick(memberOpeners), incident_date: submittedAt.slice(0, 10) }, cosigners: [],
    });
  }

  // --- Steward appointment desk: a calendar that has been full for years. ---
  const apptDesk = data.stewardApptDesk;
  for (let index = 0; index < 8; index += 1) {
    const person = random.pick(homeRoster);
    const startsAt = iso(-random.int(2, 25), random.int(9, 16));
    const duration = random.pick([20, 30, 45]);
    apptDesk.upcoming.push({
      id: `seed-sappt-up-${index + 1}`, memberName: person.fullName, type: random.pick(apptTypes),
      durationMinutes: duration, startsAt,
      endsAt: new Date(Date.parse(startsAt) + duration * 60000).toISOString().replace(".000Z", "Z"),
      status: "confirmed", reasonCategory: random.pick(apptReasons), routedVia: random.chance(0.5) ? "steward" : "chapter",
    });
  }
  for (let index = 0; index < 26; index += 1) {
    const person = random.pick(homeRoster);
    apptDesk.recent.push({
      id: `seed-sappt-past-${index + 1}`, memberName: person.fullName, type: random.pick(apptTypes),
      durationMinutes: random.pick([20, 30, 45]), startsAt: iso(random.int(5, historyDays), random.int(9, 16)),
      status: random.chance(0.85) ? "completed" : "no_show",
    });
  }
  apptDesk.stats = { noShows30d: 2, completed30d: 19 };
  data.chapterAppointmentSupervision.candidates = [...bench];
  for (let index = 0; index < 24; index += 1) {
    const person = random.pick(homeRoster);
    const steward = random.pick(bench);
    const startsAt = iso(random.int(-20, 120), random.int(9, 17));
    const duration = random.pick([20, 30, 45]);
    data.chapterAppointmentSupervision.rows.push({
      id: `seed-chappt-${index + 1}`, memberName: person.fullName, appointmentType: random.pick(apptTypes),
      durationMinutes: duration, startsAt,
      endsAt: new Date(Date.parse(startsAt) + duration * 60000).toISOString().replace(".000Z", "Z"),
      status: Date.parse(startsAt) < anchorMs ? "completed" : "confirmed",
      stewardId: steward.id, stewardName: steward.name,
    });
  }

  // --- Tasks: a board with four years of throughput, not eight cards. ---
  const workstreams = ["Chapter", "Communications", "Organizing", "Issues", "Bargaining", "Safety"];
  const taskTitles = [
    "Prepare campaign meeting", "Publish weekly briefing", "Phone-bank unreached coworkers", "Audit committee coverage map",
    "Draft issue survey", "Update rights one-pagers", "Schedule issue clinic", "Verify meeting check-in codes",
    "Refresh new-committee packet", "Plan caseload-relief action", "Translate worker notices", "Reconcile RSVP lists",
  ];
  const extraAssignees = homeStewards.slice(0, 16).map((person) => ({ id: person.userId, fullName: person.fullName, initials: person.initials }));
  data.taskAssignees = [...data.taskAssignees, ...extraAssignees];
  let taskNumber = Math.max(...data.tasks.map((task) => task.taskNumber)) ;
  for (let index = 0; index < 110; index += 1) {
    taskNumber += 1;
    const ageDays = random.int(2, historyDays);
    const done = ageDays > 45 || random.chance(0.35);
    const status = done ? "done" : random.pick(["backlog", "to_do", "in_progress", "in_progress", "needs_review"]);
    const assignee = random.pick(data.taskAssignees);
    const createdAt = iso(ageDays + random.int(3, 14), 10);
    const doneAt = done ? iso(ageDays, 16) : null;
    data.tasks.push({
      id: `seed-task-${index + 1}`, chapterId: home.id, taskNumber,
      title: `${random.pick(taskTitles)} (${monthDayLabel(createdAt)})`,
      description: "Recurring campaign work generated for the busy-campaign tour.",
      status, priority: random.pick(["low", "medium", "medium", "high"]),
      workstream: random.pick(workstreams),
      assigneeId: assignee.id, assigneeName: assignee.fullName,
      startDate: createdAt.slice(0, 10), dueDate: iso(ageDays - random.int(0, 5)).slice(0, 10),
      progress: status === "done" ? 100 : status === "backlog" || status === "to_do" ? 0 : random.int(20, 90),
      blocked: !done && random.chance(0.08), milestone: random.chance(0.08),
      orderIndex: 100 + index * 10, createdBy: random.pick(data.taskAssignees).id,
      ...(doneAt ? { doneAt } : {}),
      createdAt, updatedAt: doneAt || iso(Math.max(0, ageDays - 2), 15),
    });
  }

  // --- Coordinator desk: the campaign's whole issue queue. ---
  const coord = data.coordinatorDesk;
  for (let index = 0; index < 320; index += 1) {
    const person = random.pick(homeRoster);
    const [type, title] = random.pick(caseKinds);
    const resolved = random.chance(0.78);
    const openedDays = random.int(10, historyDays);
    const deadlineIso = iso(resolved ? openedDays - random.int(15, 60) : -random.int(2, 40));
    coord.cases.push({
      id: `seed-cc-${index + 1}`, reference: `ISS-${3000 + index}`, title, caseType: type,
      status: resolved ? "resolved" : "active",
      deadline: resolved ? "" : deadlineIso.slice(0, 10),
      deadlineLabel: resolved ? "" : monthDayLabel(deadlineIso),
      overdue: !resolved && random.chance(0.1),
      memberName: person.fullName, memberInitials: person.initials,
      updates: random.chance(0.4) ? [{
        id: `seed-cu-${index + 1}`, body: random.pick(stewardReplies),
        createdAt: monthDayLabel(iso(openedDays - 5)), createdAtValue: iso(openedDays - 5, 15),
      }] : [],
    });
  }
  const openCoordCases = coord.cases.filter((item) => item.status === "active");
  coord.kpis = {
    openCases: openCoordCases.length,
    dueThisWeek: openCoordCases.filter((item) => item.deadline && Date.parse(`${item.deadline}T12:00:00Z`) - anchorMs < 7 * DAY_MS).length,
    resolved: coord.cases.length - openCoordCases.length,
    resolutionRate: Math.round(((coord.cases.length - openCoordCases.length) / coord.cases.length) * 100),
  };

  // --- Leadership planes: numbers that tell the 30k-member story. ---
  const staffAppend = homeStewards.slice(0, 40).map((person) => ({
    userId: person.userId, fullName: person.fullName, initials: person.initials,
    memberSince: person.memberSince, roles: ["steward"],
  }));
  const trendYears = profile.historyYears + 2;
  const membershipTrend = Array.from({ length: trendYears }, (_, index) => {
    const year = anchorYear - (trendYears - 1) + index;
    const shrink = Math.pow(0.94, trendYears - 1 - index);
    return { year, count: Math.round(home.memberCount * shrink) };
  });
  data.vpOverview.roster = [...data.vpOverview.roster, ...staffAppend];
  data.vpOverview.overview = {
    ...data.vpOverview.overview,
    memberCount: home.memberCount,
    newThisYear: Math.round(home.memberCount * 0.06),
    activeGrievances: openCoordCases.length,
    turnout: { title: "Petition vote", totalVotes: turnoutBase, quorumTarget: Math.round(home.memberCount * 0.4) },
    attention: [
      ...data.vpOverview.overview.attention,
      ...openCoordCases.filter((item) => item.overdue).slice(0, 6).map((item) => ({
        id: `seed-att-${item.id}`, reference: item.reference, title: item.title,
        deadline: item.deadline, memberName: item.memberName,
      })),
    ],
    membershipTrend,
  };
  data.advisorDesk.roster = [...data.advisorDesk.roster, ...staffAppend];
  data.advisorDesk.overview = {
    ...data.advisorDesk.overview,
    membersCovered: home.memberCount,
    openGrievances: openCoordCases.length,
    resolvedGrievances: coord.cases.length - openCoordCases.length,
    stewardCount: home.stewardCount,
    coverageRatio: Math.round(home.memberCount / home.stewardCount),
    resolutionRate: coord.kpis.resolutionRate,
    turnout: { title: "Petition vote", totalVotes: turnoutBase, quorumTarget: Math.round(home.memberCount * 0.4) },
    atRisk: { overdueCases: openCoordCases.filter((item) => item.overdue).length, unstaffed: false },
  };

  // --- Admin: the whole 20-chapter, 12,000-member organization. ---
  const admin = data.adminDesk;
  admin.organization = {
    ...admin.organization,
    chapters: chapterLandings.map(({ stewardCount: _stewardCount, ...chapter }) => chapter),
  };
  // First directory page + honest totals; search filters the full roster via
  // adminSearchPool below (kept OUT of adminDesk so hat-entry clones stay fast).
  admin.memberDirectory = {
    items: [...admin.memberDirectory.items, ...roster.slice(0, 46)],
    nextCursor: null,
  };
  admin.mfa = { ...admin.mfa, enrolledMembers: Math.round(profile.members * 0.72) };
  const auditActions = ["grant_role", "revoke_role", "create_event", "create_chapter", "update_form_template"];
  for (let index = 0; index < 120; index += 1) {
    const action = random.pick(auditActions);
    const target = random.pick(roster);
    admin.audit.push({
      id: `seed-audit-${index + 1}`, action, actorName: "Alex Rivera",
      targetName: action.includes("role") ? target.fullName : null,
      detail: action.includes("role") ? { role: "steward" } : { note: "campaign operations" },
      createdLabel: monthDayLabel(iso(random.int(2, historyDays))),
    });
  }
  for (let index = 0; index < 12; index += 1) {
    const person = random.pick(roster);
    const createdIso = iso(random.int(0, 40), random.int(9, 17));
    admin.invitations.items.push({
      id: `seed-invite-${index + 1}`,
      normalizedEmail: `${person.fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.org`,
      fullName: person.fullName, chapterId: person.chapterId,
      initialRole: random.chance(0.2) ? "steward" : null,
      locale: random.chance(0.25) ? "es" : "en",
      status: random.pick(["pending", "accepted", "accepted", "expired"]),
      deliveryVersion: 1,
      createdLabel: `${monthDayLabel(createdIso)} · ${timeLabel(createdIso)}`,
      expiresLabel: `${monthDayLabel(createdIso)} · ${timeLabel(new Date(Date.parse(createdIso) + 15 * 60000).toISOString())}`,
    });
  }
  for (let month = 1; month <= profile.historyYears * 12; month += 1) {
    const startsAt = iso(month * 30 - random.int(0, 20), 18);
    const [title, location, summary] = random.pick(eventKinds);
    const rsvpCount = random.int(24, Math.round(home.memberCount * 0.12));
    admin.events.push({
      id: `seed-admin-evt-${month}`, title, startsAt,
      startsLabel: `${weekdayMonthDayLabel(startsAt)} · ${timeLabel(startsAt)}`,
      location, summary, checkInCode: `SD-${String(1000 + month)}`,
      orderIndex: 10 + month, chapterId: home.id, chapterName: home.name,
      isPublic: privateEvent(random, 0.3), isPublicAcrossAgencies: privateEvent(random, 0.1),
      rsvpCount, checkinCount: Math.round(rsvpCount * (0.5 + random.next() * 0.4)),
    });
  }

  // Search pool: pinned demo people first, then every one of the 12,000.
  data.adminSearchPool = [...data.adminSearchPool, ...roster];

  // --- Product hub: years of organized threads, intake, and records. ---
  const spaceNames = [
    ["Recognition path", "Petition timing, card counts, and committee recaps."],
    ["Health & safety", "Hazard reports, walkthrough notes, and fixes won."],
    ["New committee welcome", "Orientation follow-ups and one-on-one pairing."],
    ["Scheduling issue campaign", "Group action planning and the petition to management."],
  ];
  spaceNames.forEach(([name, description], spaceIndex) => {
    const threads = Array.from({ length: 3 }, (_, threadIndex) => {
      const threadAge = random.int(10, historyDays);
      return {
        id: `seed-thread-${spaceIndex}-${threadIndex}`,
        space_id: `seed-space-${spaceIndex}`,
        title: `${name}: ${random.pick(broadcastTopics)}`,
        kind: "issue", status: random.chance(0.6) ? "open" : "resolved",
        updated_at: iso(threadAge, 15),
        posts: Array.from({ length: random.int(2, 6) }, (_, postIndex) => ({
          id: `seed-post-${spaceIndex}-${threadIndex}-${postIndex}`,
          thread_id: `seed-thread-${spaceIndex}-${threadIndex}`,
          body: random.pick([...memberOpeners, ...stewardReplies]),
          created_at: iso(threadAge + postIndex, 12),
        })),
      };
    });
    data.product.spaces.push({
      id: `seed-space-${spaceIndex}`, name, description,
      visibility: "chapter", updated_at: threads[0].updated_at, threads,
    });
  });
  const organizationSpaces = [
    ["Statewide organizing council", "Cross-campaign meeting dates, aggregate priorities, and public campaign materials."],
    ["Shared committee practice", "Organization-wide training threads with no worker-level issue details."],
    ["Campaign leads exchange", "Meeting templates, accessibility practices, and aggregate participation lessons."],
    ["Caseload relief network", "Shared action planning and campaign-level progress across the organization."],
  ];
  const organizationPostBodies = [
    "Campaign leads confirmed the next shared date and posted aggregate participation totals.",
    "The updated resource removes member-level examples and keeps only reusable process guidance.",
    "Accessibility, interpretation, and remote-attendance needs are included in the shared plan.",
    "The council recorded decisions, responsible campaigns, and the next organization-wide checkpoint.",
    "This update compares campaign-level trends without publishing names, issues, or contact details.",
    "The shared toolkit is ready for campaign teams to adapt inside their own authorized workspace.",
  ];
  organizationSpaces.forEach(([name, description], spaceIndex) => {
    const spaceId = `preview-organization-space-${spaceIndex + 1}`;
    const threads = Array.from({ length: 12 }, (_, threadIndex) => {
      const updatedAt = iso(9 + spaceIndex * 5 + threadIndex * 29, 16);
      return {
        id: `${spaceId}-thread-${threadIndex + 1}`,
        space_id: spaceId,
        title: `${name}: ${random.pick(broadcastTopics)}`,
        kind: "issue",
        status: threadIndex % 4 === 0 ? "resolved" : "open",
        updated_at: updatedAt,
        posts: Array.from({ length: 4 }, (_, postIndex) => ({
          id: `${spaceId}-thread-${threadIndex + 1}-post-${postIndex + 1}`,
          thread_id: `${spaceId}-thread-${threadIndex + 1}`,
          body: `${chapterLandings[(spaceIndex + threadIndex + postIndex) % chapterLandings.length].name}: ${random.pick(organizationPostBodies)}`,
          created_at: iso(10 + spaceIndex * 5 + threadIndex * 29 + postIndex, 12),
        })),
      };
    });
    data.product.spaces.push({
      id: spaceId,
      name,
      description,
      visibility: "organization",
      updated_at: threads[0].updated_at,
      threads,
    });
  });
  for (let index = 0; index < 10; index += 1) {
    data.product.intake.push({
      id: `seed-intake-${index + 1}`, category: "workplace_issue",
      title: random.pick(memberOpeners).slice(0, 60),
      details: random.pick(memberOpeners),
      status: random.pick(["new", "triaged", "triaged", "closed"]),
      created_at: iso(random.int(0, historyDays), random.int(8, 19)),
    });
  }
  for (let index = 0; index < 12; index += 1) {
    data.product.records.push({
      id: `seed-record-${index + 1}`, record_type: random.pick(["decision", "meeting", "correspondence"]),
      title: `${random.pick(broadcastTopics)} record`,
      body: "Campaign record generated for the busy-campaign tour: what was decided and who follows up.",
      occurred_at: iso(random.int(5, historyDays), 17),
    });
  }

  return data;
}
