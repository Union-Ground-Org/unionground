// MI1 analytics core contract (CR-035–039, CR-049).
// Documentation-as-code plus deterministic constants. This module does not
// call the database, hold secrets, or invent a second tenant key.

export const ANALYTICS_DONOR_BASELINE = "donor-baseline-20260721";

export const ANALYTICS_WINDOW_DAYS = Object.freeze({
  usage: 30,
  engagement: 180,
  attendance: 180,
  cases: 180,
});

export const ANALYTICS_COHORT_FLOOR = 25;
export const ANALYTICS_HEATMAP_CELL_FLOOR = 25;
export const ANALYTICS_CORRELATION_FLOOR = 25;
export const ANALYTICS_CORRELATION_STRENGTH = 0.5;

// An organization's own limit may sit anywhere from the server's minimum of
// ten up to 200, but the browser never releases a group under 25 (Lovable
// audit APP-STEWARD-07): a lower organization limit still hides groups under 25.
export function analyticsAnonymityFloor(value) {
  return Number.isInteger(value) && value >= 10 && value <= 200
    ? Math.max(value, ANALYTICS_COHORT_FLOOR)
    : ANALYTICS_COHORT_FLOOR;
}

export const ANALYTICS_STAFF_HATS = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

export const ANALYTICS_EXPORT_HATS = Object.freeze(["coordinator", "admin", "vp"]);

export const ANALYTICS_STATS_TABS = Object.freeze([
  "overview",
  "chapters",
  "workplaces",
  "cases",
  "stewards",
  "membership",
  "comparison",
]);

export const ANALYTICS_DESK_TABS = Object.freeze([
  "stats",
  "usage",
  "insights",
  "heatmaps",
  "engagement",
  "attendance",
  "health",
  "explorer",
  "studio",
  "chapter_charts",
]);

// October 2 design direction (REQ-UG-WEB-ANALYTICS-TAB-OCTOBER-DESIGN-20261002):
// one routed level of sections (/m/analytics/<section>), each holding the desk
// views that one labelled selector switches between. Every former tab and
// stats sub-tab stays reachable; the stats section's views are the stats tabs.
export const ANALYTICS_SECTIONS = Object.freeze({
  stats: ANALYTICS_STATS_TABS,
  activity: Object.freeze(["usage", "engagement", "attendance"]),
  patterns: Object.freeze(["insights", "heatmaps", "health"]),
  charts: Object.freeze(["explorer", "studio", "chapter_charts"]),
});

export const ANALYTICS_SECTION_IDS = Object.freeze(Object.keys(ANALYTICS_SECTIONS));

// Views drawn from get_organization_analytics_workspace rather than the snapshot.
export const ANALYTICS_WORKSPACE_VIEWS = Object.freeze(["health", "explorer", "studio", "chapter_charts"]);

export const ANALYTICS_HEATMAP_KINDS = Object.freeze(["grievance", "solidarity"]);

export const ENGAGEMENT_EVENT_TAXONOMY = Object.freeze({
  meeting_check_in: { cap: 10, weight: 30, label: "Meeting check-ins" },
  qa_contribution: { cap: 15, weight: 25, label: "Q&A contributions" },
  poll_vote: { cap: 5, weight: 10, label: "Poll votes" },
  survey_response: { cap: 3, weight: 10, label: "Survey responses" },
  event_rsvp: { cap: 8, weight: 15, label: "Event RSVPs" },
  authorized_contact: { cap: 5, weight: 10, label: "Authorized contacts" },
});

export const ENGAGEMENT_SCORE_BANDS = Object.freeze([
  { id: "0-19", min: 0, max: 19 },
  { id: "20-39", min: 20, max: 39 },
  { id: "40-59", min: 40, max: 59 },
  { id: "60-79", min: 60, max: 79 },
  { id: "80-100", min: 80, max: 100 },
]);

export const ANALYTICS_COUNT_BANDS = Object.freeze([
  { id: "25-49", min: 25, max: 49 },
  { id: "50-99", min: 50, max: 99 },
  { id: "100+", min: 100, max: Number.POSITIVE_INFINITY },
]);

export const ANALYTICS_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export const ANALYTICS_AUDIT_EVENT_TYPES = Object.freeze([
  "analytics_snapshot_read",
  "analytics_export_requested",
]);

export const ANALYTICS_AUDIT_METADATA_KEYS = Object.freeze([
  "organizationId",
  "chapterId",
  "surface",
  "exportFormat",
  "rowCount",
  "suppressedCount",
  "expiresAt",
]);

export const ANALYTICS_REQUESTED_RPCS = Object.freeze({
  snapshot: "get_organization_analytics_snapshot",
  workspace: "get_organization_analytics_workspace",
  saveLayout: "save_organization_analytics_layout",
  deleteLayout: "delete_organization_analytics_layout",
  export: "request_organization_analytics_export",
});

export const ANALYTICS_AUTHORIZATION_PREDICATES = Object.freeze([
  "private.is_organization_member",
  "private.has_organization_role",
]);

export const ANALYTICS_REQUESTED_TABLES = Object.freeze([
  "organization_page_views",
  "organization_engagement_events",
  "organization_analytics_exports",
  "organization_analytics_layouts",
]);
