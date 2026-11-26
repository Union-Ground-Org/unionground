import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MI1 analytics mobile wiring", () => {
  it("registers Organization analytics as a staff-only native destination", () => {
    const catalog = readFileSync("apps/mobile/src/lib/featureCatalog.ts", "utf8");
    const hats = readFileSync("apps/mobile/src/lib/hatFunctions.ts", "utf8");
    expect(catalog).toContain("'analytics'");
    expect(catalog).toContain("analytics: 'Organization analytics'");
    expect(catalog).toContain("const STAFF_TOOL_FEATURE_KEYS = ['tasks', 'events-desk', 'campaigns', 'analytics', 'organization-map', 'partners']");
    expect(hats).toContain("key: 'analytics'");
    expect(hats).toContain("Organization analytics");
    // One per non-worker hat: organizer, steward (Committee), coordinator,
    // advisor, admin and vp. Union Ground adds the Organizer hat.
    expect(hats.match(/organizationAnalytics,/g)?.length).toBe(6);
  });

  it("reuses shared engines and backed preview history without mounting the web desk or other domains", () => {
    const shared = readFileSync("apps/mobile/src/lib/mi1AnalyticsShared.ts", "utf8");
    const screen = readFileSync("apps/mobile/src/features/mi1/AnalyticsCoreScreen.tsx", "utf8");
    const feature = readFileSync("apps/mobile/src/features/FeatureScreen.tsx", "utf8");
    const metro = readFileSync("apps/mobile/metro.config.js", "utf8");
    expect(shared).toContain("from '../../../../src/features/analytics/contract.js'");
    expect(shared).toContain("analyticsSnapshot: true");
    expect(shared).toContain("analyticsWorkspace: true");
    expect(shared).toContain("memberReportCard: true");
    expect(shared).not.toContain("AnalyticsCoreDesk");
    expect(shared).toContain("createPreviewAnalyticsSnapshot");
    expect(readFileSync("apps/mobile/src/features/mi1/Mi1AnalyticsScreen.tsx", "utf8")).toContain("mode === 'preview'");
    expect(shared).not.toContain("createQaRpcAdapter");
    expect(screen).toContain("composeAnalyticsCore({ snapshot: snapshot as any, workspace: workspace as any, viewer })");
    expect(feature).toContain("if (featureKey === 'analytics')");
    expect(feature).toContain("<Mi1AnalyticsScreen />");
    const livedIn = readFileSync("apps/mobile/src/features/LiveLivedInScreens.tsx", "utf8");
    expect(livedIn).toContain("normalizeMemberReportCard(reportError ? null : rawReportCard)");
    expect(livedIn).toContain("reportError ? <Button label={copy.retry}");
    expect(livedIn).toContain("profileReadiness: 'Preparación del perfil'");
    expect(livedIn).not.toContain("component.id.replaceAll");
    expect(metro).toContain("src/features");
  });
});
