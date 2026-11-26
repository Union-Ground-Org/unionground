// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
export const ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION = "preview-organization-intelligence";

export const ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT = Object.freeze({
  organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
  generatedAt: "2026-08-28T12:00:00Z",
  chartNodes: Object.freeze([
    { id: "union", chartKind: "union", nodeKind: "organization", label: "Statewide organization", positionX: 50, positionY: 8, sortOrder: 0 },
    { id: "north", chartKind: "union", nodeKind: "chapter", parentId: "union", label: "North Shore Chapter", subtitle: "Regional member chapter", positionX: 25, positionY: 58, sortOrder: 1 },
    { id: "central", chartKind: "union", nodeKind: "chapter", parentId: "union", label: "Central Chapter", subtitle: "Regional member chapter", positionX: 75, positionY: 58, sortOrder: 2 },
    { id: "agency", chartKind: "agency", nodeKind: "organization", label: "Human Services Agency", positionX: 50, positionY: 8, sortOrder: 0 },
    { id: "division", chartKind: "agency", nodeKind: "division", parentId: "agency", label: "Community Programs", positionX: 25, positionY: 58, sortOrder: 1 },
    { id: "operations", chartKind: "agency", nodeKind: "division", parentId: "agency", label: "Regional Operations", positionX: 75, positionY: 58, sortOrder: 2 },
  ]),
  relationshipNodes: Object.freeze([
    { id: "sam", label: "Sam Okafor", roleLabel: "Steward" },
    { id: "maya", label: "Maya Chen", roleLabel: "Coordinator" },
    { id: "luis", label: "Luis Rivera", roleLabel: "Member organizer" },
    { id: "nora", label: "Nora Ibrahim", roleLabel: "Member" },
  ]),
  relationships: Object.freeze([
    { id: "r1", sourceId: "sam", targetId: "maya", kind: "works_with", strength: 4 },
    { id: "r2", sourceId: "sam", targetId: "luis", kind: "mentors", strength: 3 },
    { id: "r3", sourceId: "luis", targetId: "nora", kind: "organizes_with", strength: 4 },
  ]),
  topicProgress: Object.freeze([
    { memberId: "luis", topicKey: "workplace_mapping", topicLabel: "Workplace mapping", state: "developing", progress: 65 },
    { memberId: "nora", topicKey: "meeting_leadership", topicLabel: "Meeting leadership", state: "introduced", progress: 30 },
  ]),
  timeline: Object.freeze([
    { id: "t1", kind: "leadership_term", title: "Chapter leadership term", effectiveOn: "2024-01-01", endedOn: "2025-12-31" },
    { id: "t2", kind: "payroll_snapshot", title: "Annual payroll snapshot", effectiveOn: "2025-07-01", amountCents: 18450000, amountBasis: "Annual aggregate", sourceLabel: "Organization-provided payroll file", sourceAsOf: "2025-07-01" },
    { id: "t3", kind: "leadership_term", title: "New organizing committee seated", effectiveOn: "2026-03-15" },
  ]),
});

export const COLLECTIVE_ACTIONS_PREVIEW_SNAPSHOT = Object.freeze({
  organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
  generatedAt: "2026-08-28T12:00:00Z",
  actions: Object.freeze([
    { id: "a1", kind: "petition", status: "published", title: "Safe staffing commitment", summary: "Ask colleagues to support the chapter staffing proposal.", targetCount: 250, participantCount: 168, viewerParticipation: null, viewerCanEdit: true },
    { id: "a2", kind: "rally", status: "published", title: "Budget hearing turnout", summary: "Commit to attending the public budget hearing.", targetCount: 120, participantCount: 74, viewerParticipation: "attendee", viewerCanEdit: true },
    { id: "a3", kind: "picket", status: "closed", title: "Respect the schedule", summary: "Past action retained with its final aggregate.", targetCount: 90, participantCount: 91, viewerParticipation: null, viewerCanEdit: true },
    { id: "a4", kind: "meeting", status: "draft", title: "Worksite captains meeting", summary: "Draft organizer action hidden from Member.", targetCount: 35, participantCount: 0, viewerParticipation: null, viewerCanEdit: true },
  ]),
});
