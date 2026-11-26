// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_COHORT_FLOOR,
  ANALYTICS_HEATMAP_CELL_FLOOR,
  buildAnalyticsExport,
  buildAttendanceAnalytics,
  buildCorrelationInsights,
  buildEngagementScoring,
  buildOrganizationHeatmaps,
  buildOrganizationStatsSuite,
  buildPortalUsageSummary,
  composeAnalyticsCore,
  computeAverageOpenCasesPerSteward,
  createAnalyticsCoreAdapter,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  normalizeAnalyticsSnapshot,
  pearsonCorrelation,
  scoreEngagementEvents,
} from "../src/features/analytics/index.js";
import {
  flattenAnalyticsExportRows,
  serializeAnalyticsCsv,
} from "../src/features/analytics/export.js";
import { analyticsAnonymityFloor } from "../src/features/analytics/contract.js";
import { buildHeatmapLayer } from "../src/features/analytics/heatmaps.js";

const ORG = "org-a";
const OTHER = "org-b";

function viewer(overrides = {}) {
  return createPreviewAnalyticsViewer({
    organizationId: ORG,
    selectedHat: "steward",
    roles: ["steward"],
    ...overrides,
  });
}

function seriesRow(index, organizationId = ORG) {
  return {
    organizationId,
    chapterId: `c${index}`,
    attendanceRate: 40 + index,
    openCases: 20 - (index % 7),
    engagementMean: 30 + index,
    usageViews: 10 + index,
  };
}

describe("organization stats suite", () => {
  it("compares chapters and workplaces inside one organization only", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    snapshot.organizationId = ORG;
    snapshot.chapters = snapshot.chapters.map((row) => ({ ...row, organizationId: ORG }));
    snapshot.cases = snapshot.cases.map((row) => (
      row.organizationId === "preview-other-org" ? row : { ...row, organizationId: ORG }
    ));
    snapshot.membership = { ...snapshot.membership, organizationId: ORG };

    const suite = buildOrganizationStatsSuite(snapshot, viewer());
    expect(suite.tabs).toHaveLength(7);
    expect(suite.overview.openCases).toBeGreaterThan(0);
    expect(suite.overview.averageOpenPerSteward).toBe(computeAverageOpenCasesPerSteward(
      suite.overview.openCases,
      suite.overview.stewardCount,
    ));
    expect(suite.chapters.enoughData).toBe(true);
    expect(suite.chapters.rows.map((row) => row.id)).not.toContain("foreign");
    expect(suite.workplaces.rows.some((row) => row.name === "leak")).toBe(false);
  });

  it("hides named chapter comparisons below the cohort floor", () => {
    const suite = buildOrganizationStatsSuite({
      chapters: [{ id: "tiny", organizationId: ORG, memberCount: 8, stewardCount: 1 }],
      membership: { organizationId: ORG, active: 8, newIn90: 1 },
      cases: [{ organizationId: ORG, chapterId: "tiny", workplaceKey: "a", status: "active", type: "contract", step: 1 }],
    }, viewer());
    expect(suite.chapters.enoughData).toBe(false);
    expect(suite.chapters.minCohort).toBe(ANALYTICS_COHORT_FLOOR);
    expect(suite.chapters.rows).toEqual([]);
    expect(suite.overview.openCases).toBeNull();
    expect(suite.overview.casesSuppressed).toBe(true);
  });

  it("counts persisted aggregate case buckets instead of treating each bucket as one case", () => {
    const suite = buildOrganizationStatsSuite({
      chapters: [{ id: "chapter-a", organizationId: ORG, memberCount: 40, stewardCount: 5 }],
      cases: [
        { organizationId: ORG, chapterId: "chapter-a", workplaceKey: "contract", status: "active", step: 2, count: 20 },
        { organizationId: ORG, chapterId: "chapter-a", workplaceKey: "discipline", status: "resolved", step: 2, count: 10 },
      ],
    }, viewer());

    expect(suite.overview.openCases).toBe(20);
    expect(suite.overview.resolvedCases).toBe(10);
    expect(suite.cases.byStatus).toEqual([]);
    expect(suite.cases.byType).toEqual([]);
    expect(suite.workplaces.rows).toEqual([]);
    expect(suite.workplaces.reason).toBe("anonymity_floor");
  });

  it("normalizes the trusted top-level organization onto live aggregate rows", () => {
    const snapshot = normalizeAnalyticsSnapshot({
      organizationId: ORG,
      privacyThreshold: ANALYTICS_COHORT_FLOOR,
      chapters: [{ id: "chapter-a", label: "Chapter A", memberCount: 40, stewardCount: 5 }],
      cases: [{ chapterId: "chapter-a", workplaceKey: "contract", status: "active", step: 2, count: 20 }],
    }, ORG);
    const suite = buildOrganizationStatsSuite(snapshot, viewer());
    expect(snapshot.chapters[0].organizationId).toBe(ORG);
    expect(snapshot.cases[0].organizationId).toBe(ORG);
    expect(snapshot.membership.active).toBeNull();
    expect(snapshot.membership.suppressed).toBe(true);
    expect(suite.overview.openCases).toBe(20);
    expect(suite.chapters.rows[0].openCases).toBe(20);
    expect(suite.overview.chapterCount).toBe(1);
    expect(suite.overview.activeMembers).toBeNull();
    expect(suite.chapters.rows.map((row) => row.id)).toEqual(["chapter-a"]);
  });

  it("uses a valid server-issued anonymity floor and refuses values below ten", () => {
    const source = {
      organizationId: ORG,
      privacyThreshold: 40,
      chapters: [
        { id: "small", memberCount: 39, stewardCount: 3 },
        { id: "large", memberCount: 40, stewardCount: 3 },
      ],
      membership: { organizationId: ORG, active: 79, newIn90: 1 },
      cases: [],
    };
    const snapshot = normalizeAnalyticsSnapshot(source, ORG);
    expect(buildOrganizationStatsSuite(snapshot, viewer()).chapters.rows.map((row) => row.id)).toEqual(["large"]);
    expect(normalizeAnalyticsSnapshot({ ...source, privacyThreshold: 9 }, ORG)).toMatchObject({
      unavailable: true, reason: "privacy_floor_mismatch",
    });
  });

  it("never treats overlapping chapter totals as unique organization membership", () => {
    const snapshot = normalizeAnalyticsSnapshot({
      organizationId: ORG,
      privacyThreshold: ANALYTICS_COHORT_FLOOR,
      chapters: [
        { id: "chapter-a", memberCount: 25, stewardCount: 2 },
        { id: "chapter-b", memberCount: 25, stewardCount: 2 },
      ],
      cases: [],
    }, ORG);
    const suite = buildOrganizationStatsSuite(snapshot, viewer());
    expect(snapshot.membership.active).toBeNull();
    expect(suite.membership.enoughData).toBe(false);
    expect(suite.overview.activeMembers).toBeNull();
    expect(suite.chapters.rows.map((row) => row.id)).toEqual(["chapter-a", "chapter-b"]);
  });

  it("applies the privacy floor to each named chapter", () => {
    const suite = buildOrganizationStatsSuite({
      chapters: [
        { id: "large", organizationId: ORG, memberCount: 30, stewardCount: 3 },
        { id: "small", organizationId: ORG, memberCount: 10, stewardCount: 1 },
      ],
      membership: { organizationId: ORG, active: 40, newIn90: 2 },
      cases: [
        { organizationId: ORG, chapterId: "large", status: "active", count: 8 },
        { organizationId: ORG, chapterId: "small", status: "active", count: 6 },
      ],
    }, viewer());
    expect(suite.chapters.rows.map((row) => row.id)).toEqual(["large"]);
    expect(suite.comparison.rows.map((row) => row.id)).toEqual(["large"]);
    expect(suite.overview.stewardCount).toBeNull();
    expect(suite.stewards.stewardCount).toBeNull();
  });
});

describe("portal usage", () => {
  it("keeps preview usage current and supplies a rolling 36-month attendance history", () => {
    const now = new Date("2028-10-25T12:00:00.000Z");
    const snapshot = createPreviewAnalyticsSnapshot(now);
    expect(snapshot.generatedAt).toBe(now.toISOString());
    expect(snapshot.usageViews.filter((row) => row.organizationId === "preview-analytics-org"))
      .toHaveLength(30);
    const attendance = snapshot.attendanceEvents
      .filter((row) => row.organizationId === "preview-analytics-org");
    expect(attendance).toHaveLength(36);
    expect(attendance[0].startsAt.slice(0, 7)).toBe("2028-10");
    expect(attendance.at(-1).startsAt.slice(0, 7)).toBe("2025-11");
    const desk = composeAnalyticsCore({
      snapshot,
      viewer: createPreviewAnalyticsViewer(),
      now,
    });
    expect(desk.usage.totalViews).toBeGreaterThan(0);
    expect(desk.attendance.totals.events).toBeGreaterThan(0);
  });

  it("drops foreign-organization page views from the 30-day summary", () => {
    const usage = buildPortalUsageSummary({
      usageViews: [
        { organizationId: ORG, path: "/m/today", hat: "member", day: "2026-08-20", count: 4 },
        { organizationId: OTHER, path: "/m/admin", hat: "admin", day: "2026-08-20", count: 50 },
      ],
      usageWindows: { organizationId: ORG, dau: 3, wau: 8, mau: 12 },
    }, viewer(), new Date("2026-08-22T12:00:00.000Z"));
    expect(usage.totalViews).toBeNull();
    expect(usage.totalViewsSuppressed).toBe(true);
    expect(usage.byPath).toEqual([]);
    expect(usage.dau).toBe(3);
  });

  it("preserves suppressed actor windows instead of coercing them to zero", () => {
    const usage = buildPortalUsageSummary({
      usageWindows: {
        organizationId: ORG,
        dau: null,
        wau: null,
        mau: 8,
        suppressed: { dau: true, wau: true, mau: false },
      },
    }, viewer());
    expect(usage.dau).toBeNull();
    expect(usage.wau).toBeNull();
    expect(usage.mau).toBe(8);
    expect(usage.suppressed).toEqual({ dau: true, wau: true, mau: false });
  });
});

describe("correlation insights", () => {
  it("requires 25 paired observations and emits a signed narrative", () => {
    const short = buildCorrelationInsights({
      series: Array.from({ length: 10 }, (_, index) => seriesRow(index)),
    }, viewer());
    expect(short.enoughData).toBe(false);
    expect(short.findings).toEqual([]);

    const ready = buildCorrelationInsights({
      series: [
        ...Array.from({ length: 25 }, (_, index) => seriesRow(index)),
        seriesRow(99, OTHER),
      ],
    }, viewer());
    expect(ready.enoughData).toBe(true);
    expect(ready.findings.some((item) => item.id === "engagement_vs_attendance")).toBe(true);
    expect(ready.findings.every((item) => item.n === 25)).toBe(true);
  });

  it("computes a deterministic Pearson coefficient", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBe(1);
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBe(-1);
    expect(pearsonCorrelation([1], [2])).toBeNull();
  });
});

describe("heatmaps and engagement", () => {
  it("aggregates duplicate and unspecified heatmap points without exposing empty cells", () => {
    const layer = buildHeatmapLayer([
      { rowKey: "a", colKey: "nursing", count: 20 },
      { rowKey: "a", colKey: "nursing", count: 10 },
      { rowKey: "b", colKey: "facilities", count: 25 },
      { rowKey: "", colKey: "", count: Number.NaN },
    ]);
    expect(layer.maxValue).toBe(30);
    expect(layer.cells.find((cell) => cell.rowKey === "a" && cell.colKey === "nursing")).toMatchObject({
      value: 30,
      suppressed: false,
    });
    expect(layer.cells.find((cell) => cell.rowKey === "unspecified" && cell.colKey === "unspecified")).toMatchObject({
      value: null,
      suppressed: true,
    });
  });

  it("suppresses heatmap cells below the low-N floor and ignores foreign points", () => {
    const layers = buildOrganizationHeatmaps({
      heatmapPoints: [
        { organizationId: ORG, kind: "grievance", rowKey: "a", colKey: "nursing", count: 9 },
        { organizationId: ORG, kind: "grievance", rowKey: "a", colKey: "facilities", count: 2 },
        { organizationId: OTHER, kind: "grievance", rowKey: "leak", colKey: "nursing", count: 40 },
      ],
    }, viewer());
    const cells = layers.grievance.cells;
    expect(cells.find((cell) => cell.colKey === "nursing" && cell.rowKey === "a").value).toBeNull();
    expect(cells.find((cell) => cell.colKey === "facilities").suppressed).toBe(true);
    expect(cells.find((cell) => cell.colKey === "facilities").value).toBeNull();
    expect(cells.some((cell) => cell.rowKey === "leak")).toBe(false);
    expect(layers.grievance.cellFloor).toBe(ANALYTICS_HEATMAP_CELL_FLOOR);
  });

  it("scores engagement from the taxonomy without treating grievances as health", () => {
    const scored = scoreEngagementEvents({
      meeting_check_in: 10,
      qa_contribution: 15,
      poll_vote: 5,
      survey_response: 3,
      event_rsvp: 8,
      authorized_contact: 5,
    });
    expect(scored.score).toBe(100);
    const low = buildEngagementScoring({
      engagementCounts: [{ organizationId: ORG, chapterId: "tiny", memberCount: 4, events: { meeting_check_in: 1 } }],
    }, viewer());
    expect(low.enoughData).toBe(false);
    expect(low.chapters).toEqual([]);
  });

  it("groups persisted event-type aggregate rows into chapter scores", () => {
    const engagement = buildEngagementScoring({
      membership: { organizationId: ORG, active: 30 },
      chapters: [{ id: "chapter-a", organizationId: ORG, label: "Chapter A", memberCount: 30 }],
      engagementCounts: [
        { organizationId: ORG, chapterId: "chapter-a", eventType: "meeting_check_in", count: 10 },
        { organizationId: ORG, chapterId: "chapter-a", eventType: "poll_vote", count: 5 },
      ],
    }, viewer());

    expect(engagement.enoughData).toBe(true);
    expect(engagement.chapters).toContainEqual(expect.objectContaining({ id: "chapter-a", score: 40 }));
    expect(Object.values(engagement.histogram)).toContainEqual({ value: 1, suppressed: false });
  });
});

describe("attendance and export", () => {
  it("rolls attendance by chapter and week without foreign events", () => {
    const attendance = buildAttendanceAnalytics({
      attendanceEvents: [
        { organizationId: ORG, id: "e1", chapterId: "north", startsAt: "2026-08-10T17:00:00.000Z", rsvpGoing: 20, checkIns: 15 },
        { organizationId: ORG, id: "e2", chapterId: "north", startsAt: "2026-08-18T17:00:00.000Z", rsvpGoing: 10, checkIns: 9 },
        { organizationId: OTHER, id: "leak", chapterId: "foreign", startsAt: "2026-08-18T17:00:00.000Z", rsvpGoing: 80, checkIns: 80 },
      ],
      attendanceCohorts: { organizationId: ORG, firstTime: 12, repeat: 8 },
    }, viewer(), new Date("2026-08-22T12:00:00.000Z"));
    expect(attendance.totals.events).toBe(2);
    expect(attendance.totals.checkIns).toBeNull();
    expect(attendance.chapters).toHaveLength(1);
    expect(attendance.cohorts.enoughData).toBe(false);
  });

  it("uses the configured floor consistently in recent attendance", () => {
    const attendance = buildAttendanceAnalytics({ privacyThreshold: 30, attendanceEvents: [
      { organizationId: ORG, id: 'visible', startsAt: '2026-08-20T17:00:00.000Z', rsvpGoing: 40, checkIns: 32 },
      { organizationId: ORG, id: 'hidden', startsAt: '2026-08-19T17:00:00.000Z', rsvpGoing: 40, checkIns: 27 },
    ] }, viewer(), new Date('2026-08-22T12:00:00.000Z'));
    expect(attendance.recent[0]).toMatchObject({ checkIns: 32, suppressed: false });
    expect(attendance.recent[1]).toMatchObject({ checkIns: null, expected: null, rate: null, suppressed: true });
    expect(attendance.totals.suppressed).toBe(true);
  });

  // An organization limit under 25 is a valid server read, but the browser
  // still releases no group under 25 (Lovable audit APP-STEWARD-07), and the
  // workspace check compares the floors as enforced.
  it("never releases a group under 25 when the organization limit is lower", () => {
    expect(analyticsAnonymityFloor(10)).toBe(25);
    expect(analyticsAnonymityFloor(24)).toBe(25);
    expect(analyticsAnonymityFloor(40)).toBe(40);
    expect(analyticsAnonymityFloor(9)).toBe(25);
    const attendance = buildAttendanceAnalytics({ privacyThreshold: 10, attendanceEvents: [
      { organizationId: ORG, id: 'released', startsAt: '2026-08-20T17:00:00.000Z', rsvpGoing: 40, checkIns: 30 },
      { organizationId: ORG, id: 'small', startsAt: '2026-08-19T17:00:00.000Z', rsvpGoing: 15, checkIns: 12 },
    ] }, viewer(), new Date('2026-08-22T12:00:00.000Z'));
    expect(attendance.recent[0]).toMatchObject({ checkIns: 30, suppressed: false });
    expect(attendance.recent[1]).toMatchObject({ checkIns: null, suppressed: true });
  });

  it("suppresses derived totals when any included event is below the cell floor", () => {
    const attendance = buildAttendanceAnalytics({
      attendanceEvents: [
        { organizationId: ORG, id: "large", startsAt: "2026-08-10T17:00:00.000Z", rsvpGoing: 20, checkIns: 15 },
        { organizationId: ORG, id: "small", startsAt: "2026-08-18T17:00:00.000Z", rsvpGoing: 4, checkIns: 3 },
      ],
    }, viewer(), new Date("2026-08-22T12:00:00.000Z"));
    expect(attendance.totals).toEqual({
      events: 2,
      suppressed: true,
      checkIns: null,
      averagePerEvent: null,
      bestAttendance: null,
    });
  });

  it("redacts suppressed heatmap cells in authorized exports", () => {
    const model = composeAnalyticsCore({
      snapshot: {
        organizationId: ORG,
        privacyThreshold: ANALYTICS_COHORT_FLOOR,
        chapters: Array.from({ length: 4 }, (_, index) => ({
          id: `c${index}`,
          organizationId: ORG,
          memberCount: 32,
          stewardCount: 2,
        })),
        membership: { organizationId: ORG, active: 128, newIn90: 4 },
        cases: [],
        usageViews: [],
        heatmapPoints: [
          { organizationId: ORG, kind: "grievance", rowKey: "a", colKey: "n", count: 2 },
        ],
        series: Array.from({ length: 25 }, (_, index) => seriesRow(index)),
        engagementCounts: [],
        attendanceEvents: [],
      },
      viewer: viewer({ selectedHat: "admin", roles: ["admin"] }),
    });
    const exported = buildAnalyticsExport(model, viewer({ selectedHat: "admin", roles: ["admin"] }));
    expect(exported.ok).toBe(true);
    expect(exported.payload.body).toContain("suppressed");
    expect(exported.payload.body).not.toContain("service_role");
    expect(exported.audit.metadata.organizationId).toBe(ORG);
    expect(exported.audit.allowedKeys).toContain("exportFormat");
  });

  it("covers empty attendance values and every protected export serialization path", () => {
    const attendance = buildAttendanceAnalytics({
      attendanceEvents: [
        { organizationId: ORG, id: "undated", chapterId: null, startsAt: null, rsvpGoing: 0, checkIns: 0 },
        { organizationId: ORG, id: "invalid", chapterId: "north", startsAt: "not-a-date", rsvpGoing: 0, checkIns: 2 },
      ],
      attendanceCohorts: { organizationId: ORG, firstTime: 25, repeat: 1 },
    }, viewer(), new Date("2026-08-22T12:00:00.000Z"));
    expect(attendance.totals.events).toBe(0);
    expect(attendance.trend).toHaveLength(0);
    expect(attendance.cohorts.enoughData).toBe(false);
    expect(attendance.chapters).toEqual([]);

    const model = composeAnalyticsCore({
      snapshot: createPreviewAnalyticsSnapshot(new Date("2026-08-22T12:00:00.000Z")),
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
      now: new Date("2026-08-22T12:00:00.000Z"),
    });
    const admin = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const rows = flattenAnalyticsExportRows(model);
    expect(rows.map((row) => row.surface)).toEqual(expect.arrayContaining([
      "stats", "usage", "heatmaps", "engagement", "attendance",
    ]));
    expect(serializeAnalyticsCsv([{ surface: "stats", section: "a", label: "quoted,\"label\"", value: null }]))
      .toContain('"quoted,""label"""');
    expect(serializeAnalyticsCsv([{ surface: null, section: "line\nbreak", label: "plain", value: 0 }]))
      .toContain('"line\nbreak"');
    expect(serializeAnalyticsCsv([{ surface: "stats", section: "labels", label: "=HYPERLINK(\"https://example.invalid\")", value: "+42" }]))
      .toContain('"\'=HYPERLINK(""https://example.invalid"")",\'+42');
    expect(serializeAnalyticsCsv([{ surface: "stats", section: "labels", label: "  =1+1", value: -42 }]))
      .toContain("'  =1+1,-42");
    expect(serializeAnalyticsCsv([{ surface: "stats", section: "line\rbreak", label: "plain", value: 0 }]))
      .toContain('"line\rbreak"');
    expect(flattenAnalyticsExportRows({})).toEqual([]);
    const json = buildAnalyticsExport(model, admin, { format: "json", now: new Date("2026-08-22T12:00:00.000Z") });
    expect(json.payload.filename).toBe(`organization-analytics-${admin.organizationId}-2026-08-22.json`);
    expect(JSON.parse(json.payload.body).rows).toHaveLength(rows.length);
    expect(buildAnalyticsExport(model, { ...admin, chapterId: null }, { format: "csv" }).audit.metadata.chapterId).toBeNull();
    expect(buildAnalyticsExport(model, viewer()).reason).toBe("export_denied");
  });
});

describe("live snapshot capability boundaries", () => {
  it("marks hard-coded placeholder analytics unavailable instead of ready-empty", () => {
    const model = composeAnalyticsCore({
      snapshot: {
        organizationId: ORG,
        privacyThreshold: ANALYTICS_COHORT_FLOOR,
        chapters: [{ id: "chapter-a", memberCount: 40, stewardCount: 5 }],
        cases: [{ chapterId: "chapter-a", status: "active", count: 10 }],
        series: [{ chapterId: "chapter-a", openCases: 10, attendanceRate: null, engagementMean: null, usageViews: null }],
        heatmapPoints: [{ kind: "grievance", rowKey: "chapter-a", colKey: "contract", count: 10 }],
        attendanceEvents: [],
        attendanceCohorts: { organizationId: ORG, firstTime: null, repeat: null, suppressed: true },
      },
      viewer: viewer(),
    });
    expect(model.state).toBe("ready");
    expect(model.stats.overview.openCases).toBe(10);
    expect(model.insights).toMatchObject({ available: false, reason: "source_unavailable" });
    expect(model.heatmaps.solidarity).toMatchObject({ available: false, reason: "source_unavailable" });
    expect(model.attendance).toMatchObject({ available: false, reason: "source_unavailable" });
  });
});

describe("analytics adapter", () => {
  const admin = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });

  it("treats error snapshots without organizationId as a retryable error", () => {
    const desk = composeAnalyticsCore({
      snapshot: { error: "snapshot_failed" },
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    });
    expect(desk).toMatchObject({ state: "error", reason: "snapshot_failed" });
    expect(desk.state).not.toBe("unauthorized");
    expect(desk.reason).not.toBe("organization_scope_missing");

    const missing = composeAnalyticsCore({
      snapshot: { privacyThreshold: ANALYTICS_COHORT_FLOOR },
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    });
    expect(missing).toMatchObject({ state: "unauthorized", reason: "organization_scope_missing" });

    const invented = normalizeAnalyticsSnapshot({
      privacyThreshold: ANALYTICS_COHORT_FLOOR,
      chapters: [],
    }, admin.organizationId);
    expect(invented).toMatchObject({ unavailable: true, reason: "organization_scope_missing", organizationId: null });
  });

  it("loads unset, ready, and failed snapshots without crossing the adapter boundary", async () => {
    await expect(createAnalyticsCoreAdapter().loadDesk({ viewer: admin })).resolves.toMatchObject({ state: "unset" });
    await expect(createAnalyticsCoreAdapter({
      fetchSnapshot: async () => createPreviewAnalyticsSnapshot(),
    }).loadDesk({ viewer: admin, now: new Date("2026-08-22T12:00:00.000Z") })).resolves.toMatchObject({ state: "ready" });
    await expect(createAnalyticsCoreAdapter({
      fetchSnapshot: async () => { throw new Error("offline"); },
    }).loadDesk({ viewer: admin })).resolves.toMatchObject({ state: "error", reason: "snapshot_failed" });
  });

  it("requests authorized receipts and fails closed on export persistence errors", async () => {
    const model = composeAnalyticsCore({ snapshot: createPreviewAnalyticsSnapshot(), viewer: admin });
    const requestExport = async ({ format, rowCount, suppressedCount }) => ({ id: "receipt-a", format, rowCount, suppressedCount });
    await expect(createAnalyticsCoreAdapter({ requestExport }).exportDesk(model, admin, { format: "json" }))
      .resolves.toMatchObject({
        ok: true,
        receipt: { id: "receipt-a", format: "json", rowCount: expect.any(Number), suppressedCount: expect.any(Number) },
      });
    await expect(createAnalyticsCoreAdapter({
      requestExport: async () => { throw new Error("write failed"); },
    }).exportDesk(model, admin, { format: "csv" })).resolves.toEqual({
      ok: false,
      state: "error",
      reason: "export_failed",
      payload: null,
      audit: null,
    });
    await expect(createAnalyticsCoreAdapter({ requestExport }).exportDesk(model, viewer(), { format: "csv" }))
      .resolves.toMatchObject({ ok: false, reason: "export_denied" });
    const localOnly = await createAnalyticsCoreAdapter().exportDesk(model, admin, { format: "csv" });
    expect(localOnly).toMatchObject({ ok: true });
    expect(localOnly).not.toHaveProperty("receipt");
  });
});
