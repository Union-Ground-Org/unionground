// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemoryPayCatalog } from "../src/features/pay/adapter.js";
import { authorizePay } from "../src/features/pay/authorization.js";
import { calculatePay } from "../src/features/pay/calculator.js";
import { queryPayScale } from "../src/features/pay/catalog.js";
import { createPayTools } from "../src/features/pay/index.js";

function actor(overrides = {}) {
  return {
    userId: "user-1",
    selectedOrganizationId: "org-a",
    membershipStatus: "active",
    roles: [],
    ...overrides,
  };
}

function seedBothOrgs() {
  const catalog = createMemoryPayCatalog();
  for (const organizationId of ["org-a", "org-b"]) {
    const writer = actor({ selectedOrganizationId: organizationId, roles: ["admin"] });
    catalog.upsertGrade(writer, { organizationId, grade: "20", title: "Examiner I" });
    catalog.upsertStep(writer, {
      organizationId,
      grade: "20",
      stepNumber: 1,
      effectiveOn: "2026-01-01",
      hourlyRate: organizationId === "org-a" ? 30 : 50,
    });
  }
  return catalog;
}

describe("pay-tool organization isolation", () => {
  it("denies empty, revoked, and cross-organization access", () => {
    expect(authorizePay({
      actor: actor({ selectedOrganizationId: null }),
      organizationId: "org-a",
      capability: "calculate",
    }).reason).toBe("empty_organization");
    expect(authorizePay({
      actor: actor({ membershipStatus: "revoked" }),
      organizationId: "org-a",
      capability: "read_catalog",
    }).reason).toBe("membership_inactive");
    expect(authorizePay({
      actor: actor(),
      organizationId: "org-b",
      capability: "compare",
    }).reason).toBe("wrong_organization");
    expect(authorizePay({
      actor: null,
      organizationId: "org-a",
      capability: "calculate",
    }).reason).toBe("missing_actor");
  });

  it("keeps catalog reads and calculations inside the selected tenant", () => {
    const catalog = seedBothOrgs();
    const leaked = queryPayScale({
      actor: actor(),
      catalog,
      organizationId: "org-b",
    });
    expect(leaked.reason).toBe("wrong_organization");

    const own = queryPayScale({
      actor: actor(),
      catalog,
      organizationId: "org-a",
    });
    expect(own.ok).toBe(true);
    expect(own.steps).toHaveLength(1);
    expect(own.steps[0].hourlyRateCents).toBe(3000);

    const foreignRate = calculatePay({
      actor: actor(),
      catalog,
      organizationId: "org-a",
      input: { grade: "20", stepNumber: 1, effectiveOn: "2026-06-01" },
    });
    expect(foreignRate.rate.hourlyRateCents).toBe(3000);
  });

  it("reserves catalog writes for organization advisor, admin, or vp", () => {
    const catalog = createMemoryPayCatalog();
    const memberWrite = catalog.upsertGrade(actor(), {
      organizationId: "org-a",
      grade: "20",
      title: "Examiner I",
    });
    expect(memberWrite).toEqual({
      ok: false,
      reason: "unauthorized",
      details: { capability: "write_catalog" },
    });

    const stewardWrite = catalog.upsertGrade(actor({ roles: ["steward"] }), {
      organizationId: "org-a",
      grade: "20",
      title: "Examiner I",
    });
    expect(stewardWrite.reason).toBe("unauthorized");

    const adminWrite = catalog.upsertGrade(actor({ roles: ["admin"] }), {
      organizationId: "org-a",
      grade: "20",
      title: "Examiner I",
    });
    expect(adminWrite.ok).toBe(true);
    expect(adminWrite.audit).toEqual({
      action: "upsert_grade",
      organizationId: "org-a",
      grade: "20",
    });
  });

  it("does not let a second tenant's hat authorize the selected organization", () => {
    const tools = createPayTools({
      actor: actor({ selectedOrganizationId: "org-a", roles: ["admin"] }),
      catalog: seedBothOrgs(),
    });
    expect(tools.authorize("write_catalog").ok).toBe(true);
    expect(queryPayScale({
      actor: actor({ selectedOrganizationId: "org-a", roles: ["admin"] }),
      catalog: tools.catalog,
      organizationId: "org-b",
    }).reason).toBe("wrong_organization");
  });
});
