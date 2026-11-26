// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001
//
// Shapes public.get_compass_staff_data_context() output into the only figures
// that may cross the provider boundary: numbers and closed-vocabulary or
// pattern-checked labels. Campaign names are replaced by "Campaign N"
// placeholders (restored in the answer server-side, so they never reach a
// provider). Analytics cohorts must clear ANALYTICS_COHORT_FLOOR again here:
// a snapshot that claims a different floor is refused, and any member, steward
// or engagement count under the floor is dropped even if the RPC sent it.
// Caseload and outcome counts describe cases the caller can already open
// (private.casework_staff_can_access), not member cohorts, so they keep exact
// values like the staff dashboards do.
import { ANALYTICS_COHORT_FLOOR } from "../../src/features/analytics/contract.js";
import { STAFF_DATA_TOPICS } from "../../src/features/compass/dataTopics.js";

// Union Ground has no grievance steps, contract articles or legal filing
// deadlines, so none of them crosses to the Guide: only the issue deadline
// kinds the web offers (response, follow-up) are named.
const DEADLINE_KINDS = new Set(["response", "follow_up"]);
const OUTCOMES = ["upheld", "settled", "denied", "withdrawn", "other"];
const WORKSPACE_STATUSES = new Set(["planning", "live", "paused", "tentative_agreement", "closed"]);
const PROPOSAL_SIDES = new Set(["union", "management", "joint"]);
const PROPOSAL_STATUSES = new Set(["draft", "proposed", "countered", "tentative", "accepted", "rejected", "withdrawn"]);
const ENGAGEMENT_EVENTS = new Set(["meeting_check_in", "qa_contribution", "poll_vote", "survey_response", "event_rsvp", "authorized_contact"]);
const HEALTH_DRIVERS = ["participation", "caseTimeliness", "stewardCapacity", "trainingCoverage", "communicationReach", "governanceReadiness"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function count(value) {
  const number = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000 ? number : null;
}

function measure(value, maximum = 1_000_000) {
  const number = typeof value === "string" && /^-?\d{1,9}(?:\.\d{1,6})?$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= maximum
    ? Math.round(number * 10) / 10
    : null;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function compact(rows) {
  return rows.filter((row) => Object.values(row).every((value) => value !== null && value !== undefined));
}

function share(part, whole) {
  return whole > 0 ? Math.round((1000 * part) / whole) / 10 : null;
}

export function createChapterLegend(prefix = "Campaign") {
  const names = new Map();
  return {
    label(id, name) {
      const key = typeof id === "string" && id ? id : null;
      if (!key) return null;
      const clean = typeof name === "string" ? name.trim().slice(0, 120) : "";
      if (!names.has(key)) names.set(key, { placeholder: `${prefix} ${names.size + 1}`, name: clean });
      else if (!names.get(key).name && clean) names.get(key).name = clean;
      return names.get(key).placeholder;
    },
    entries() {
      return [...names.values()];
    },
  };
}

function caseload(data) {
  if (!object(data) || data.unavailable === true) return { unavailable: true };
  return {
    overdueDeadlines: compact(list(data.overdue).slice(0, 10).map((row) => ({
      kind: DEADLINE_KINDS.has(row.kind) ? row.kind : null,
      deadlines: count(row.deadlines), cases: count(row.cases), oldestDaysOverdue: count(row.oldestDaysOverdue),
    }))),
    deadlinesDueSoon: compact(list(data.dueSoon).slice(0, 31).map((row) => ({ daysOut: count(row.daysOut), deadlines: count(row.deadlines), cases: count(row.cases) }))),
  };
}

function outcomes(data) {
  if (!object(data) || data.unavailable === true) return { unavailable: true };
  const byOutcome = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, count(object(data.byOutcome)?.[outcome]) ?? 0]));
  const recorded = OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0);
  return {
    openCases: count(data.openCases),
    resolvedCases: count(data.resolved),
    resolvedShareOfAllCasesPercent: measure(data.resolutionRate, 100),
    recordedOutcomes: byOutcome,
    recordedOutcomeTotal: recorded,
    // The old app counted a sustained grievance as a win
    // (de7df4b57c^ lib/claude/tools/grievance-tools.ts:24-55).
    upheldPercentOfRecordedOutcomes: share(byOutcome.upheld, recorded),
    upheldOrSettledPercentOfRecordedOutcomes: share(byOutcome.upheld + byOutcome.settled, recorded),
  };
}

function floored(value, floor) {
  const number = count(value);
  return number !== null && number >= floor ? number : null;
}

function membership(data, legend) {
  if (!object(data) || data.unavailable === true || Number(data.privacyThreshold) !== ANALYTICS_COHORT_FLOOR) return { unavailable: true };
  const floor = ANALYTICS_COHORT_FLOOR;
  const windows = object(data.usageWindows);
  const suppressed = object(windows?.suppressed) || {};
  return {
    cohortFloor: floor,
    chapters: list(data.chapters).slice(0, 200).map((row) => ({
      chapter: legend.label(row.id, row.label),
      members: row.memberCountSuppressed === true ? null : floored(row.memberCount, floor),
      stewards: row.stewardCountSuppressed === true ? null : floored(row.stewardCount, floor),
    })).filter((row) => row.chapter),
    activePeople: windows ? {
      lastDay: suppressed.dau === true ? null : floored(windows.dau, floor),
      last7Days: suppressed.wau === true ? null : floored(windows.wau, floor),
      last30Days: suppressed.mau === true ? null : floored(windows.mau, floor),
    } : null,
  };
}

function health(data, legend) {
  if (!object(data) || data.unavailable === true) return { unavailable: true };
  const floor = ANALYTICS_COHORT_FLOOR;
  const snapshotTrusted = Number(data.privacyThreshold) === floor;
  for (const row of list(data.chapterLabels)) legend.label(row.id, row.label);
  return {
    cohortFloor: floor,
    chapterHealthScores: list(data.chapters).slice(0, 200).flatMap((row) => {
      // The portfolio protects cohorts under 10; Compass input holds to the
      // analytics floor instead.
      if (floored(row.memberCount, floor) === null || measure(row.score, 100) === null) return [];
      const drivers = object(row.drivers) || {};
      return [{
        chapter: legend.label(row.chapterId, row.label),
        score: measure(row.score, 100),
        drivers: Object.fromEntries(HEALTH_DRIVERS.map((key) => [key, measure(drivers[key], 100)]).filter(([, value]) => value !== null)),
        trend: compact(list(row.trend).slice(-12).map((point) => ({
          measuredOn: typeof point.measuredOn === "string" && DATE.test(point.measuredOn) ? point.measuredOn : null,
          score: measure(point.score, 100),
        }))),
      }];
    }),
    chapterActivity: snapshotTrusted ? list(data.series).slice(0, 200).map((row) => ({
      chapter: legend.label(row.chapterId, null),
      attendanceRatePercent: measure(row.attendanceRate, 100),
      engagementMean: measure(row.engagementMean, 100),
      activePeople30Days: floored(row.usageViews, floor),
    })).filter((row) => row.chapter && (row.attendanceRatePercent !== null || row.engagementMean !== null || row.activePeople30Days !== null)) : [],
    peopleByActivity180Days: snapshotTrusted ? compact(list(data.engagementCounts).slice(0, 200).map((row) => ({
      chapter: legend.label(row.chapterId, null),
      activity: ENGAGEMENT_EVENTS.has(row.eventType) ? row.eventType : null,
      people: floored(row.count, floor),
    }))) : [],
  };
}

function bargaining(data) {
  if (!object(data) || data.unavailable === true) return { unavailable: true };
  const workspaces = object(data.workspacesByStatus) || {};
  return {
    tablesByStatus: Object.fromEntries(Object.entries(workspaces)
      .filter(([status]) => WORKSPACE_STATUSES.has(status))
      .map(([status, value]) => [status, count(value)])
      .filter(([, value]) => value !== null)),
    proposals: compact(list(data.proposalsBySideAndStatus).slice(0, 30).map((row) => ({
      side: PROPOSAL_SIDES.has(row.side) ? row.side : null,
      status: PROPOSAL_STATUSES.has(row.status) ? row.status : null,
      proposals: count(row.proposals),
    }))),
    responsesDueWithin7Days: count(data.responsesDueWithin7Days),
    responsesOverdue: count(data.responsesOverdue),
  };
}

// Throws when the envelope is not the RPC's shape, so a malformed read is an
// outage, never an empty answer.
export function buildStaffDataFacts(envelope) {
  const data = object(envelope?.data);
  const topics = Array.isArray(envelope?.topics) ? envelope.topics.filter((topic) => STAFF_DATA_TOPICS.includes(topic)) : [];
  if (!data || !topics.length) throw new Error("staff-data-context-invalid");
  const legend = createChapterLegend();
  const builders = { caseload, outcomes, membership, health, bargaining };
  const figures = {};
  for (const topic of topics) figures[topic] = builders[topic](data[topic], legend);
  const available = topics.some((topic) => figures[topic]?.unavailable !== true);
  return { topics, figures, available, legend: legend.entries() };
}

// Swap the placeholders back for campaign names in the generated answer. Names
// never reach a provider; an unknown placeholder is left as written. Union
// Ground also restores "Other step N" placeholders here; Union Ground sends
// no case step at all (grievance steps are left out), so campaign placeholders
// are the only kind it issues.
export function restorePlaceholderNames(answer, legend) {
  if (typeof answer !== "string" || !Array.isArray(legend) || !legend.length) return answer;
  const names = new Map(legend.filter((entry) => entry?.name).map((entry) => [entry.placeholder, entry.name]));
  return answer.replace(/\bCampaign (\d{1,3})\b/g, (match) => names.get(match) ?? match);
}
