import { authorizePay } from "./authorization.js";
import { payFailure } from "./errors.js";
import { dollarsToCents } from "./money.js";
import {
  isIsoDate,
  mergeCalculationRules,
  missingCalculationRuleFields,
  normalizeGrade,
  normalizeStepNumber,
} from "./rules.js";

function stepKey(step) {
  return `${step.organizationId}\0${step.grade}\0${step.stepNumber}\0${step.effectiveOn}`;
}

function gradeKey(grade) {
  return `${grade.organizationId}\0${grade.grade}`;
}

export function normalizePayScaleGrade(input) {
  if (!input || typeof input !== "object") return null;
  const organizationId = typeof input.organizationId === "string" ? input.organizationId : null;
  const grade = normalizeGrade(input.grade);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!organizationId || !grade || title.length < 1 || title.length > 120) return null;
  const stepCount = input.stepCount == null ? null : input.stepCount;
  if (stepCount != null && (!Number.isInteger(stepCount) || stepCount < 1 || stepCount > 99)) {
    return null;
  }
  return {
    organizationId,
    grade,
    title,
    jobFamily: typeof input.jobFamily === "string" ? input.jobFamily.slice(0, 80) : null,
    stepCount,
    description: typeof input.description === "string" ? input.description.slice(0, 400) : null,
  };
}

export function normalizePayScaleStep(input) {
  if (!input || typeof input !== "object") return null;
  const organizationId = typeof input.organizationId === "string" ? input.organizationId : null;
  const grade = normalizeGrade(input.grade);
  const stepNumber = normalizeStepNumber(input.stepNumber);
  const effectiveOn = isIsoDate(input.effectiveOn) ? input.effectiveOn : null;
  const hourlyRateCents = Number.isInteger(input.hourlyRateCents)
    ? input.hourlyRateCents
    : dollarsToCents(input.hourlyRate);
  if (!organizationId || !grade || !stepNumber || !effectiveOn) return null;
  if (!Number.isInteger(hourlyRateCents) || hourlyRateCents < 1 || hourlyRateCents > 100_000_00) {
    return null;
  }
  return {
    organizationId,
    grade,
    stepNumber,
    effectiveOn,
    hourlyRateCents,
  };
}

export function annualSalaryCents(hourlyRateCents, rules = null) {
  const merged = mergeCalculationRules(rules);
  if (!merged || !Number.isInteger(hourlyRateCents) || merged.hoursPerYear == null) return null;
  return hourlyRateCents * merged.hoursPerYear;
}

export function lookupPayRate(records, { organizationId, grade, stepNumber, effectiveOn }) {
  const normalizedGrade = normalizeGrade(grade);
  const normalizedStep = normalizeStepNumber(stepNumber);
  if (!organizationId || !normalizedGrade || !normalizedStep || !isIsoDate(effectiveOn)) return null;
  const asOf = isIsoDate(effectiveOn) ? effectiveOn : null;
  const matches = records.filter((row) => (
    row.organizationId === organizationId
    && row.grade === normalizedGrade
    && row.stepNumber === normalizedStep
    && (!asOf || row.effectiveOn <= asOf)
  ));
  if (matches.length === 0) return null;
  return matches.reduce((latest, row) => (row.effectiveOn > latest.effectiveOn ? row : latest));
}

export function queryPayScale({ actor, catalog, organizationId, filters = {} }) {
  const auth = authorizePay({ actor, organizationId, capability: "read_catalog" });
  if (!auth.ok) return auth;

  const grades = catalog.listGrades(organizationId);
  const steps = catalog.listSteps(organizationId);
  const gradeFilter = filters.grade ? normalizeGrade(filters.grade) : null;
  const stepFilter = filters.stepNumber != null ? normalizeStepNumber(filters.stepNumber) : null;
  const asOf = filters.effectiveOn && isIsoDate(filters.effectiveOn) ? filters.effectiveOn : null;
  const year = Number.isInteger(filters.effectiveYear) ? filters.effectiveYear : null;

  if (filters.grade && !gradeFilter) return payFailure("invalid_input", { field: "grade" });
  if (filters.stepNumber != null && !stepFilter) return payFailure("invalid_input", { field: "stepNumber" });
  if (filters.effectiveOn && !asOf) return payFailure("invalid_input", { field: "effectiveOn" });

  const visibleGrades = grades.filter((row) => (
    row.organizationId === organizationId
    && (!gradeFilter || row.grade === gradeFilter)
  ));
  const visibleSteps = steps.filter((row) => {
    if (row.organizationId !== organizationId) return false;
    if (gradeFilter && row.grade !== gradeFilter) return false;
    if (stepFilter && row.stepNumber !== stepFilter) return false;
    if (asOf && row.effectiveOn > asOf) return false;
    if (year && !row.effectiveOn.startsWith(`${year}-`)) return false;
    return true;
  });

  return {
    ok: true,
    organizationId,
    grades: visibleGrades,
    steps: visibleSteps.map((step) => ({
      ...step,
      annualSalaryCents: annualSalaryCents(step.hourlyRateCents, filters.rules),
    })),
    empty: visibleSteps.length === 0,
  };
}

export function comparePayScaleRecords({ actor, catalog, organizationId, left, right, rules }) {
  const auth = authorizePay({ actor, organizationId, capability: "compare" });
  if (!auth.ok) return auth;

  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return payFailure("invalid_input", { field: "comparison" });
  }
  const missingDates = [
    !left.effectiveOn ? "left.effectiveOn" : null,
    !right.effectiveOn ? "right.effectiveOn" : null,
  ].filter(Boolean);
  if (missingDates.length > 0) {
    return payFailure("calculation_date_required", { fields: missingDates });
  }
  const invalidDates = [
    !isIsoDate(left.effectiveOn) ? "left.effectiveOn" : null,
    !isIsoDate(right.effectiveOn) ? "right.effectiveOn" : null,
  ].filter(Boolean);
  if (invalidDates.length > 0) {
    return payFailure("invalid_input", { fields: invalidDates });
  }
  const invalidSelections = [
    !normalizeGrade(left.grade) ? "left.grade" : null,
    !normalizeStepNumber(left.stepNumber) ? "left.stepNumber" : null,
    !normalizeGrade(right.grade) ? "right.grade" : null,
    !normalizeStepNumber(right.stepNumber) ? "right.stepNumber" : null,
  ].filter(Boolean);
  if (invalidSelections.length > 0) {
    return payFailure("invalid_input", { fields: invalidSelections });
  }
  if (!catalog || typeof catalog.listSteps !== "function") {
    return payFailure("invalid_input", { field: "catalog" });
  }

  const steps = catalog.listSteps(organizationId);
  const leftRow = lookupPayRate(steps, { organizationId, ...left });
  const rightRow = lookupPayRate(steps, { organizationId, ...right });
  if (!leftRow || !rightRow) {
    return payFailure("scale_not_found", {
      leftFound: Boolean(leftRow),
      rightFound: Boolean(rightRow),
    });
  }

  const merged = mergeCalculationRules(rules);
  if (!merged) return payFailure("invalid_input", { field: "rules" });
  const missingRules = missingCalculationRuleFields(merged, ["hoursPerYear", "checksPerYear"]);
  if (missingRules.length > 0) {
    return payFailure("calculation_rules_unset", { fields: missingRules });
  }

  const leftAnnual = annualSalaryCents(leftRow.hourlyRateCents, merged);
  const rightAnnual = annualSalaryCents(rightRow.hourlyRateCents, merged);
  const hourlyDeltaCents = rightRow.hourlyRateCents - leftRow.hourlyRateCents;
  const annualDeltaCents = rightAnnual - leftAnnual;
  const percentChange = leftRow.hourlyRateCents === 0
    ? null
    : (hourlyDeltaCents * 10000) / leftRow.hourlyRateCents / 100;

  return {
    ok: true,
    organizationId,
    left: { ...leftRow, annualSalaryCents: leftAnnual },
    right: { ...rightRow, annualSalaryCents: rightAnnual },
    hourlyDeltaCents,
    annualDeltaCents,
    percentChange,
    perCheckDeltaCents: Math.round(annualDeltaCents / merged.checksPerYear),
  };
}

export function compareCatalogYearOverYear({
  actor,
  catalog,
  organizationId,
  grade,
  stepNumber,
  fromYear,
  toYear,
  rules,
}) {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear)) {
    return payFailure("invalid_input", { field: "year" });
  }
  return comparePayScaleRecords({
    actor,
    catalog,
    organizationId,
    left: { grade, stepNumber, effectiveOn: `${fromYear}-12-31` },
    right: { grade, stepNumber, effectiveOn: `${toYear}-12-31` },
    rules,
  });
}

export { gradeKey, stepKey };
