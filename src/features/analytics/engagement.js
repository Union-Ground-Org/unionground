import {
  analyticsAnonymityFloor,
  ENGAGEMENT_EVENT_TAXONOMY,
  ENGAGEMENT_SCORE_BANDS,
} from "./contract.js";
import { average, countBand, enoughForCohort, keepOrganizationRows, protectedCohort, roundRate } from "./privacy.js";

export function scoreEngagementEvents(counts = {}) {
  let score = 0;
  const parts = {};
  for (const [eventType, spec] of Object.entries(ENGAGEMENT_EVENT_TAXONOMY)) {
    const count = Math.max(0, Number(counts[eventType]) || 0);
    const part = Math.min(count / spec.cap, 1) * spec.weight;
    parts[eventType] = { count, part: roundRate(part), cap: spec.cap, weight: spec.weight };
    score += part;
  }
  return {
    score: Math.min(100, roundRate(score)),
    parts,
  };
}

function bandForScore(score) {
  return ENGAGEMENT_SCORE_BANDS.find((band) => score >= band.min && score <= band.max)?.id ?? "0-19";
}

export function buildEngagementScoring(snapshot = {}, viewer = {}) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const chapters = keepOrganizationRows(snapshot.chapters, organizationId);
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const rawCounts = keepOrganizationRows(snapshot.engagementCounts, organizationId);
  const grouped = new Map();
  for (const row of rawCounts) {
    const chapterId = row.chapterId || null;
    if (!chapterId) continue;
    const chapter = chapterById.get(chapterId) || {};
    const current = grouped.get(chapterId) || {
      organizationId,
      chapterId,
      label: row.label || chapter.label || chapterId,
      memberCount: row.memberCount ?? chapter.memberCount ?? 0,
      events: {},
    };
    if (row.events && typeof row.events === "object") {
      for (const [eventType, count] of Object.entries(row.events)) {
        current.events[eventType] = (Number(current.events[eventType]) || 0) + (Number(count) || 0);
      }
    } else if (row.eventType) {
      current.events[row.eventType] = (Number(current.events[row.eventType]) || 0) + (Number(row.count) || 0);
    }
    grouped.set(chapterId, current);
  }
  const chapterCounts = [...grouped.values()];
  const chapterRows = chapterCounts.map((row) => {
    const scored = scoreEngagementEvents(row.events || {});
    return {
      id: row.chapterId,
      label: row.label || row.chapterId,
      memberCount: row.memberCount ?? 0,
      memberBand: countBand(row.memberCount ?? 0, floor),
      score: scored.score,
      parts: scored.parts,
    };
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  // Chapter cohorts can overlap in multi-chapter organizations. Only the
  // authoritative organization membership aggregate is a distinct-person
  // denominator for the organization gate.
  const memberCount = snapshot.membership?.organizationId === organizationId
    ? Number(snapshot.membership.active)
    : NaN;
  if (!enoughForCohort(memberCount, floor)) {
    return {
      ...protectedCohort("anonymity_floor", floor),
      taxonomy: ENGAGEMENT_EVENT_TAXONOMY,
      histogram: null,
      chapters: [],
      mean: null,
    };
  }

  const publishableChapterRows = chapterRows.filter((row) => enoughForCohort(row.memberCount, floor));
  const histogram = Object.fromEntries(ENGAGEMENT_SCORE_BANDS.map((band) => [band.id, 0]));
  for (const row of publishableChapterRows) {
    histogram[bandForScore(row.score)] += 1;
  }

  return {
    enoughData: true,
    reason: null,
    minCohort: floor,
    taxonomy: ENGAGEMENT_EVENT_TAXONOMY,
    mean: average(publishableChapterRows.map((row) => row.score)),
    histogram: Object.fromEntries(Object.entries(histogram).map(([band, count]) => [band, {
      // This counts only chapter cohorts that already cleared the member
      // privacy floor; it is not a person-level heatmap cell.
      value: count,
      suppressed: false,
    }])),
    chapters: publishableChapterRows,
  };
}
