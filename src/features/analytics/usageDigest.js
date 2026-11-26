// REQ-UG-AI-USAGE-DIGEST-20261001 — pure presenter for the stored weekly
// and monthly usage trend digests read by public.get_analytics_usage_digests.
//
// The database already applied suppression and floored every published count,
// so this module only shapes what the panel renders. It never recomputes a
// figure, never fills in a suppressed window and never carries an identity:
// the payload has none to carry. Since the round-1 privacy repair
// (OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010) a window reports only
// distinct people and meeting check-ins; view totals and sections are gone.
import { ANALYTICS_COHORT_FLOOR } from "./contract.js";

const USAGE_DIGEST_PERIODS = Object.freeze(["weekly", "monthly"]);
const USAGE_DIGEST_METRICS = Object.freeze(["actors", "checkins"]);

const DIRECTIONS = new Set(["up", "down", "flat", "unknown"]);

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function bucket(input) {
  if (!input || typeof input !== "object") return null;
  const suppressed = input.suppressed === true;
  return {
    start: typeof input.start === "string" ? input.start : null,
    end: typeof input.end === "string" ? input.end : null,
    suppressed,
    minCohort: Math.max(ANALYTICS_COHORT_FLOOR, count(input.minCohort) || 0),
    actors: suppressed ? null : count(input.actors),
    checkins: suppressed ? null : count(input.checkins),
  };
}

function delta(input) {
  if (!input || typeof input !== "object" || !USAGE_DIGEST_METRICS.includes(input.metric)) return null;
  const current = count(input.current);
  const previous = count(input.previous);
  const direction = DIRECTIONS.has(input.direction) ? input.direction : "unknown";
  return {
    metric: input.metric,
    current,
    previous,
    // A window the database suppressed has no figures, so no comparison can
    // be stated for it either.
    direction: current === null || previous === null ? "unknown" : direction,
  };
}

function digest(input) {
  if (!input || typeof input !== "object" || !USAGE_DIGEST_PERIODS.includes(input.period)) return null;
  const buckets = (Array.isArray(input.buckets) ? input.buckets : []).map(bucket).filter(Boolean);
  const ai = input.ai && typeof input.ai === "object" ? input.ai : {};
  const summary = ai.summary && typeof ai.summary === "object" ? ai.summary : null;
  return {
    id: typeof input.id === "string" ? input.id : null,
    period: input.period,
    windowStart: typeof input.windowStart === "string" ? input.windowStart : null,
    windowEnd: typeof input.windowEnd === "string" ? input.windowEnd : null,
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : null,
    hasData: input.hasData === true && buckets.some((row) => !row.suppressed),
    buckets,
    latest: buckets.length ? buckets[buckets.length - 1] : null,
    deltas: (Array.isArray(input.deltas) ? input.deltas : []).map(delta).filter(Boolean),
    ai: {
      status: ["off", "available", "enriched"].includes(ai.status) ? ai.status : "off",
      summary: typeof summary?.summary === "string" ? summary.summary : null,
      highlights: Array.isArray(summary?.highlights)
        ? summary.highlights.filter((item) => typeof item === "string")
        : [],
      caution: typeof summary?.caution === "string" ? summary.caution : null,
      model: typeof ai.model === "string" ? ai.model : null,
    },
  };
}

export function normalizeUsageDigests(payload) {
  const enabled = payload?.enabled === true;
  const minCohort = Number.isInteger(payload?.minCohort) && payload.minCohort >= ANALYTICS_COHORT_FLOOR
    ? payload.minCohort
    : ANALYTICS_COHORT_FLOOR;
  if (!enabled) return { enabled: false, minCohort, digests: [] };
  const digests = (Array.isArray(payload.digests) ? payload.digests : []).map(digest).filter(Boolean);
  digests.sort((a, b) => USAGE_DIGEST_PERIODS.indexOf(a.period) - USAGE_DIGEST_PERIODS.indexOf(b.period));
  return { enabled: true, minCohort, digests };
}
