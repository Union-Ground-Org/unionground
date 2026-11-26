// Connection matching consumes published organization facts, never a person graph.
export const CONNECTION_WEIGHT_KEYS = Object.freeze([
  "location", "sector", "issues", "expertise", "local", "union",
]);

export const DEFAULT_CONNECTION_WEIGHTS = Object.freeze({
  location: 20, sector: 20, issues: 25, expertise: 20, local: 10, union: 5,
});

// Inventory B13 (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001): the
// organization's default matching weights, read from the member-safe switches
// map (limits.intelligence.connection_weight_<signal>, 0..100). null when the
// organization set none, so callers keep the balanced preset; staff still tune
// a session's sliders. Kept import-free because native imports this module.
export function organizationConnectionWeights(configuration) {
  const switches = configuration?.switches;
  if (!switches || typeof switches !== "object" || Array.isArray(switches)) return null;
  let found = false;
  const weights = {};
  for (const key of CONNECTION_WEIGHT_KEYS) {
    const name = `limits.intelligence.connection_weight_${key}`;
    const value = Object.hasOwn(switches, name) ? switches[name] : undefined;
    if (Number.isInteger(value) && value >= 0 && value <= 100) {
      weights[key] = value;
      found = true;
    } else {
      weights[key] = DEFAULT_CONNECTION_WEIGHTS[key];
    }
  }
  return found ? weights : null;
}

export const DEFAULT_CONNECTION_SETTINGS = Object.freeze({
  weights: DEFAULT_CONNECTION_WEIGHTS,
  locationScale: "metro",
  reach: "anywhere",
  diversity: 0,
  freshnessDays: null,
});

export const CONNECTION_ISSUE_TOPICS = Object.freeze([
  "staffing", "scheduling", "pay", "benefits", "safety", "discipline",
  "discrimination", "workload", "training", "contract-enforcement",
]);

export const CONNECTION_SECTORS = Object.freeze([
  "healthcare", "education", "public-services", "transportation", "logistics",
  "manufacturing", "hospitality", "retail", "construction", "nonprofit", "care", "other",
]);

export const CONNECTION_SIGNAL_KINDS = Object.freeze(["grievance", "survey", "feedback"]);
export const CONNECTION_TAXONOMY_VERSION = "chapter-connections-v1";
export const MIN_CONNECTION_CONTRIBUTORS = 25;

export function organizationConnectionIssueFloor(configuration) {
  const value = configuration?.switches?.["limits.intelligence.connection_issue_floor"];
  return Number.isInteger(value) && value >= 15 && value <= 200
    ? value
    : MIN_CONNECTION_CONTRIBUTORS;
}

// An idempotent replay returns the current row, which may have advanced since
// the first reply was lost. Both clients validate the same lifecycle receipt.
export function isConnectionHandshakeReceipt(row, chapterId, targetChapterId) {
  return typeof row?.id === "string" && row.id.length > 0
    && ["requested", "accepted", "active", "declined", "closed"].includes(row.status)
    && row.chapter_id === chapterId && row.receiving_chapter_id === targetChapterId;
}

// A valid replay can describe a finished request. Preserve its identity and
// report that outcome instead of announcing a new pending request.
export function connectionHandshakeOutcome(row) {
  if (row?.status === "declined") return "declined";
  if (row?.status === "closed") return "closed";
  return "sent";
}
