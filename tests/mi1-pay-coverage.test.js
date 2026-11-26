// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryPayCatalog,
  createPayCatalogFromRpcPayload,
  createPayRpcAdapter,
} from "../src/features/pay/adapter.js";
import { isPayFailureReason, payFailure } from "../src/features/pay/errors.js";
import { createPayTools } from "../src/features/pay/index.js";
import {
  centsToDollars,
  dollarsToCents,
  formatUsdFromCents,
  multiplyCents,
  percentOfCents,
} from "../src/features/pay/money.js";
import {
  presentCalculation,
  presentCatalog,
  presentComparison,
} from "../src/features/pay/presenters.js";
import {
  isIsoDate,
  mergeCalculationRules,
  normalizeGrade,
  normalizeHours,
  normalizeRaise,
  normalizeStepNumber,
} from "../src/features/pay/rules.js";

function actor(overrides = {}) {
  return {
    userId: "user-1",
    selectedOrganizationId: "org-a",
    membershipStatus: "active",
    roles: [],
    ...overrides,
  };
}

function seededCatalog() {
  const catalog = createMemoryPayCatalog();
  const writer = actor({ roles: ["admin"] });
  catalog.upsertGrade(writer, { organizationId: "org-a", grade: "A", title: "Grade A" });
  catalog.upsertStep(writer, {
    organizationId: "org-a",
    grade: "A",
    stepNumber: 1,
    effectiveOn: "2024-01-01",
    hourlyRateCents: 2500,
  });
  catalog.upsertStep(writer, {
    organizationId: "org-a",
    grade: "A",
    stepNumber: 1,
    effectiveOn: "2025-01-01",
    hourlyRateCents: 2600,
  });
  return catalog;
}

describe("pay engine threshold coverage", () => {
  it("validates money primitives at their integer-cent boundaries", () => {
    expect(dollarsToCents("25")).toBeNull();
    expect(dollarsToCents(Number.POSITIVE_INFINITY)).toBeNull();
    expect(dollarsToCents(1_000_001)).toBeNull();
    expect(dollarsToCents(12.345)).toBe(1235);
    expect(centsToDollars(125)).toBe(1.25);
    expect(centsToDollars(1.5)).toBeNull();
    expect(formatUsdFromCents(-125)).toBe("-$1.25");
    expect(formatUsdFromCents(1.5)).toBeNull();
    expect(multiplyCents(125, 1.5)).toBe(188);
    expect(multiplyCents(1.5, 2)).toBeNull();
    expect(multiplyCents(100, Number.NaN)).toBeNull();
    expect(multiplyCents(100, -1)).toBeNull();
    expect(multiplyCents(100, 101)).toBeNull();
    expect(percentOfCents(1000, 12.5)).toBe(125);
    expect(percentOfCents(1.5, 5)).toBeNull();
    expect(percentOfCents(100, Number.NaN)).toBeNull();
    expect(percentOfCents(100, -1)).toBeNull();
    expect(percentOfCents(100, 101)).toBeNull();
  });

  it("rejects malformed calculation conventions and normalizes accepted inputs", () => {
    expect(mergeCalculationRules()).toEqual({
      nightMultiplier: null,
      weekendMultiplier: null,
      overtimeMultiplier: null,
      standbyHourlyCents: null,
      hoursPerYear: null,
      checksPerYear: null,
    });
    expect(mergeCalculationRules("rules")).toBeNull();
    expect(mergeCalculationRules({ invented: 1 })).toBeNull();
    expect(mergeCalculationRules({ nightMultiplier: Number.NaN })).toBeNull();
    expect(mergeCalculationRules({ nightMultiplier: 11 })).toBeNull();
    expect(mergeCalculationRules({ standbyHourlyCents: 1.5 })).toBeNull();
    expect(mergeCalculationRules({ hoursPerYear: 0 })).toBeNull();
    expect(mergeCalculationRules({ checksPerYear: 367 })).toBeNull();
    expect(mergeCalculationRules({ hoursPerCheck: 80 })).toBeNull();
    expect(mergeCalculationRules({ checksPerYear: 24 })).toMatchObject({ checksPerYear: 24 });

    expect(normalizeHours()).toEqual({ regular: 0, overtime: 0, night: 0, weekend: 0, standby: 0 });
    expect(normalizeHours("hours")).toBeNull();
    expect(normalizeHours({ regular: -1 })).toBeNull();
    expect(normalizeHours({ regular: Number.NaN })).toBeNull();
    expect(normalizeHours({ regular: 10_001 })).toBeNull();
    expect(normalizeHours({ regular: 8 })).toMatchObject({ regular: 8, overtime: 0 });

    expect(normalizeRaise()).toEqual({ raisePercent: null, unpaidPayPeriods: 0 });
    expect(normalizeRaise({ unpaidPayPeriods: 1 })).toBeNull();
    expect(normalizeRaise({ raisePercent: Number.NaN })).toBeNull();
    expect(normalizeRaise({ raisePercent: 5, unpaidPayPeriods: 1.5 })).toBeNull();
    expect(normalizeRaise({ raisePercent: 5, unpaidPayPeriods: 2 })).toEqual({ raisePercent: 5, unpaidPayPeriods: 2 });

    expect(isIsoDate("2026-08-25")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("08/25/2026")).toBe(false);
    expect(normalizeGrade(20)).toBeNull();
    expect(normalizeGrade(" ")).toBeNull();
    expect(normalizeGrade("A".repeat(33))).toBeNull();
    expect(normalizeGrade("A\u0000")).toBeNull();
    expect(normalizeGrade(" A ")).toBe("A");
    expect(normalizeStepNumber("s03")).toBe(3);
    expect(normalizeStepNumber("step 3")).toBeNull();
    expect(normalizeStepNumber(0)).toBeNull();
    expect(normalizeStepNumber(100)).toBeNull();
    expect(normalizeStepNumber(3)).toBe(3);
  });

  it("covers catalog rejection, clearing, and RPC-authorized write seams", async () => {
    const catalog = createMemoryPayCatalog([
      { kind: "grade", organizationId: "", grade: "A", title: "Invalid" },
      { kind: "step", organizationId: "org-a", grade: "A" },
    ]);
    expect(catalog.listGrades("org-a")).toEqual([]);
    expect(catalog.listSteps("org-a")).toEqual([]);
    expect(catalog.upsertGrade(actor({ roles: ["admin"] }), {})).toMatchObject({ reason: "invalid_input" });
    expect(catalog.upsertStep(actor({ roles: ["admin"] }), {})).toMatchObject({ reason: "invalid_input" });
    catalog.upsertGrade(actor({ roles: ["admin"] }), { organizationId: "org-a", grade: "A", title: "Grade A" });
    catalog.clear();
    expect(catalog.listGrades("org-a")).toEqual([]);

    expect(createPayCatalogFromRpcPayload(null, [])).toMatchObject({ reason: "catalog_unavailable" });
    expect(createPayCatalogFromRpcPayload([{ grade: "A" }], [])).toMatchObject({ reason: "catalog_unavailable" });
    expect(await createPayRpcAdapter(null).loadCatalog()).toMatchObject({ reason: "catalog_unavailable" });

    const calls = [];
    const api = createPayRpcAdapter({
      rpc: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return { data: { accepted: true }, error: null };
      }),
    });
    expect(await api.upsertGrade(actor(), {})).toMatchObject({ reason: "invalid_input" });
    expect(await api.upsertGrade(actor(), {
      organizationId: "org-a",
      grade: "A",
      title: "Grade A",
    })).toMatchObject({ reason: "unauthorized" });
    expect(await api.upsertGrade(actor({ roles: ["admin"] }), {
      organizationId: "org-a",
      grade: "A",
      title: "Grade A",
    })).toMatchObject({ ok: true });
    expect(await api.upsertStep(actor(), {})).toMatchObject({ reason: "invalid_input" });
    expect(await api.upsertStep(actor(), {
      organizationId: "org-a",
      grade: "A",
      stepNumber: 1,
      effectiveOn: "2026-01-01",
      hourlyRateCents: 2500,
    })).toMatchObject({ reason: "unauthorized" });
    expect(await api.upsertStep(actor({ roles: ["admin"] }), {
      organizationId: "org-a",
      grade: "A",
      stepNumber: 1,
      effectiveOn: "2026-01-01",
      hourlyRateCents: 2500,
    })).toMatchObject({ ok: true });
    expect(calls.map(({ name }) => name)).toEqual(["upsert_pay_scale_grade", "upsert_pay_scale_step"]);
    expect(calls[0].args).toEqual({
      p_expected_organization_id: "org-a",
      p_grade: "A",
      p_title: "Grade A",
      p_job_family: null,
      p_step_count: null,
      p_description: null,
    });
    expect(calls[1].args).toEqual({
      p_expected_organization_id: "org-a",
      p_grade: "A",
      p_effective_on: "2026-01-01",
      p_step_number: 1,
      p_hourly_rate_cents: 2500,
    });
  });

  it("exercises every composed tool operation and presentation failure family", () => {
    const tools = createPayTools({ actor: actor(), catalog: seededCatalog() });
    expect(tools.calculate({ hourlyRate: 25, hours: { regular: 40 } }).grossOwedCents).toBe(100000);
    expect(tools.query({ grade: "A" }).steps).toHaveLength(2);
    expect(tools.compare(
      { grade: "A", stepNumber: 1, effectiveOn: "2024-12-31" },
      { grade: "A", stepNumber: 1, effectiveOn: "2025-12-31" },
      { hoursPerYear: 2087, checksPerYear: 26 },
    ).hourlyDeltaCents).toBe(100);
    expect(tools.compareYears({
      grade: "A",
      stepNumber: 1,
      fromYear: 2024,
      toYear: 2025,
      rules: { hoursPerYear: 2087, checksPerYear: 26 },
    }).hourlyDeltaCents).toBe(100);
    expect(tools.presentCompare(
      { grade: "A", stepNumber: 1, effectiveOn: "2024-12-31" },
      { grade: "A", stepNumber: 1, effectiveOn: "2025-12-31" },
      { hoursPerYear: 2087, checksPerYear: 26 },
    )).toMatchObject({ state: "success", hourlyDelta: "$1.00" });

    const expectedStates = new Map([
      ["catalog_unavailable", "retry"],
      ["wrong_organization", "wrong_organization"],
      ["invalid_input", "validation"],
      ["calculation_date_required", "validation"],
      ["calculation_rules_unset", "validation"],
      ["empty_organization", "empty"],
      ["catalog_empty", "empty"],
      ["scale_not_found", "empty"],
      ["membership_inactive", "unauthorized"],
      ["unauthorized", "unauthorized"],
    ]);
    for (const [reason, state] of expectedStates) {
      expect(presentCalculation(payFailure(reason))).toMatchObject({ reason, state });
    }
    expect(presentCalculation(null)).toMatchObject({ reason: "invalid_input", state: "validation" });
    expect(presentComparison(null)).toMatchObject({ reason: "invalid_input", state: "validation" });
    expect(presentCatalog(null)).toMatchObject({ reason: "invalid_input", rows: [] });
    expect(presentCalculation(payFailure("unknown")).message).toMatch(/could not complete/);
    expect(isPayFailureReason("catalog_unavailable")).toBe(true);
    expect(isPayFailureReason("unknown")).toBe(false);
  });
});
