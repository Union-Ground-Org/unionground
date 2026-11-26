import { authorizePay } from "./authorization.js";
import { annualSalaryCents, lookupPayRate } from "./catalog.js";
import { payFailure } from "./errors.js";
import { dollarsToCents, multiplyCents, percentOfCents } from "./money.js";
import {
  isIsoDate,
  MAX_HOURS,
  mergeCalculationRules,
  missingCalculationRuleFields,
  normalizeHours,
  normalizeRaise,
  requiredCalculationRuleFields,
} from "./rules.js";

function multiplyRateByHours(rateCents, hours) {
  if (!Number.isInteger(rateCents)
    || typeof hours !== "number"
    || !Number.isFinite(hours)
    || hours < 0
    || hours > MAX_HOURS) {
    return null;
  }
  return Math.round(rateCents * hours);
}

function resolveHourlyRate({ input, catalog, organizationId }) {
  if (Number.isInteger(input.hourlyRateCents)) {
    if (input.hourlyRateCents < 1 || input.hourlyRateCents > 100_000_00) return null;
    return {
      source: "explicit",
      hourlyRateCents: input.hourlyRateCents,
      grade: input.grade ?? null,
      stepNumber: input.stepNumber ?? null,
      effectiveOn: input.effectiveOn ?? null,
    };
  }

  if (typeof input.hourlyRate === "number") {
    const hourlyRateCents = dollarsToCents(input.hourlyRate);
    if (!Number.isInteger(hourlyRateCents)
      || hourlyRateCents < 1
      || hourlyRateCents > 100_000_00) return null;
    return {
      source: "explicit",
      hourlyRateCents,
      grade: input.grade ?? null,
      stepNumber: input.stepNumber ?? null,
      effectiveOn: input.effectiveOn ?? null,
    };
  }

  if (!catalog || !input.grade || input.stepNumber == null) return null;
  if (!isIsoDate(input.effectiveOn)) return { calculationDateRequired: true };
  const row = lookupPayRate(catalog.listSteps(organizationId), {
    organizationId,
    grade: input.grade,
    stepNumber: input.stepNumber,
    effectiveOn: input.effectiveOn,
  });
  if (!row) return { missing: true };
  return {
    source: "catalog",
    hourlyRateCents: row.hourlyRateCents,
    grade: row.grade,
    stepNumber: row.stepNumber,
    effectiveOn: row.effectiveOn,
  };
}

function buildComponents(hourlyRateCents, hours, rules) {
  const regular = multiplyRateByHours(hourlyRateCents, hours.regular);
  const overtimeRate = hours.overtime > 0
    ? multiplyCents(hourlyRateCents, rules.overtimeMultiplier)
    : null;
  const nightRate = hours.night > 0
    ? multiplyCents(hourlyRateCents, rules.nightMultiplier)
    : null;
  const weekendRate = hours.weekend > 0
    ? multiplyCents(hourlyRateCents, rules.weekendMultiplier)
    : null;
  const standbyRate = hours.standby > 0 ? rules.standbyHourlyCents : null;
  const overtime = hours.overtime > 0 ? multiplyRateByHours(overtimeRate, hours.overtime) : 0;
  const night = hours.night > 0 ? multiplyRateByHours(nightRate, hours.night) : 0;
  const weekend = hours.weekend > 0 ? multiplyRateByHours(weekendRate, hours.weekend) : 0;
  const standby = hours.standby > 0 ? multiplyRateByHours(standbyRate, hours.standby) : 0;
  if ([regular, overtime, night, weekend, standby].some((value) => value == null)) return null;

  return [
    { kind: "regular", hours: hours.regular, rateCents: hourlyRateCents, amountCents: regular },
    {
      kind: "overtime",
      hours: hours.overtime,
      rateCents: overtimeRate,
      amountCents: overtime,
    },
    {
      kind: "night",
      hours: hours.night,
      rateCents: nightRate,
      amountCents: night,
    },
    {
      kind: "weekend",
      hours: hours.weekend,
      rateCents: weekendRate,
      amountCents: weekend,
    },
    {
      kind: "standby",
      hours: hours.standby,
      rateCents: standbyRate,
      amountCents: standby,
    },
  ];
}

function buildRaise(hourlyRateCents, raise, rules) {
  if (raise.raisePercent == null) return null;
  const raisedHourly = hourlyRateCents + percentOfCents(hourlyRateCents, raise.raisePercent);
  const currentAnnual = annualSalaryCents(hourlyRateCents, rules);
  const newAnnual = annualSalaryCents(raisedHourly, rules);
  const annualDeltaCents = newAnnual - currentAnnual;
  return {
    percent: raise.raisePercent,
    unpaidPayPeriods: raise.unpaidPayPeriods,
    newHourlyRateCents: raisedHourly,
    currentAnnualSalaryCents: currentAnnual,
    newAnnualSalaryCents: newAnnual,
    annualDeltaCents,
    perCheckDeltaCents: Math.round(annualDeltaCents / rules.checksPerYear),
    retroCents: Math.round((annualDeltaCents * raise.unpaidPayPeriods) / rules.checksPerYear),
  };
}

export function calculatePay({ actor, catalog, organizationId, input = {}, rules }) {
  const auth = authorizePay({ actor, organizationId, capability: "calculate" });
  if (!auth.ok) return auth;
  if (!input || typeof input !== "object") return payFailure("invalid_input");

  const mergedRules = mergeCalculationRules(rules ?? input.rules);
  if (!mergedRules) return payFailure("invalid_input", { field: "rules" });

  const hours = normalizeHours(input.hours);
  if (!hours) return payFailure("invalid_input", { field: "hours" });

  const raise = normalizeRaise(input);
  if (!raise) return payFailure("invalid_input", { field: "raise" });

  const missingRules = missingCalculationRuleFields(
    mergedRules,
    requiredCalculationRuleFields(hours, raise),
  );
  if (missingRules.length > 0) {
    return payFailure("calculation_rules_unset", { fields: missingRules });
  }

  const amountPaidCents = input.amountPaidCents != null
    ? (Number.isInteger(input.amountPaidCents) ? input.amountPaidCents : null)
    : input.amountPaid != null
      ? dollarsToCents(input.amountPaid)
      : null;
  if ((input.amountPaidCents != null || input.amountPaid != null) && !Number.isInteger(amountPaidCents)) {
    return payFailure("invalid_input", { field: "amountPaid" });
  }
  if (amountPaidCents != null && (amountPaidCents < 0 || amountPaidCents > 50_000_000_00)) {
    return payFailure("invalid_input", { field: "amountPaid" });
  }

  const rate = resolveHourlyRate({ input, catalog, organizationId });
  if (!rate) return payFailure("invalid_input", { field: "rate" });
  if (rate.calculationDateRequired) {
    return payFailure("calculation_date_required", { field: "effectiveOn" });
  }
  if (rate.missing) return payFailure("scale_not_found");

  const components = buildComponents(rate.hourlyRateCents, hours, mergedRules);
  if (!components) return payFailure("invalid_input", { field: "hours" });

  const grossOwedCents = components.reduce((sum, row) => sum + row.amountCents, 0);
  const underpaymentCents = amountPaidCents == null
    ? 0
    : Math.max(0, grossOwedCents - amountPaidCents);
  const raiseResult = buildRaise(rate.hourlyRateCents, raise, mergedRules);
  const retroCents = raiseResult?.retroCents ?? 0;
  const backPayCents = underpaymentCents + retroCents;

  return {
    ok: true,
    organizationId,
    rate: {
      ...rate,
      annualSalaryCents: annualSalaryCents(rate.hourlyRateCents, mergedRules),
    },
    rules: mergedRules,
    hours,
    components,
    grossOwedCents,
    amountPaidCents,
    underpaymentCents,
    raise: raiseResult,
    backPayCents,
  };
}
