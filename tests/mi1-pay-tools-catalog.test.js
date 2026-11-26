// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemoryPayCatalog } from "../src/features/pay/adapter.js";
import {
  compareCatalogYearOverYear,
  comparePayScaleRecords,
  queryPayScale,
} from "../src/features/pay/catalog.js";
import { createPayTools } from "../src/features/pay/index.js";

function admin(org = "org-a") {
  return {
    userId: "admin-1",
    selectedOrganizationId: org,
    membershipStatus: "active",
    roles: ["admin"],
  };
}

function member(org = "org-a") {
  return {
    userId: "member-1",
    selectedOrganizationId: org,
    membershipStatus: "active",
    roles: [],
  };
}

function seedTwoYears(catalog = createMemoryPayCatalog()) {
  const writer = admin();
  catalog.upsertGrade(writer, { organizationId: "org-a", grade: "20", title: "Examiner I", stepCount: 12 });
  catalog.upsertStep(writer, {
    organizationId: "org-a",
    grade: "20",
    stepNumber: 1,
    effectiveOn: "2024-07-14",
    hourlyRateCents: 3267,
  });
  catalog.upsertStep(writer, {
    organizationId: "org-a",
    grade: "20",
    stepNumber: 1,
    effectiveOn: "2025-07-13",
    hourlyRateCents: 3399,
  });
  catalog.upsertStep(writer, {
    organizationId: "org-a",
    grade: "20",
    stepNumber: 5,
    effectiveOn: "2025-07-13",
    hourlyRateCents: 3827,
  });
  return catalog;
}

describe("CR-046 queryable pay-scale comparison", () => {
  it("starts empty for a first organization and never ships a default CBA", () => {
    const tools = createPayTools({ actor: member() });
    const empty = tools.presentTables();
    expect(empty.state).toBe("empty");
    expect(empty.rows).toEqual([]);
    expect(empty.message).toMatch(/has not added its contract pay rates yet/);
    expect(tools.persistence.seedPolicy).toBe("empty_on_reset");
    expect(tools.persistence.anonAccess).toBe(false);
  });

  it("presents a grade without visible rate rows as an honest empty catalog", () => {
    const catalog = createMemoryPayCatalog();
    catalog.upsertGrade(admin(), {
      organizationId: "org-a",
      grade: "20",
      title: "Examiner I",
      stepCount: 1,
    });
    const tables = createPayTools({ actor: member(), catalog }).presentTables({});
    expect(tables).toMatchObject({ state: "empty", rows: [] });
    expect(tables.message).toMatch(/has not added its contract pay rates yet/);
  });

  it("queries only the selected organization's published steps", () => {
    const catalog = seedTwoYears();
    const result = queryPayScale({
      actor: member(),
      catalog,
      organizationId: "org-a",
      filters: { grade: "20", effectiveYear: 2025, rules: { hoursPerYear: 2087 } },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((row) => row.hourlyRateCents).sort()).toEqual([3399, 3827]);
    expect(result.steps.every((row) => row.annualSalaryCents === row.hourlyRateCents * 2087)).toBe(true);
  });

  it("compares step, year, and grade-adjacent records", () => {
    const catalog = seedTwoYears();
    const year = compareCatalogYearOverYear({
      actor: member(),
      catalog,
      organizationId: "org-a",
      grade: "20",
      stepNumber: 1,
      fromYear: 2024,
      toYear: 2025,
      rules: { hoursPerYear: 2087, checksPerYear: 26 },
    });
    expect(year.ok).toBe(true);
    expect(year.hourlyDeltaCents).toBe(132);
    expect(year.annualDeltaCents).toBe(132 * 2087);
    expect(year.percentChange).toBeCloseTo(4.0404, 3);

    const step = comparePayScaleRecords({
      actor: member(),
      catalog,
      organizationId: "org-a",
      left: { grade: "20", stepNumber: 1, effectiveOn: "2025-12-31" },
      right: { grade: "20", stepNumber: 5, effectiveOn: "2025-12-31" },
      rules: { hoursPerYear: 2087, checksPerYear: 26 },
    });
    expect(step.ok).toBe(true);
    expect(step.hourlyDeltaCents).toBe(428);
    expect(step.left.annualSalaryCents).toBe(3399 * 2087);
    expect(step.right.annualSalaryCents).toBe(3827 * 2087);
  });

  it("keeps annual and per-check conventions unset until supplied", () => {
    const catalog = seedTwoYears();
    const query = queryPayScale({ actor: member(), catalog, organizationId: "org-a" });
    expect(query.steps.every((row) => row.annualSalaryCents === null)).toBe(true);

    const comparison = comparePayScaleRecords({
      actor: member(),
      catalog,
      organizationId: "org-a",
      left: { grade: "20", stepNumber: 1, effectiveOn: "2024-12-31" },
      right: { grade: "20", stepNumber: 1, effectiveOn: "2025-12-31" },
    });
    expect(comparison).toEqual({
      ok: false,
      reason: "calculation_rules_unset",
      details: { fields: ["hoursPerYear", "checksPerYear"] },
    });
  });

  it("distinguishes missing or malformed comparison dates from missing scales", () => {
    const catalog = seedTwoYears();
    const common = {
      actor: member(),
      catalog,
      organizationId: "org-a",
      rules: { hoursPerYear: 2087, checksPerYear: 26 },
    };
    expect(comparePayScaleRecords({
      ...common,
      left: { grade: "20", stepNumber: 1 },
      right: { grade: "20", stepNumber: 5, effectiveOn: "2025-12-31" },
    })).toEqual({
      ok: false,
      reason: "calculation_date_required",
      details: { fields: ["left.effectiveOn"] },
    });
    expect(comparePayScaleRecords({
      ...common,
      left: { grade: "20", stepNumber: 1, effectiveOn: "not-a-date" },
      right: { grade: "20", stepNumber: 5, effectiveOn: "2025-12-31" },
    })).toEqual({
      ok: false,
      reason: "invalid_input",
      details: { fields: ["left.effectiveOn"] },
    });
    expect(comparePayScaleRecords({
      ...common,
      left: { grade: "", stepNumber: 1, effectiveOn: "2025-12-31" },
      right: { grade: "20", stepNumber: 5, effectiveOn: "2025-12-31" },
    })).toEqual({
      ok: false,
      reason: "invalid_input",
      details: { fields: ["left.grade"] },
    });
  });

  it("uses the latest effective date on or before the requested day", () => {
    const catalog = seedTwoYears();
    const beforeIncrease = queryPayScale({
      actor: member(),
      catalog,
      organizationId: "org-a",
      filters: { grade: "20", stepNumber: 1, effectiveOn: "2025-07-12" },
    });
    expect(beforeIncrease.steps).toHaveLength(1);
    expect(beforeIncrease.steps[0].hourlyRateCents).toBe(3267);
    expect(beforeIncrease.steps[0].effectiveOn).toBe("2024-07-14");
  });

  it("rejects a step write without a parent grade and presents a comparison miss honestly", () => {
    const catalog = createMemoryPayCatalog();
    expect(catalog.upsertStep(admin(), {
      organizationId: "org-a",
      grade: "21",
      stepNumber: 1,
      effectiveOn: "2026-01-01",
      hourlyRate: 34,
    })).toMatchObject({ ok: false, reason: "scale_not_found" });

    const missing = comparePayScaleRecords({
      actor: member(),
      catalog,
      organizationId: "org-a",
      left: { grade: "20", stepNumber: 1, effectiveOn: "2026-01-01" },
      right: { grade: "21", stepNumber: 1, effectiveOn: "2026-01-01" },
    });
    expect(missing.reason).toBe("scale_not_found");
  });
});
