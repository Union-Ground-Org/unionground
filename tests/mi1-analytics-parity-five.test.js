// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_COHORT_FLOOR,
  ANALYTICS_EXPLORER_PAGE_SIZE,
  ANALYTICS_LAYOUT_PAGE_SIZE,
  analyticsScoreBand,
  composeAnalyticsCore,
  composeAnalyticsWorkspace,
  createAnalyticsCoreAdapter,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  normalizeMemberReportCard,
  paginateAnalyticsMembers,
  paginateAnalyticsLayouts,
  validateAnalyticsChartSpec,
} from "../src/features/analytics/index.js";

const ORG = "preview-analytics-org";

function workspace(overrides = {}) {
  return {
    organizationId: ORG,
    generatedAt: "2026-08-28T12:00:00Z",
    privacyThreshold: ANALYTICS_COHORT_FLOOR,
    members: [
      {
        organizationId: ORG,
        id: "member-a:chapter-a",
        name: "Avery Chen",
        chapterId: "chapter-a",
        chapterName: "North Chapter",
        participationScore: 60,
        profileReadiness: 100,
        followThrough: 40,
        overallScore: 67,
        attention: "watch",
        activeCases: 3,
        overdueCases: 0,
      },
      {
        organizationId: "foreign-org",
        id: "foreign:chapter-z",
        name: "Foreign record",
        chapterId: "chapter-z",
        overallScore: 99,
      },
    ],
    chapterHealth: [{
      organizationId: ORG,
      chapterId: "chapter-a",
      chapterName: "North Chapter",
      memberCount: 31,
      protected: false,
      score: 72,
      drivers: { participation: 68 },
      trend: [{ measuredOn: "2026-08-01", score: 70 }],
    }],
    datasets: [{
      organizationId: ORG,
      id: "chapter:chapter-a:health-trend",
      label: "North health trend",
      scope: "chapter",
      chapterId: "chapter-a",
      rows: [{ label: "Aug", value: 72 }],
    }],
    layouts: [{
      id: "layout-a",
      organizationId: ORG,
      name: "North scorecard",
      scope: "chapter",
      chapterId: "chapter-a",
      spec: { datasetId: "chapter:chapter-a:health-trend", chartType: "line", title: "North scorecard" },
      canEdit: true,
    }],
    ...overrides,
  };
}

describe("MI1 analytics parity five", () => {
  it("normalizes an honest self-only report card and no-signal state", () => {
    expect(normalizeMemberReportCard(null).state).toBe("empty");
    expect(normalizeMemberReportCard({ overall: null, participation: 0 }).state).toBe("empty");
    expect(normalizeMemberReportCard({
      overall: 74.6,
      participation: 80,
      profileReadiness: 100,
      followThrough: 45,
      signals: [{ label: "Protected activities", value: 8 }],
    })).toMatchObject({
      state: "ready",
      overall: 75,
      components: [
        { id: "participation", score: 80 },
        { id: "profileReadiness", score: 100 },
        { id: "followThrough", score: 45 },
      ],
    });
    // REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: the old five health tiers
    // (24/44/64/84) by default, adjustable per organization.
    expect(analyticsScoreBand(75)).toBe("healthy");
    expect(analyticsScoreBand(85)).toBe("excellent");
    expect(analyticsScoreBand(24)).toBe("critical");
    expect(analyticsScoreBand(75, { criticalMax: 10, concerningMax: 20, moderateMax: 80, healthyMax: 90 })).toBe("moderate");
  });

  it("composes the health tree, explorer rows, datasets, and chapter charts without foreign rows", () => {
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const result = composeAnalyticsWorkspace({ workspace: workspace(), viewer });
    expect(result.state).toBe("ready");
    expect(result.members.map((member) => member.name)).toEqual(["Avery Chen"]);
    expect(result.chapters[0]).toMatchObject({ chapterId: "chapter-a", health: { score: 72 } });
    expect(result.chapterCharts).toHaveLength(1);
    expect(result.chapterCharts[0].spec.chartType).toBe("line");

    const desk = composeAnalyticsCore({
      snapshot: createPreviewAnalyticsSnapshot(),
      workspace: workspace(),
      viewer,
    });
    expect(desk.workspace.state).toBe("ready");
    expect(desk.workspace.members).toHaveLength(1);
  });

  it("keeps a member who hid their Pulse score, with no score, activity or activity band (#6774)", () => {
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const hidden = (extra) => ({ organizationId: ORG, chapterId: "chapter-a", chapterName: "North Chapter", scoreHidden: true,
      participationScore: null, profileReadiness: 100, followThrough: null, overallScore: null, lastActivityAt: "2026-08-27T12:00:00Z", activeCases: 2, ...extra });
    const base = workspace();
    const result = composeAnalyticsWorkspace({ workspace: { ...base, members: [...base.members,
      hidden({ id: "member-b:chapter-a", name: "Blair Hidden", attention: null, overdueCases: 0 }),
      hidden({ id: "member-c:chapter-a", name: "Casey Overdue", attention: "urgent", overdueCases: 1 })] }, viewer });
    const byName = Object.fromEntries(result.members.map((member) => [member.name, member]));
    expect(byName["Blair Hidden"]).toMatchObject({ scoreHidden: true, overallScore: null, profileReadiness: null, participationScore: null,
      followThrough: null, lastActivityAt: null, attention: null, activeCases: 2 });
    expect(byName["Casey Overdue"]).toMatchObject({ scoreHidden: true, overallScore: null, attention: "urgent", overdueCases: 1 });
    expect(byName["Avery Chen"]).toMatchObject({ scoreHidden: false, overallScore: 67, attention: "watch" });
    const order = result.chapters[0].members.map((member) => member.name);
    expect(order.indexOf("Casey Overdue")).toBe(0);
    expect(order.at(-1)).toBe("Blair Hidden");
  });

  it("fails closed on a foreign tenant, wrong privacy floor, and unapproved chart specs", () => {
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    expect(composeAnalyticsWorkspace({ workspace: workspace({ organizationId: "foreign-org" }), viewer }))
      .toMatchObject({ state: "unauthorized", reason: "cross_organization" });
    expect(composeAnalyticsWorkspace({ workspace: workspace({ privacyThreshold: 5 }), viewer }))
      .toMatchObject({ state: "unavailable", reason: "privacy_floor_mismatch" });
    expect(composeAnalyticsWorkspace({ workspace: workspace({ privacyThreshold: 40 }), viewer, expectedFloor: 25 }))
      .toMatchObject({ state: "unavailable", reason: "privacy_floor_mismatch" });
    expect(validateAnalyticsChartSpec({ datasetId: "missing", chartType: "bar" }, workspace().datasets)).toBeNull();
    expect(validateAnalyticsChartSpec({ datasetId: "chapter:chapter-a:health-trend", chartType: "script" }, workspace().datasets)).toBeNull();
  });

  it("persists layout mutations through the adapter and reports failures honestly", async () => {
    const saveLayout = async (input) => ({ id: "layout-a", spec: input.spec });
    const deleteLayout = async ({ id }) => ({ id, deleted: true });
    const adapter = createAnalyticsCoreAdapter({ saveLayout, deleteLayout });
    await expect(adapter.saveLayout({ spec: { datasetId: "organization:chapter-health", chartType: "bar" } }))
      .resolves.toMatchObject({ ok: true, layout: { id: "layout-a" } });
    await expect(adapter.deleteLayout({ id: "layout-a" }))
      .resolves.toEqual({ ok: true, layout: { id: "layout-a", deleted: true } });
    await expect(createAnalyticsCoreAdapter({
      saveLayout: async () => { throw new Error("offline"); },
    }).saveLayout({})).resolves.toEqual({ ok: false, reason: "layout_save_failed" });
  });

  it("uses the product layout page limit for complete, bounded pages", () => {
    const layouts = Array.from({ length: 31 }, (_, index) => ({ id: `layout-${index + 1}` }));
    expect(ANALYTICS_LAYOUT_PAGE_SIZE).toBe(15);
    expect(paginateAnalyticsLayouts(layouts, 0)).toMatchObject({ page: 0, pageCount: 3 });
    expect(paginateAnalyticsLayouts(layouts, 0).items).toHaveLength(15);
    expect(paginateAnalyticsLayouts(layouts, 2).items).toHaveLength(1);
    expect(paginateAnalyticsLayouts(layouts, 99)).toMatchObject({ page: 2, pageCount: 3 });
    expect(paginateAnalyticsLayouts([], 4)).toEqual({ items: [], page: 0, pageCount: 1, total: 0 });
  });

  it("uses a measured member Explorer page limit without truncating the collection", () => {
    const members = Array.from({ length: 61 }, (_, index) => ({ id: `member-${index + 1}` }));
    expect(ANALYTICS_EXPLORER_PAGE_SIZE).toBe(25);
    expect(paginateAnalyticsMembers(members, 0)).toMatchObject({ page: 0, pageCount: 3, total: 61 });
    expect(paginateAnalyticsMembers(members, 0).items).toHaveLength(25);
    expect(paginateAnalyticsMembers(members, 2).items).toHaveLength(11);
    expect(paginateAnalyticsMembers(members, 99)).toMatchObject({ page: 2, pageCount: 3 });
    expect(paginateAnalyticsMembers([], 4)).toEqual({ items: [], page: 0, pageCount: 1, total: 0 });
  });
});
