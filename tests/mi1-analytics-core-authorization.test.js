// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  authorizeAnalyticsAccess,
  buildAnalyticsExport,
  canReadOrganizationAnalytics,
  composeAnalyticsCore,
  createAnalyticsCoreAdapter,
  rejectCallerSuppliedOrganization,
} from "../src/features/analytics/index.js";

const ORG = "org-a";
const OTHER = "org-b";

describe("analytics authorization", () => {
  it("keeps the member hat off the organization desk even when staff grants exist", () => {
    const viewer = {
      organizationId: ORG,
      selectedHat: "member",
      roles: ["steward", "admin"],
    };
    expect(canReadOrganizationAnalytics(viewer)).toBe(false);
    expect(authorizeAnalyticsAccess(viewer, ORG)).toEqual({
      ok: false,
      state: "unauthorized",
      reason: "member_hat",
    });
  });

  it("rejects a caller-supplied foreign organization id", () => {
    const viewer = { organizationId: ORG, selectedHat: "steward", roles: ["steward"], organizationRoles: ["steward"] };
    expect(rejectCallerSuppliedOrganization(viewer, OTHER)).toBeNull();
    expect(authorizeAnalyticsAccess(viewer, OTHER).reason).toBe("cross_organization");
    const model = composeAnalyticsCore({
      snapshot: { organizationId: OTHER, chapters: [], cases: [] },
      viewer,
    });
    expect(model.state).toBe("unauthorized");
    expect(model.stats).toBeNull();
  });

  it("denies export to steward hats and allows coordinator", () => {
    const model = composeAnalyticsCore({
      snapshot: { organizationId: ORG, chapters: [], cases: [], usageViews: [] },
      viewer: { organizationId: ORG, selectedHat: "steward", roles: ["steward"], organizationRoles: ["steward"] },
    });
    expect(buildAnalyticsExport(model, { organizationId: ORG, selectedHat: "steward", roles: ["steward"], organizationRoles: ["steward"] }).ok).toBe(false);
    expect(buildAnalyticsExport(model, { organizationId: ORG, selectedHat: "coordinator", roles: ["coordinator"], organizationRoles: ["coordinator"] }).ok).toBe(true);
  });

  it("stays empty when no organization exists and unset when the snapshot is unwired", async () => {
    const empty = composeAnalyticsCore({
      viewer: { organizationId: null, selectedHat: "admin", roles: ["admin"] },
    });
    expect(empty.state).toBe("empty");

    const adapter = createAnalyticsCoreAdapter();
    const unset = await adapter.loadDesk({
      viewer: { organizationId: ORG, selectedHat: "admin", roles: ["admin"], organizationRoles: ["admin"] },
    });
    expect(unset.state).toBe("unset");
    expect(adapter.requestedRpcs.snapshot).toBe("get_organization_analytics_snapshot");
  });
});
