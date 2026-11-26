// Explicitly labeled PREVIEW fixtures for tests and unset-desk demonstrations.
// These never represent a real organization and must not be written to live
// or SAMPLE Postgres.

import { ANALYTICS_COHORT_FLOOR } from "./contract.js";

const PREVIEW_ORG = "preview-analytics-org";
const OTHER_ORG = "preview-other-org";
const DAY_MS = 24 * 60 * 60 * 1000;

function validNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function rollingUsageViews(now) {
  const paths = ["/m", "/m/steward", "/m/numbers"];
  const hats = ["member", "steward", "member"];
  return Array.from({ length: 30 }, (_, offset) => {
    const day = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    const lane = offset % paths.length;
    return {
      organizationId: PREVIEW_ORG,
      path: paths[lane],
      hat: hats[lane],
      day,
      count: 18 + ((29 - offset) % 11),
    };
  });
}

function rollingAttendanceEvents(now, chapters) {
  return Array.from({ length: 36 }, (_, offset) => {
    const startsAt = new Date(now.getTime());
    startsAt.setUTCDate(1);
    startsAt.setUTCMonth(startsAt.getUTCMonth() - offset);
    startsAt.setUTCDate(Math.min(now.getUTCDate(), 20));
    startsAt.setUTCHours(17, 0, 0, 0);
    const selectedChapter = chapters[offset % chapters.length];
    const rsvpGoing = 28 + ((35 - offset) % 13);
    return {
      organizationId: PREVIEW_ORG,
      id: `preview-event-${startsAt.toISOString().slice(0, 7)}`,
      chapterId: selectedChapter.id,
      startsAt: startsAt.toISOString(),
      rsvpGoing,
      checkIns: rsvpGoing - 4 - (offset % 5),
    };
  });
}

function chapter(id, members, stewards) {
  return {
    id,
    label: `PREVIEW ${id}`,
    organizationId: PREVIEW_ORG,
    memberCount: members,
    stewardCount: stewards,
  };
}

function casesFor(chapterId, workplaceKey, open, resolved, step = 1) {
  const rows = [];
  for (let index = 0; index < open; index += 1) {
    rows.push({
      organizationId: PREVIEW_ORG,
      chapterId,
      workplaceKey,
      status: "active",
      type: index % 2 ? "discipline" : "contract",
      step,
    });
  }
  for (let index = 0; index < resolved; index += 1) {
    rows.push({
      organizationId: PREVIEW_ORG,
      chapterId,
      workplaceKey,
      status: "resolved",
      type: "contract",
      step: 3,
    });
  }
  return rows;
}

export function createPreviewAnalyticsSnapshot(at = new Date()) {
  const now = validNow(at);
  const chapters = [
    chapter("north", 40, 3),
    chapter("south", 36, 2),
    chapter("east", 32, 2),
    chapter("west", 28, 2),
  ];

  return {
    organizationId: PREVIEW_ORG,
    privacyThreshold: ANALYTICS_COHORT_FLOOR,
    generatedAt: now.toISOString(),
    label: "PREVIEW",
    // This fixture contains every case; hosted snapshots make no such claim.
    caseGroupsComplete: true,
    chapters,
    membership: { organizationId: PREVIEW_ORG, active: 136, newIn90: 11 },
    cases: [
      ...casesFor("north", "campus-a", 8, 6, 2),
      ...casesFor("south", "campus-b", 5, 9, 1),
      ...casesFor("east", "campus-a", 4, 4, 3),
      ...casesFor("west", "campus-c", 3, 5, 1),
      { organizationId: OTHER_ORG, chapterId: "foreign", workplaceKey: "leak", status: "active", type: "discipline", step: 2 },
    ],
    usageViews: [
      ...rollingUsageViews(now),
      { organizationId: OTHER_ORG, path: "/m/admin", hat: "admin", day: now.toISOString().slice(0, 10), count: 99 },
    ],
    usageWindows: { organizationId: PREVIEW_ORG, dau: 22, wau: 71, mau: 118 },
    series: chapters.map((item, index) => ({
      organizationId: PREVIEW_ORG,
      chapterId: item.id,
      attendanceRate: 58 + index * 6,
      openCases: 8 - index,
      engagementMean: 42 + index * 5,
      usageViews: 20 + index * 4,
    })),
    heatmapPoints: [
      { organizationId: PREVIEW_ORG, kind: "grievance", rowKey: "campus-a", colKey: "nursing", count: 9 },
      { organizationId: PREVIEW_ORG, kind: "grievance", rowKey: "campus-a", colKey: "facilities", count: 2 },
      { organizationId: PREVIEW_ORG, kind: "grievance", rowKey: "campus-b", colKey: "nursing", count: 7 },
      { organizationId: PREVIEW_ORG, kind: "solidarity", rowKey: "campus-a", colKey: "nursing", count: 14 },
      { organizationId: PREVIEW_ORG, kind: "solidarity", rowKey: "campus-b", colKey: "facilities", count: 6 },
      { organizationId: OTHER_ORG, kind: "grievance", rowKey: "leak", colKey: "nursing", count: 40 },
    ],
    engagementCounts: [
      { organizationId: PREVIEW_ORG, chapterId: "north", label: "PREVIEW north", memberCount: 40, events: { meeting_check_in: 8, qa_contribution: 6, poll_vote: 4, survey_response: 2, event_rsvp: 5, authorized_contact: 3 } },
      { organizationId: PREVIEW_ORG, chapterId: "south", label: "PREVIEW south", memberCount: 36, events: { meeting_check_in: 6, qa_contribution: 4, poll_vote: 3, survey_response: 1, event_rsvp: 4, authorized_contact: 2 } },
      { organizationId: PREVIEW_ORG, chapterId: "east", label: "PREVIEW east", memberCount: 32, events: { meeting_check_in: 5, qa_contribution: 3, poll_vote: 2, survey_response: 1, event_rsvp: 3, authorized_contact: 1 } },
      { organizationId: PREVIEW_ORG, chapterId: "west", label: "PREVIEW west", memberCount: 28, events: { meeting_check_in: 4, qa_contribution: 2, poll_vote: 2, survey_response: 1, event_rsvp: 2, authorized_contact: 1 } },
    ],
    engagementHistogram: {
      organizationId: PREVIEW_ORG,
      bands: { "0-19": 18, "20-39": 41, "40-59": 47, "60-79": 22, "80-100": 8 },
    },
    attendanceEvents: [
      ...rollingAttendanceEvents(now, chapters),
      { organizationId: OTHER_ORG, id: "leak-event", chapterId: "foreign", startsAt: now.toISOString(), rsvpGoing: 80, checkIns: 80 },
    ],
    attendanceCohorts: { organizationId: PREVIEW_ORG, firstTime: 40, repeat: 55 },
  };
}

export function createPreviewAnalyticsWorkspace(at = new Date()) {
  const now = validNow(at);
  const chapters = [
    { id: "north", name: "North Campaign", memberCount: 40, score: 78 },
    { id: "south", name: "South Campaign", memberCount: 36, score: 69 },
    { id: "east", name: "East Campaign", memberCount: 32, score: 74 },
    { id: "west", name: "West Campaign", memberCount: 28, score: 63 },
  ];
  const people = [
    ["Avery Chen", "north", 82, "steady"],
    ["Jordan Brooks", "north", 58, "watch"],
    ["Maya Patel", "north", 41, "support"],
    ["Elias Romero", "south", 76, "steady"],
    ["Nia Wallace", "south", 49, "watch"],
    ["Theo Martin", "south", 32, "urgent"],
    ["Rina Okafor", "east", 88, "steady"],
    ["Luis Alvarez", "east", 64, "steady"],
    ["Camila Torres", "east", 46, "support"],
    ["Morgan Lee", "west", 72, "steady"],
    ["Samira Hassan", "west", 55, "watch"],
    ["Noah Williams", "west", 37, "support"],
  ];
  const trends = new Map(chapters.map((item, chapterIndex) => [item.id,
    Array.from({ length: 36 }, (_, reverseIndex) => {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (35 - reverseIndex), 1));
      return {
        measuredOn: month.toISOString().slice(0, 10),
        score: Math.max(25, Math.min(95, item.score - 7 + Math.round(reverseIndex / 6) + ((reverseIndex + chapterIndex) % 4))),
      };
    }),
  ]));
  const members = people.map(([name, chapterId, score, attention], index) => {
    const chapterItem = chapters.find((item) => item.id === chapterId);
    return {
      organizationId: PREVIEW_ORG,
      id: `preview-member-${index + 1}:${chapterId}`,
      name,
      chapterId,
      chapterName: chapterItem.name,
      participationScore: score,
      profileReadiness: index % 5 === 0 ? 75 : 100,
      followThrough: Math.max(20, score - 8 + (index % 3) * 7),
      overallScore: score,
      attention,
      activeCases: index % 4,
      overdueCases: attention === "urgent" ? 1 : 0,
      lastActivityAt: new Date(now.getTime() - index * DAY_MS).toISOString(),
    };
  });
  const datasets = [{
    organizationId: PREVIEW_ORG,
    id: "organization:chapter-health",
    label: "Campaign health",
    description: "Latest protected campaign health score.",
    scope: "organization",
    chapterId: null,
    rows: chapters.map((item) => ({ label: item.name, value: item.score })),
  }, ...chapters.map((item) => ({
    organizationId: PREVIEW_ORG,
    id: `chapter:${item.id}:health-trend`,
    label: `${item.name} health trend`,
    description: "Protected rolling three-year campaign score.",
    scope: "chapter",
    chapterId: item.id,
    rows: trends.get(item.id).map((point) => ({ label: point.measuredOn.slice(0, 7), value: point.score })),
  }))];
  return {
    organizationId: PREVIEW_ORG,
    generatedAt: now.toISOString(),
    privacyThreshold: ANALYTICS_COHORT_FLOOR,
    members,
    chapterHealth: chapters.map((item) => ({
      organizationId: PREVIEW_ORG,
      chapterId: item.id,
      chapterName: item.name,
      memberCount: item.memberCount,
      protected: false,
      score: item.score,
      drivers: {
        participation: item.score - 3,
        caseTimeliness: item.score + 2,
        stewardCapacity: item.score - 6,
      },
      trend: trends.get(item.id),
    })),
    datasets,
    layouts: chapters.slice(0, 2).map((item) => ({
      id: `preview-layout-${item.id}`,
      organizationId: PREVIEW_ORG,
      name: `${item.name} scorecard`,
      scope: "chapter",
      chapterId: item.id,
      spec: { datasetId: `chapter:${item.id}:health-trend`, chartType: "line", title: `${item.name} scorecard` },
      canEdit: true,
      updatedAt: now.toISOString(),
    })),
  };
}

export function createPreviewAnalyticsViewer(overrides = {}) {
  const roles = overrides.roles ?? ["steward"];
  return {
    organizationId: PREVIEW_ORG,
    chapterId: "north",
    selectedHat: "steward",
    roles,
    organizationRoles: overrides.organizationRoles ?? roles,
    chapterRoles: overrides.chapterRoles ?? [],
    userId: "preview-staff",
    ...overrides,
  };
}
