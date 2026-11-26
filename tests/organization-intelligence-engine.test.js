import { describe, expect, it, vi } from "vitest";
import {
  buildDigitalActionParticipantCsv,
  buildOrganizationChartForest,
  buildRelationshipGraph,
  canExportCollectiveActionParticipants,
  composeCollectiveActions,
  composeOrganizationIntelligence,
  createOrganizationIntelligenceAdapter,
} from "../src/features/organizationIntelligence/index.js";

function actor(overrides = {}) {
  return {
    userId: "user-1",
    organizationId: "org-1",
    chapterId: "chapter-1",
    selectedHat: "advisor",
    organizationRoles: ["advisor"],
    membershipStatus: "active",
    mfaSatisfied: true,
    ...overrides,
  };
}

describe("organization intelligence authorization", () => {
  it("keeps members and cross-organization snapshots out of staff intelligence", () => {
    expect(composeOrganizationIntelligence({
      actor: actor({ selectedHat: "member" }),
      snapshot: { organizationId: "org-1" },
    })).toMatchObject({ state: "unauthorized", reason: "staff_grant_required" });

    expect(composeOrganizationIntelligence({
      actor: actor(),
      snapshot: { organizationId: "org-2" },
    })).toMatchObject({ state: "unauthorized", reason: "cross_organization" });
  });

  it("requires an exact granted export hat and MFA", () => {
    expect(canExportCollectiveActionParticipants(actor({ selectedHat: "coordinator", organizationRoles: ["coordinator"] }))).toBe(true);
    expect(canExportCollectiveActionParticipants(actor({ selectedHat: "advisor", organizationRoles: ["advisor"] }))).toBe(false);
    expect(canExportCollectiveActionParticipants(actor({ selectedHat: "admin", organizationRoles: ["admin"], mfaSatisfied: false }))).toBe(false);
  });
});

describe("organization chart and relationship composition", () => {
  it("builds separate agency and union trees while dropping invalid parent links", () => {
    const charts = buildOrganizationChartForest({
      chartNodes: [
        { id: "union", chartKind: "union", nodeKind: "organization", label: "Union Ground", sortOrder: 0 },
        { id: "chapter", chartKind: "union", nodeKind: "chapter", parentId: "union", label: "Central chapter", sortOrder: 1 },
        { id: "agency", chartKind: "agency", nodeKind: "organization", parentId: "missing", label: "Human services", sortOrder: 0 },
        { id: "bad", chartKind: "other", nodeKind: "role", label: "Dropped" },
      ],
    });
    expect(charts.byKind.union[0].children[0].label).toBe("Central chapter");
    expect(charts.byKind.agency[0].label).toBe("Human services");
    expect(charts.nodes.map((node) => node.id)).not.toContain("bad");
  });

  it("keeps only relationships and topic progress backed by known nodes", () => {
    const graph = buildRelationshipGraph({
      relationshipNodes: [
        { id: "one", label: "Alex", chapterId: "chapter-1" },
        { id: "two", label: "Jordan", chapterId: "chapter-1" },
      ],
      relationships: [
        { id: "edge-1", sourceId: "one", targetId: "two", kind: "mentors", strength: 7 },
        { id: "edge-2", sourceId: "one", targetId: "missing", kind: "works_with", strength: 3 },
      ],
      topicProgress: [
        { memberId: "one", topicKey: "weingarten", topicLabel: "Interview rights", state: "developing", progress: 60 },
        { memberId: "missing", topicKey: "bad", topicLabel: "Bad", state: "ready", progress: 100 },
      ],
    });
    expect(graph.edges).toEqual([{ id: "edge-1", source: "one", target: "two", kind: "mentors", strength: 5 }]);
    expect(graph.topics).toHaveLength(1);
  });

  it("composes empty-safe intelligence without donor payroll fixtures", () => {
    expect(composeOrganizationIntelligence({ actor: actor(), snapshot: null })).toMatchObject({ state: "unset" });
    expect(composeOrganizationIntelligence({
      actor: actor(),
      snapshot: { organizationId: "org-1", chartNodes: [], relationshipNodes: [], relationships: [], topicProgress: [], timeline: [] },
    })).toMatchObject({ state: "ready", writeAllowed: true, timeline: [] });
  });

  it("normalizes malformed chart, graph, and timeline input without leaking invalid rows", () => {
    const charts = buildOrganizationChartForest({
      chartNodes: [
        { id: "root", chartKind: "union", nodeKind: "organization", label: " Root ", positionX: 20000, positionY: -20000, sortOrder: "2" },
        { id: "root", chartKind: "union", nodeKind: "chapter", label: "Duplicate" },
        { id: "cycle-a", chartKind: "union", nodeKind: "chapter", parentId: "cycle-b", label: "Cycle A" },
        { id: "cycle-b", chartKind: "union", nodeKind: "chapter", parentId: "cycle-a", label: "Cycle B" },
        null,
        { id: "", chartKind: "union", nodeKind: "chapter", label: "Missing id" },
      ],
    });
    expect(charts.nodes).toHaveLength(3);
    expect(charts.nodes[0]).toMatchObject({ label: "Root", positionX: 10000, positionY: -10000, sortOrder: 2 });
    expect(charts.byKind.union.map((node) => node.id)).toEqual(["root"]);

    const graph = buildRelationshipGraph({
      relationshipNodes: [{ id: "a", label: "A" }, { id: "", label: "No id" }, { id: "b", label: "B" }, null],
      relationships: [
        { id: "self", sourceId: "a", targetId: "a", kind: "mentors" },
        { id: "bad-kind", sourceId: "a", targetId: "b", kind: "unknown" },
        { id: "valid", sourceId: "a", targetId: "b", kind: "mentors", strength: -4 },
      ],
      topicProgress: [
        { memberId: "a", topicKey: "topic", topicLabel: "Topic", state: "ready", progress: 500 },
        { memberId: "a", topicKey: "bad", topicLabel: "Bad", state: "unknown" },
      ],
    });
    expect(graph.edges).toEqual([{ id: "valid", source: "a", target: "b", kind: "mentors", strength: 1 }]);
    expect(graph.topics[0].progress).toBe(100);

    const model = composeOrganizationIntelligence({
      actor: actor(),
      snapshot: {
        organizationId: "org-1",
        chartNodes: [], relationshipNodes: [], relationships: [], topicProgress: [],
        timeline: [
          { id: "later", kind: "payroll_snapshot", title: " Payroll ", effectiveOn: "2026-02-01", endedOn: "bad", amountCents: -2, amountBasis: " annual ", sourceLabel: " file ", sourceAsOf: "2026-01-31" },
          { id: "earlier", kind: "leadership_term", title: "Term", effectiveOn: "2025-01-01", endedOn: "2025-12-31" },
          { id: "bad-date", kind: "leadership_term", title: "Bad", effectiveOn: "yesterday" },
        ],
      },
    });
    expect(model.timeline.map((row) => row.id)).toEqual(["later", "earlier"]);
    expect(model.timeline[0]).toMatchObject({ amountCents: 0, amountBasis: "annual", sourceLabel: "file", sourceAsOf: "2026-01-31", endedOn: null });
  });

  it("surfaces unavailable and failed snapshots as closed model states", () => {
    expect(composeOrganizationIntelligence({ actor: actor(), snapshot: { organizationId: "org-1", unavailable: true } })).toMatchObject({ state: "unauthorized", reason: "authorization_required" });
    expect(composeOrganizationIntelligence({ actor: actor(), snapshot: { organizationId: "org-1", error: "database_failed" } })).toMatchObject({ state: "error", reason: "database_failed" });
  });
});

describe("collective actions", () => {
  const snapshot = {
    organizationId: "org-1",
    actions: [
      { id: "published", kind: "petition", status: "published", title: "Safe staffing", targetCount: 50, participantCount: 17, viewerParticipation: "signature" },
      { id: "draft", kind: "rally", status: "draft", title: "Draft action", targetCount: 20, participantCount: 0 },
    ],
  };

  it("shows member-safe published actions and the viewer's own participation", () => {
    const model = composeCollectiveActions({
      actor: actor({ selectedHat: "member", organizationRoles: [] }),
      snapshot,
    });
    expect(model.state).toBe("ready");
    expect(model.actions.map((action) => action.id)).toEqual(["published"]);
    expect(model.actions[0]).toMatchObject({ strengthPercent: 34, viewerParticipation: "signature" });
    expect(model.manageAllowed).toBe(false);
  });

  it("keeps a withheld platform total distinct from zero", () => {
    const model = composeCollectiveActions({
      actor: actor({ selectedHat: "member", organizationRoles: [] }),
      snapshot: { organizationId: "org-1", actions: [
        { id: "withheld", kind: "petition", status: "published", title: "Withheld", targetCount: 50, participantCount: null, viewerParticipation: "signature" },
      ] },
    });
    expect(model.actions[0]).toMatchObject({ participantCount: null, strengthPercent: null, viewerParticipation: "signature" });
  });

  it("preserves server pagination receipts without trusting them for authorization", () => {
    const model = composeCollectiveActions({
      actor: actor({ selectedHat: "member", organizationRoles: [] }),
      snapshot: { ...snapshot, totalCount: 52, nextOffset: 25 },
    });
    expect(model).toMatchObject({ totalCount: 52, nextOffset: 25, hasMore: true });
  });

  it("shows drafts only to an MFA-backed granted staff hat", () => {
    const model = composeCollectiveActions({ actor: actor(), snapshot });
    expect(model.actions.map((action) => action.id)).toEqual(["published", "draft"]);
    expect(model.manageAllowed).toBe(true);
  });

  it("offers the edit control only on actions the server says this viewer may edit", () => {
    const withEdit = {
      organizationId: "org-1",
      actions: [
        { id: "mine", kind: "petition", status: "published", title: "Mine", targetCount: 5, participantCount: 0, viewerCanEdit: true },
        { id: "theirs", kind: "petition", status: "published", title: "Theirs", targetCount: 5, participantCount: 0, viewerCanEdit: false },
        { id: "unstated", kind: "petition", status: "published", title: "Unstated", targetCount: 5, participantCount: 0 },
      ],
    };
    const staff = composeCollectiveActions({ actor: actor(), snapshot: withEdit });
    expect(Object.fromEntries(staff.actions.map((action) => [action.id, action.viewerCanEdit]))).toEqual({ mine: true, theirs: false, unstated: false });
    const member = composeCollectiveActions({ actor: actor({ selectedHat: "member", organizationRoles: [] }), snapshot: withEdit });
    expect(member.actions.every((action) => action.viewerCanEdit === false)).toBe(true);
  });

  it("carries the server's join rule and keeps today's offer when the server does not send it (#9166)", () => {
    const model = composeCollectiveActions({ actor: actor({ selectedHat: "member", organizationRoles: [] }), snapshot: { organizationId: "org-1", actions: [
      { id: "refused", kind: "petition", status: "published", title: "Refused", targetCount: 5, participantCount: 0, viewerCanJoin: false },
      { id: "allowed", kind: "petition", status: "published", title: "Allowed", targetCount: 5, participantCount: 0, viewerCanJoin: true },
      { id: "unstated", kind: "petition", status: "published", title: "Unstated", targetCount: 5, participantCount: 0 },
    ] } });
    expect(Object.fromEntries(model.actions.map((action) => [action.id, action.viewerCanJoin]))).toEqual({ refused: false, allowed: true, unstated: true });
  });

  it("serializes protected participant exports with spreadsheet-safe CSV quoting", () => {
    const csv = buildDigitalActionParticipantCsv({
      actionTitle: "Staffing, now",
      rows: [{ participationKind: "signature", memberName: "Rivera, Alex", email: "alex@example.test", chapterName: "Central", joinedAt: "2026-08-28T12:00:00Z" }],
    });
    expect(csv).toContain('"Staffing, now",signature,"Rivera, Alex",alex@example.test,Central,2026-08-28T12:00:00Z');
    expect(buildDigitalActionParticipantCsv({
      actionTitle: "Safe staffing",
      rows: [{ participationKind: "signature", memberName: "=HYPERLINK(\"https://invalid\")", email: "+cmd@example.test", chapterName: "\t=CMD()" }],
    })).toContain("'=HYPERLINK");
    expect(buildDigitalActionParticipantCsv({
      actionTitle: "Safe staffing",
      rows: [{ participationKind: "attendee", memberName: "\r=CMD()", email: "\t@SUM(1,1)" }],
    })).toContain("'\n=CMD()");
    expect(buildDigitalActionParticipantCsv({
      actionTitle: "Safe staffing",
      rows: [{ participationKind: "volunteer", memberName: "River", email: "\t@SUM(1,1)" }],
    })).toContain("'\t@SUM(1,1)");
    expect(buildDigitalActionParticipantCsv()).toBe("Action,Participation,Worker,Email,Campaign,Joined at\n");
    expect(buildDigitalActionParticipantCsv({ actionTitle: "Quoted", rows: [{ memberName: 'A "quote"' }] })).toContain('"A ""quote"""');
  });

  it("normalizes action bounds, ordering, invalid rows, and error states", () => {
    const model = composeCollectiveActions({ actor: actor(), snapshot: {
      organizationId: "org-1", totalCount: "bad", nextOffset: -10,
      actions: [
        { id: "closed", kind: "meeting", status: "closed", title: "Closed", targetCount: 0, participantCount: 2000000 },
        { id: "published", kind: "petition", status: "published", title: "Published", targetCount: 2000000, participantCount: -2, viewerParticipation: "invalid", publishedAt: "2026-01-01" },
        { id: "invalid", kind: "unknown", status: "published", title: "Invalid" },
        null,
      ],
    } });
    expect(model.actions.map((row) => row.id)).toEqual(["published", "closed"]);
    expect(model.actions[0]).toMatchObject({ targetCount: 1000000, participantCount: 0, viewerParticipation: null });
    expect(model.actions[1]).toMatchObject({ targetCount: 1, participantCount: 1000000, strengthPercent: 100 });
    expect(model).toMatchObject({ totalCount: 2, nextOffset: 0, hasMore: true });
    expect(composeCollectiveActions({ actor: actor(), snapshot: { organizationId: "org-1", unavailable: true, reason: "mfa_required" } })).toMatchObject({ state: "unauthorized", reason: "mfa_required" });
    expect(composeCollectiveActions({ actor: actor(), snapshot: { organizationId: "org-1", error: "failed" } })).toMatchObject({ state: "error", reason: "failed" });
  });
});

describe("organization intelligence adapter", () => {
  it("loads normalized snapshots, keeps absent fetchers unset, and closes fetch failures", async () => {
    const fetchIntelligence = vi.fn(async () => ({ organizationId: "org-1", chartNodes: [], relationshipNodes: [], relationships: [], topicProgress: [], timeline: [] }));
    const fetchActions = vi.fn(async (_actor, request) => ({ organizationId: "org-1", actions: [], totalCount: request.limit }));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, fetchActions });
    await expect(adapter.loadIntelligence({ actor: actor() })).resolves.toMatchObject({ state: "ready" });
    await expect(adapter.loadActions({ actor: actor(), limit: 25 })).resolves.toMatchObject({ state: "ready", totalCount: 25 });
    expect(fetchActions).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1" }), { limit: 25 });

    const absent = createOrganizationIntelligenceAdapter();
    await expect(absent.loadIntelligence({ actor: actor() })).resolves.toMatchObject({ state: "unset" });
    await expect(absent.loadActions({ actor: actor() })).resolves.toMatchObject({ state: "unset" });

    const failed = createOrganizationIntelligenceAdapter({ fetchIntelligence: async () => { throw new Error("offline"); }, fetchActions: async () => { throw new Error("offline"); } });
    await expect(failed.loadIntelligence({ actor: actor() })).resolves.toMatchObject({ state: "error", reason: "snapshot_failed" });
    await expect(failed.loadActions({ actor: actor() })).resolves.toMatchObject({ state: "error", reason: "snapshot_failed" });
  });

  it("delegates every mutation and rejects every unwired mutation", async () => {
    const handlers = Object.fromEntries([
      "saveChartNode", "saveRelationship", "saveTopicProgress", "saveTimelineEvent",
      "saveAction", "toggleParticipation", "exportParticipants",
    ].map((name) => [name, vi.fn(async (input) => ({ name, input }))]));
    const adapter = createOrganizationIntelligenceAdapter(handlers);
    for (const [name, handler] of Object.entries(handlers)) {
      await expect(adapter[name]({ id: name })).resolves.toMatchObject({ name });
      expect(handler).toHaveBeenCalledWith({ id: name });
    }
    const absent = createOrganizationIntelligenceAdapter();
    for (const name of Object.keys(handlers)) await expect(absent[name]({})).rejects.toThrow(/unwired/);
  });
});
