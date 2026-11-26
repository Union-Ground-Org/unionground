import { connectionDateMs } from "./time.js";
import {
  CONNECTION_ISSUE_TOPICS,
  CONNECTION_SIGNAL_KINDS,
  CONNECTION_TAXONOMY_VERSION,
  organizationConnectionIssueFloor,
} from "./contract.js";

// Local, bounded classification proposes a topic for a human to review. It does
// not assert a finding, copy source text, or authorize publication of any signal.
const topicPatterns = Object.freeze({
  staffing: /(?<![\p{L}\p{N}_])(staffing|understaffed|vacancies|headcount)(?![\p{L}\p{N}_])/u,
  scheduling: /(?<![\p{L}\p{N}_])(schedule|schedules|scheduling|shift|shifts|roster)(?![\p{L}\p{N}_])/u,
  pay: /(?<![\p{L}\p{N}_])(pay|wage|wages|salary|salaries|payroll|overtime)(?![\p{L}\p{N}_])/u,
  benefits: /(?<![\p{L}\p{N}_])(benefits|pension|pensions|insurance|retirement)(?![\p{L}\p{N}_])/u,
  safety: /(?<![\p{L}\p{N}_])(safety|unsafe|hazard|hazards|injury|injuries)(?![\p{L}\p{N}_])/u,
  discipline: /(?<![\p{L}\p{N}_])(discipline|disciplinary|suspension|dismissal|termination)(?![\p{L}\p{N}_])/u,
  discrimination: /(?<![\p{L}\p{N}_])(discrimination|discriminatory|harassment|retaliation)(?![\p{L}\p{N}_])/u,
  workload: /(?<![\p{L}\p{N}_])(workload|caseload|overwork|overworked|burnout)(?![\p{L}\p{N}_])/u,
  training: /(?<![\p{L}\p{N}_])(training|onboarding|certification|apprenticeship)(?![\p{L}\p{N}_])/u,
  "contract-enforcement": /(?<![\p{L}\p{N}_])(contract|agreement|grievance|arbitration)(?![\p{L}\p{N}_])/u,
});

export function proposeConnectionIssueTags({ sourceKind, category, text } = {}) {
  if (!CONNECTION_SIGNAL_KINDS.includes(sourceKind)) return { state: "unsupported_source", proposals: [] };
  const normalized = typeof text === "string" ? text.normalize("NFKC").toLowerCase() : "";
  let bounded = normalized.slice(0, 10000);
  // Do not turn a cut word such as payment into the distinct keyword pay.
  if (normalized.length > 10000 && /\S/u.test(normalized[10000])) bounded = bounded.replace(/\S+$/u, "");
  const proposals = CONNECTION_ISSUE_TOPICS.flatMap((key) => {
    const fromCategory = category === key;
    if (!fromCategory && !topicPatterns[key].test(bounded)) return [];
    return [{ key, source: fromCategory ? "category" : "text", reviewRequired: true }];
  });
  return { state: "review_required", sourceKind, proposals };
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function windowBounds(start, end, asOf) {
  const first = dateOnly(start);
  const last = dateOnly(end);
  const now = typeof asOf === "number" ? asOf : connectionDateMs(asOf);
  if (!first || !last || first.getUTCDate() !== 1 || first.getUTCMonth() % 3 !== 0 || !Number.isFinite(now)) return null;
  const expectedEnd = new Date(first);
  expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 3);
  if (last.getTime() !== expectedEnd.getTime() || last.getTime() > now) return null;
  return { start: first.getTime(), end: last.getTime() };
}

function nonemptyId(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
}

// This is a privacy transform, not an authorization boundary. The caller must
// authenticate scope, derive contributor IDs from source records, and require
// human confirmation before calling it. Client-supplied counts are never used.
// Closed calendar quarters prevent arbitrary overlapping-window queries here;
// publication/republication policy remains the server's responsibility.
export function aggregateConfirmedConnectionSignals({ organizationId, chapterId, windowStart, windowEnd, asOf, observations = [], configuration = null } = {}) {
  const output = {
    schema: 1,
    taxonomyVersion: CONNECTION_TAXONOMY_VERSION,
    windowStart: dateOnly(windowStart)?.toISOString().slice(0, 10) || null,
    windowEnd: dateOnly(windowEnd)?.toISOString().slice(0, 10) || null,
    state: "suppressed",
    issuePriorities: [],
  };
  const bounds = windowBounds(windowStart, windowEnd, asOf);
  const floor = organizationConnectionIssueFloor(configuration);
  if (!nonemptyId(organizationId) || !nonemptyId(chapterId) || !bounds) return { ...output, state: "invalid_scope_or_window" };
  const subjects = new Map();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!observation || observation.organizationId !== organizationId || observation.chapterId !== chapterId
      || !nonemptyId(observation.subjectId) || !CONNECTION_SIGNAL_KINDS.includes(observation.sourceKind)
      || observation.reviewStatus !== "confirmed" || !Array.isArray(observation.topicKeys)
      || observation.topicKeys.some((key) => !CONNECTION_ISSUE_TOPICS.includes(key))) continue;
    const occurred = connectionDateMs(observation.occurredAt);
    if (!Number.isFinite(occurred) || occurred < bounds.start || occurred >= bounds.end) continue;
    if (!subjects.has(observation.subjectId)) subjects.set(observation.subjectId, new Set());
    const topics = subjects.get(observation.subjectId);
    for (const key of observation.topicKeys) topics.add(key);
  }
  if (subjects.size < floor * 2) return output;
  for (const key of CONNECTION_ISSUE_TOPICS) {
    let support = 0;
    for (const topics of subjects.values()) if (topics.has(key)) support += 1;
    // Both sides must satisfy the same distinct-person floor. No exact totals,
    // zero cells, private source-kind slices, or small complements are exposed.
    if (support < floor || subjects.size - support < floor) continue;
    const share = support / subjects.size;
    const strength = share <= 1 / 3 ? 0.25 : share <= 2 / 3 ? 0.5 : 0.75;
    output.issuePriorities.push({ key, strength });
  }
  if (output.issuePriorities.length) output.state = "ready";
  return output;
}
