// Organization intelligence and collective action contract (CR-047, CR-048,
// CR-050, CR-051, CR-052). The selected organization is always derived by the
// database. No client API accepts a tenant key.

export const ORGANIZATION_INTELLIGENCE_DONOR_BASELINE = "donor-baseline-20260721";

export const ORGANIZATION_INTELLIGENCE_STAFF_HATS = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

export const ORGANIZATION_INTELLIGENCE_WRITE_HATS = Object.freeze([
  "advisor",
  "admin",
  "vp",
]);

export const COLLECTIVE_ACTION_MANAGER_HATS = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

export const COLLECTIVE_ACTION_EXPORT_HATS = Object.freeze([
  "coordinator",
  "admin",
  "vp",
]);

export const ORGANIZATION_CHART_KINDS = Object.freeze(["agency", "union"]);
export const ORGANIZATION_NODE_KINDS = Object.freeze([
  "organization",
  "division",
  "chapter",
  "team",
  "role",
  "person",
]);
// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: the seat states the
// administrator sets; private.organization_chart_nodes_seat_status holds the
// same closed list.
export const ORGANIZATION_SEAT_STATUSES = Object.freeze(["confirmed", "unconfirmed", "unknown", "stale"]);
export const RELATIONSHIP_KINDS = Object.freeze([
  "reports_to",
  "works_with",
  "mentors",
  "organizes_with",
  "trusted_contact",
]);
export const TOPIC_PROGRESS_STATES = Object.freeze([
  "introduced",
  "developing",
  "ready",
]);
export const LEADERSHIP_TIMELINE_KINDS = Object.freeze([
  "leadership_term",
  "payroll_snapshot",
]);
export const DIGITAL_ACTION_KINDS = Object.freeze([
  "petition",
  "rally",
  "picket",
  "meeting",
  "other",
]);
export const DIGITAL_ACTION_STATUSES = Object.freeze([
  "draft",
  "published",
  "closed",
  "cancelled",
]);
export const DIGITAL_ACTION_PARTICIPATION_KINDS = Object.freeze([
  "signature",
  "attendee",
  "volunteer",
]);

// A digital action records one participation kind, decided by what the action
// asks a member to do: sign a petition, show up to a rally, picket or meeting,
// or volunteer for anything else. `toggle_digital_action_participation` stores
// whatever kind the client sends and the participant export filters on it, so
// every join surface derives the kind here rather than naming one.
const PARTICIPATION_KIND_BY_ACTION_KIND = Object.freeze({
  petition: "signature",
  rally: "attendee",
  picket: "attendee",
  meeting: "attendee",
  other: "volunteer",
});

export function digitalActionParticipationKind(actionKind) {
  return PARTICIPATION_KIND_BY_ACTION_KIND[actionKind] || "volunteer";
}

export const ORGANIZATION_INTELLIGENCE_RPCS = Object.freeze({
  intelligenceSnapshot: "get_organization_intelligence_snapshot",
  collectiveActions: "get_collective_actions",
  saveChartNode: "save_organization_chart_node",
  saveChartSeatStatus: "set_organization_chart_seat_status",
  saveRelationship: "save_organization_relationship",
  saveTopicProgress: "save_organization_topic_progress",
  saveTimelineEvent: "save_organization_timeline_event",
  saveAction: "save_digital_action",
  toggleParticipation: "toggle_digital_action_participation",
  exportParticipants: "request_digital_action_participant_export",
  // REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030.
  goalBreakdown: "get_digital_action_goal_breakdown",
});

export const ORGANIZATION_INTELLIGENCE_TABLES = Object.freeze([
  "organization_chart_nodes",
  "organization_relationships",
  "organization_topic_progress",
  "organization_timeline_events",
  "digital_actions",
  "digital_action_participants",
  "digital_action_exports",
  "organization_intelligence_audit_events",
]);

export const ORGANIZATION_INTELLIGENCE_TABS = Object.freeze([
  "charts",
  "relationships",
  "timeline",
]);

// REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112: the organization
// switch for the Neuro Map tab. Default on; only an explicit false (the
// organization turned it off) hides it. The server enforces it as well.
export const NEURO_MAP_SWITCH_KEY = "features.intelligence.neuro_map";

export function neuroMapEnabled(configuration) {
  return configuration?.switches?.[NEURO_MAP_SWITCH_KEY] !== false;
}

// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113:
// the page subtitle names the relationship map and topic readiness, which are
// the Neuro Map, only once a read says it is on: the snapshot when it carries
// the switch, else the member switch map. Both report a held switch as off, so
// nothing names it while it is held for its release day, switched off, or not
// read yet (docs/contracts/staged-feature-releases.md).
export function neuroMapReadOn(snapshotSwitch, configuration) {
  const read = typeof snapshotSwitch === "boolean" ? snapshotSwitch : configuration?.switches?.[NEURO_MAP_SWITCH_KEY];
  return read === true;
}

export const DIGITAL_ACTION_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIGITAL_ACTION_EXPORT_ROW_LIMIT = 10000;
export const DIGITAL_ACTION_PAGE_SIZE = 25;
