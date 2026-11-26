import { MAX_CONVERTIBLE_DOLLARS } from "./money.js";
import {
  MAX_ANNUAL_HOURS, MAX_HOURS, MAX_PAYCHECKS_PER_YEAR, MAX_RAISE_PERCENT,
  MAX_RATE_MULTIPLIER, MAX_STANDBY_HOURLY_CENTS, MAX_UNPAID_PERIODS,
  mergeCalculationRules, normalizeGrade, normalizeHours, normalizeRaise, normalizeStepNumber,
} from "./rules.js";

const FIELD_MESSAGES = {
  amountPaid: ["pay.inputAmountPaid", MAX_CONVERTIBLE_DOLLARS],
  grade: ["pay.inputGrade"],
  stepNumber: ["pay.inputStep"],
  effectiveOn: ["pay.inputDate"],
  overtimeMultiplier: ["pay.inputMultiplier", MAX_RATE_MULTIPLIER],
  nightMultiplier: ["pay.inputMultiplier", MAX_RATE_MULTIPLIER],
  weekendMultiplier: ["pay.inputMultiplier", MAX_RATE_MULTIPLIER],
  standbyHourlyCents: ["pay.inputStandbyRate", MAX_STANDBY_HOURLY_CENTS / 100],
  hoursPerYear: ["pay.inputAnnualHours", MAX_ANNUAL_HOURS],
  checksPerYear: ["pay.inputChecks", MAX_PAYCHECKS_PER_YEAR],
};

// Describe the existing result. The calculation still makes every decision
// about what it accepts. A group error can use the same normalizer to locate
// the individual inputs that made the group invalid.
export function withPayInputFeedback(presentation, rules, input = null) {
  const fieldFeedback = payInputFeedback(presentation, rules, input);
  return Object.keys(fieldFeedback).length ? { ...presentation, fieldFeedback } : presentation;
}

function payInputFeedback(presentation, rules, input) {
  const { reason, details } = presentation;
  const field = details?.field;
  switch (reason) {
    case "calculation_rules_unset":
      return Object.fromEntries(details.fields.map((key) => [key, ["pay.inputContractRule"]]));
    case "calculation_date_required":
      return Object.fromEntries((details.fields || [field]).map((key) => [key, FIELD_MESSAGES.effectiveOn]));
    case "invalid_input":
      break;
    case "scale_not_found":
      // A calculator lookup can lack a valid grade or step, or simply have no
      // matching published rate. The latter is already explained in the result.
      if (!input || input.hourlyRate !== undefined) return {};
      return incompleteRateSelection(input);
    default:
      return {};
  }

  if (field === "hours" && input) {
    return Object.fromEntries(Object.entries(input.hours)
      .filter(([bucket, value]) => !normalizeHours({ [bucket]: value }))
      .map(([bucket]) => [bucket, ["pay.inputHours", MAX_HOURS]]));
  }
  if (field === "raise" && input) {
    if (input.raisePercent === undefined) return { raisePercent: ["pay.inputRaiseRequired"] };
    if (!normalizeRaise({ raisePercent: input.raisePercent })) {
      return { raisePercent: ["pay.inputRaise", MAX_RAISE_PERCENT] };
    }
    return { unpaidPayPeriods: ["pay.inputPeriods", MAX_UNPAID_PERIODS] };
  }
  if (field === "rate" && input) {
    if (input.hourlyRate !== undefined) return { hourlyRate: ["pay.inputHourlyRate"] };
    if (input.grade === undefined && input.stepNumber === undefined) return { hourlyRate: ["pay.inputRateRequired"] };
    return incompleteRateSelection(input);
  }
  const fields = field === "rules"
    ? Object.keys(rules).filter((key) => !mergeCalculationRules({ [key]: rules[key] }))
    : details?.fields || [field];
  return Object.fromEntries(fields.flatMap((key) => {
    const fieldName = key?.split(".").at(-1);
    if (!Object.hasOwn(FIELD_MESSAGES, fieldName)) return [];
    return [[key, FIELD_MESSAGES[fieldName]]];
  }));
}

function incompleteRateSelection({ grade, stepNumber }) {
  return {
    ...(!normalizeGrade(grade) && { grade: FIELD_MESSAGES.grade }),
    ...(!normalizeStepNumber(stepNumber) && { stepNumber: FIELD_MESSAGES.stepNumber }),
  };
}
