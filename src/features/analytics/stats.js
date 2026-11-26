import { ANALYTICS_COHORT_FLOOR, ANALYTICS_STATS_TABS, analyticsAnonymityFloor } from "./contract.js";
import {
  countBand,
  enoughForCohort,
  keepOrganizationRows,
  protectedCohort,
  roundRate,
} from "./privacy.js";

const OPEN_STATUSES = new Set(["active", "open"]);
const RESOLVED_STATUSES = new Set(["resolved", "closed"]);

function isOpenCase(row) {
  return OPEN_STATUSES.has(row.status);
}

function isResolvedCase(row) {
  return RESOLVED_STATUSES.has(row.status);
}

function isEscalatedCase(row) {
  return Number(row.step) >= 2;
}

function caseCount(row) {
  if (row?.count == null) return 1;
  const value = Number(row.count);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sortedEntries(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function protectedEntries(map, floor = ANALYTICS_COHORT_FLOOR) {
  return sortedEntries(map).filter((row) => enoughForCohort(row.count, floor));
}

export function computeAverageOpenCasesPerSteward(openCases, stewardCount) {
  if (!Number.isFinite(stewardCount) || stewardCount <= 0) return null;
  if (!Number.isFinite(openCases) || openCases < 0) return null;
  return roundRate(openCases / stewardCount);
}

function buildWorkplaceHotspots(cases, { floor = ANALYTICS_COHORT_FLOOR } = {}) {
  const byWorkplace = new Map();
  for (const row of cases) {
    const name = row.workplaceKey || "unspecified";
    const current = byWorkplace.get(name) || { grievances: 0, escalated: 0 };
    const count = caseCount(row);
    current.grievances += count;
    if (isEscalatedCase(row)) current.escalated += count;
    byWorkplace.set(name, current);
  }

  const rows = [...byWorkplace.entries()]
    .map(([name, stats]) => ({
      name,
      grievances: stats.grievances,
      escalated: stats.escalated,
      rate: stats.grievances ? Math.round((stats.escalated / stats.grievances) * 100) : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.grievances - a.grievances || a.name.localeCompare(b.name));

  const publishableRows = rows.filter((row) => enoughForCohort(row.grievances, floor));
  if (publishableRows.length === 0) {
    return protectedCohort("anonymity_floor", floor);
  }
  return { enoughData: true, reason: null, minCohort: floor, rows: publishableRows };
}

function compareChapterRows(chapters, cases, floor) {
  return chapters.map((chapter) => {
    const chapterCases = cases.filter((row) => row.chapterId === chapter.id);
    const openCases = chapterCases.filter(isOpenCase).reduce((sum, row) => sum + caseCount(row), 0);
    const resolvedCases = chapterCases.filter(isResolvedCase).reduce((sum, row) => sum + caseCount(row), 0);
    return {
      id: chapter.id,
      label: chapter.label || chapter.id,
      memberCount: Number.isFinite(chapter.memberCount) ? chapter.memberCount : null,
      memberBand: countBand(chapter.memberCount, floor),
      stewardCount: Number.isFinite(chapter.stewardCount) ? chapter.stewardCount : null,
      openCases,
      resolvedCases,
      averageOpenPerSteward: computeAverageOpenCasesPerSteward(openCases, chapter.stewardCount),
    };
  }).sort((a, b) => b.openCases - a.openCases || a.label.localeCompare(b.label));
}

export function buildOrganizationStatsSuite(snapshot = {}, viewer = {}) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const chapters = keepOrganizationRows(snapshot.chapters, organizationId);
  const cases = keepOrganizationRows(snapshot.cases, organizationId);
  const membership = snapshot.membership && snapshot.membership.organizationId === organizationId
    ? snapshot.membership
    : { active: null, newIn90: null, organizationId };

  const rawOpenCases = cases.filter(isOpenCase).reduce((sum, row) => sum + caseCount(row), 0);
  const rawResolvedCases = cases.filter(isResolvedCase).reduce((sum, row) => sum + caseCount(row), 0);
  const stewardSuppressed = chapters.some((chapter) => !Number.isFinite(chapter.stewardCount));
  const rawStewardCount = stewardSuppressed
    ? null
    : chapters.reduce((sum, chapter) => sum + chapter.stewardCount, 0);
  const memberCount = Number.isFinite(membership.active)
    ? membership.active
    : null;

  const byStatus = new Map();
  const byType = new Map();
  const byStep = new Map();
  for (const row of cases) {
    const count = caseCount(row);
    increment(byStatus, row.status || "unknown", count);
    increment(byType, row.type || row.workplaceKey || "unspecified", count);
    increment(byStep, String(row.step ?? "0"), count);
  }

  const chapterRows = compareChapterRows(chapters, cases, floor);
  const publishableChapterRows = chapterRows.filter((row) => enoughForCohort(row.memberCount, floor));
  const chapterCaseTotalsSuppressed = publishableChapterRows.length !== chapterRows.length;
  const openCases = chapterCaseTotalsSuppressed ? null : rawOpenCases;
  const resolvedCases = chapterCaseTotalsSuppressed ? null : rawResolvedCases;
  const stewardCount = stewardSuppressed || chapterCaseTotalsSuppressed ? null : rawStewardCount;
  // Only the new scoped fallback requires proof that no case groups were
  // omitted. Preserve the existing organization and chapter figures.
  const publishedComplete = snapshot.caseGroupsComplete === true
    || chapters.filter((chapter) => enoughForCohort(chapter.memberCount))
      .every((chapter) => chapter.caseGroupsComplete === true);
  const publishedChapterTotalsIncomplete = chapterCaseTotalsSuppressed
    && publishableChapterRows.length > 0 && !publishedComplete;
  const publishedOpenCases = publishableChapterRows.reduce((sum, row) => sum + row.openCases, 0);
  const publishedResolvedCases = publishableChapterRows.reduce((sum, row) => sum + row.resolvedCases, 0);
  const publishedChapterTotals = chapterCaseTotalsSuppressed && publishableChapterRows.length > 0 && publishedComplete
    ? {
      chapters: publishableChapterRows.length,
      of: chapterRows.length,
      openCases: publishedOpenCases,
      resolvedCases: publishedResolvedCases,
      resolutionRate: publishedOpenCases + publishedResolvedCases
        ? Math.round((publishedResolvedCases / (publishedOpenCases + publishedResolvedCases)) * 100)
        : null,
    }
    : null;
  const chapterCohort = publishableChapterRows.length > 0
    ? { enoughData: true, reason: null, minCohort: floor, rows: publishableChapterRows }
    : protectedCohort("anonymity_floor", floor);

  const workplaces = chapterCaseTotalsSuppressed ? protectedCohort("anonymity_floor", floor) : buildWorkplaceHotspots(cases, { floor });
  const membershipProtected = enoughForCohort(memberCount, floor)
    ? {
      enoughData: true,
      reason: null,
      minCohort: floor,
      active: memberCount,
      newIn90: Number.isFinite(membership.newIn90) ? membership.newIn90 : null,
      band: countBand(memberCount, floor),
    }
    : protectedCohort("anonymity_floor", floor);

  return {
    tabs: ANALYTICS_STATS_TABS,
    overview: {
      // Organization membership is intentionally published as a band. An
      // exact total can be differenced against chapter bands to recover a
      // protected small chapter.
      activeMembers: null,
      memberBand: membershipProtected.band ?? null,
      openCases,
      resolvedCases,
      casesSuppressed: chapterCaseTotalsSuppressed,
      publishedChapterTotalsIncomplete,
      resolutionRate: Number.isFinite(openCases) && Number.isFinite(resolvedCases) && openCases + resolvedCases
        ? Math.round((resolvedCases / (openCases + resolvedCases)) * 100)
        : null,
      stewardCount,
      stewardsSuppressed: stewardSuppressed || chapterCaseTotalsSuppressed,
      averageOpenPerSteward: computeAverageOpenCasesPerSteward(openCases, stewardCount),
      chapterCount: chapters.length,
      publishedChapterTotals,
      // Case rows arrive already floored per group; none means no group of
      // cases reached the floor (or there are no cases), not a known zero.
      caseGroups: cases.length,
    },
    chapters: chapterCohort,
    workplaces,
    cases: chapterCaseTotalsSuppressed
      ? { ...protectedCohort("anonymity_floor", floor), byStatus: [], byType: [], byStep: [] }
      : {
        enoughData: cases.length > 0,
        reason: cases.length ? null : "empty",
        // Each published breakdown is independently floored. A safe chapter
        // total does not make a rare case type or step safe to reveal.
        byStatus: protectedEntries(byStatus, floor),
        byType: protectedEntries(byType, floor),
        byStep: protectedEntries(byStep, floor),
        // Every status bucket fell under the floor. Only an un-floored
        // snapshot (the demo/preview adapter) reaches this; hosted rows are
        // floored per group before they arrive. The desk explains the
        // withholding instead of reading as an empty breakdown.
        statusFloored: byStatus.size > 0 && protectedEntries(byStatus, floor).length === 0,
      },
    stewards: {
      enoughData: Number.isFinite(stewardCount) && stewardCount > 0,
      reason: stewardSuppressed ? "anonymity_floor" : stewardCount ? null : "no_stewards",
      suppressed: stewardSuppressed || chapterCaseTotalsSuppressed,
      stewardCount,
      openCases,
      averageOpenPerSteward: computeAverageOpenCasesPerSteward(openCases, stewardCount),
    },
    membership: membershipProtected,
    comparison: chapterCohort.enoughData
      ? {
        enoughData: true,
        reason: null,
        minCohort: floor,
        rows: publishableChapterRows.map((row) => ({
          id: row.id,
          label: row.label,
          openCases: row.openCases,
          resolvedCases: row.resolvedCases,
          memberBand: row.memberBand,
          averageOpenPerSteward: row.averageOpenPerSteward,
        })),
      }
      : protectedCohort("anonymity_floor", floor),
  };
}
