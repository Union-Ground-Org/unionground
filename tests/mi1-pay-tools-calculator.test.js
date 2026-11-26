// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemoryPayCatalog } from "../src/features/pay/adapter.js";
import { calculatePay } from "../src/features/pay/calculator.js";
import { createPayTools } from "../src/features/pay/index.js";
import { presentCalculation } from "../src/features/pay/presenters.js";

function member(org = "org-a") {
  return {
    userId: "member-1",
    selectedOrganizationId: org,
    membershipStatus: "active",
    roles: [],
  };
}

function seedCatalog() {
  const catalog = createMemoryPayCatalog();
  const admin = {
    userId: "admin-1",
    selectedOrganizationId: "org-a",
    membershipStatus: "active",
    roles: ["admin"],
  };
  expect(catalog.upsertGrade(admin, {
    organizationId: "org-a",
    grade: "20",
    title: "Examiner I",
    stepCount: 12,
  }).ok).toBe(true);
  expect(catalog.upsertStep(admin, {
    organizationId: "org-a",
    grade: "20",
    stepNumber: 3,
    effectiveOn: "2026-01-01",
    hourlyRate: 30,
  }).ok).toBe(true);
  expect(catalog.upsertStep(admin, {
    organizationId: "org-a",
    grade: "20",
    stepNumber: 3,
    effectiveOn: "2027-01-01",
    hourlyRate: 40,
  }).ok).toBe(true);
  return catalog;
}

describe("CR-045 wage and back-pay calculator", () => {
  it("applies only explicitly supplied differential rules in integer cents", () => {
    const result = calculatePay({
      actor: member(),
      organizationId: "org-a",
      rules: {
        overtimeMultiplier: 1.5,
        nightMultiplier: 1.1,
        weekendMultiplier: 1.15,
        standbyHourlyCents: 350,
        hoursPerYear: 2087,
      },
      input: {
        hourlyRate: 30,
        hours: { regular: 40, overtime: 4, night: 8, weekend: 8, standby: 10 },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.rate.source).toBe("explicit");
    expect(result.rate.hourlyRateCents).toBe(3000);
    expect(result.rate.annualSalaryCents).toBe(3000 * 2087);
    expect(result.components).toEqual([
      { kind: "regular", hours: 40, rateCents: 3000, amountCents: 120000 },
      { kind: "overtime", hours: 4, rateCents: 4500, amountCents: 18000 },
      { kind: "night", hours: 8, rateCents: 3300, amountCents: 26400 },
      { kind: "weekend", hours: 8, rateCents: 3450, amountCents: 27600 },
      { kind: "standby", hours: 10, rateCents: 350, amountCents: 3500 },
    ]);
    expect(result.grossOwedCents).toBe(195500);
    expect(result.backPayCents).toBe(0);
  });

  it("computes underpayment back pay from hours owed versus amount paid", () => {
    const result = calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: {
        hourlyRateCents: 3000,
        hours: { regular: 40 },
        amountPaidCents: 100000,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.grossOwedCents).toBe(120000);
    expect(result.underpaymentCents).toBe(20000);
    expect(result.backPayCents).toBe(20000);

    const dollars = calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hourlyRate: 30, hours: { regular: 40 }, amountPaid: 1000 },
    });
    expect(dollars.amountPaidCents).toBe(100000);
    expect(dollars.backPayCents).toBe(20000);
  });

  it("computes multi-period totals above the contract-multiplier bound", () => {
    const result = calculatePay({
      actor: member(),
      organizationId: "org-a",
      rules: {
        overtimeMultiplier: 1.5,
        nightMultiplier: 1.1,
        weekendMultiplier: 1.15,
        standbyHourlyCents: 350,
      },
      input: {
        hourlyRate: 30,
        hours: { regular: 120, overtime: 120, night: 120, weekend: 120, standby: 120 },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.components).toEqual([
      { kind: "regular", hours: 120, rateCents: 3000, amountCents: 360000 },
      { kind: "overtime", hours: 120, rateCents: 4500, amountCents: 540000 },
      { kind: "night", hours: 120, rateCents: 3300, amountCents: 396000 },
      { kind: "weekend", hours: 120, rateCents: 3450, amountCents: 414000 },
      { kind: "standby", hours: 120, rateCents: 350, amountCents: 42000 },
    ]);
    expect(result.grossOwedCents).toBe(1_752_000);
  });

  it("computes raise per-check delta and retro from unpaid periods", () => {
    const result = calculatePay({
      actor: member(),
      organizationId: "org-a",
      rules: { hoursPerYear: 2087, checksPerYear: 26 },
      input: {
        hourlyRateCents: 3000,
        raisePercent: 6,
        unpaidPayPeriods: 14,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.raise.percent).toBe(6);
    expect(result.raise.newHourlyRateCents).toBe(3180);
    expect(result.raise.currentAnnualSalaryCents).toBe(6_261_000);
    expect(result.raise.newAnnualSalaryCents).toBe(6_636_660);
    expect(result.raise.annualDeltaCents).toBe(375_660);
    expect(result.raise.perCheckDeltaCents).toBe(Math.round(375_660 / 26));
    expect(result.raise.retroCents).toBe(Math.round((375_660 * 14) / 26));
    expect(result.backPayCents).toBe(result.raise.retroCents);
  });

  it("looks up an organization catalog rate and rejects a missing grade/step", () => {
    const catalog = seedCatalog();
    const found = calculatePay({
      actor: member(),
      catalog,
      organizationId: "org-a",
      input: { grade: "20", stepNumber: 3, effectiveOn: "2026-07-01", hours: { regular: 80 } },
    });
    expect(found.ok).toBe(true);
    expect(found.rate.source).toBe("catalog");
    expect(found.rate.hourlyRateCents).toBe(3000);
    expect(found.rate.effectiveOn).toBe("2026-01-01");
    expect(found.grossOwedCents).toBe(240000);

    const missingDate = calculatePay({
      actor: member(),
      catalog,
      organizationId: "org-a",
      input: { grade: "20", stepNumber: 3, hours: { regular: 80 } },
    });
    expect(missingDate).toEqual({
      ok: false,
      reason: "calculation_date_required",
      details: { field: "effectiveOn" },
    });

    const missing = calculatePay({
      actor: member(),
      catalog,
      organizationId: "org-a",
      input: { grade: "99", stepNumber: 1, effectiveOn: "2026-07-01" },
    });
    expect(missing).toEqual({ ok: false, reason: "scale_not_found" });
  });

  it("rejects invalid hours, raises, and rates without inventing a result", () => {
    for (const hourlyRate of [-30, 0, 100_000.01]) {
      expect(calculatePay({
        actor: member(),
        organizationId: "org-a",
        input: { hourlyRate, hours: { regular: 40 } },
      })).toEqual({ ok: false, reason: "invalid_input", details: { field: "rate" } });
    }
    expect(calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hourlyRate: 30, hours: { regular: -1 } },
    }).reason).toBe("invalid_input");
    expect(calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hourlyRate: 30, raisePercent: 140 },
    }).reason).toBe("invalid_input");
    expect(calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hours: { regular: 8 } },
    }).reason).toBe("invalid_input");
  });

  it("requires every premium or retro rule used by the estimate", () => {
    const premium = calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hourlyRate: 30, hours: { overtime: 2, night: 1 } },
    });
    expect(premium).toEqual({
      ok: false,
      reason: "calculation_rules_unset",
      details: { fields: ["overtimeMultiplier", "nightMultiplier"] },
    });

    const retro = calculatePay({
      actor: member(),
      organizationId: "org-a",
      rules: { hoursPerYear: 2087 },
      input: { hourlyRate: 30, raisePercent: 5, unpaidPayPeriods: 2 },
    });
    expect(retro).toEqual({
      ok: false,
      reason: "calculation_rules_unset",
      details: { fields: ["checksPerYear"] },
    });
  });

  it("presents success and validation states with an honest disclaimer", () => {
    const tools = createPayTools({ actor: member() });
    const success = tools.presentCalculator({
      hourlyRate: 30,
      hours: { regular: 40 },
      amountPaidCents: 100000,
    });
    expect(success.state).toBe("success");
    expect(success.grossOwed).toBe("$1200.00");
    expect(success.backPay).toBe("$200.00");
    expect(success.rate.annual).toBeNull();
    expect(success.disclaimer).toMatch(/not payroll/);

    const invalid = presentCalculation(calculatePay({
      actor: member(),
      organizationId: "org-a",
      input: { hourlyRate: 30, hours: { regular: -2 } },
    }));
    expect(invalid.state).toBe("validation");
  });
});
