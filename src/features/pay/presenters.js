import { formatUsdFromCents } from "./money.js";

export const PAY_VIEW_STATES = Object.freeze([
  "empty",
  "loading",
  "success",
  "validation",
  "unauthorized",
  "wrong_organization",
  "retry",
]);

const DISCLAIMER = "Estimates use the selected organization's published scale or the rates you entered. They are not payroll, legal advice, or a stored workplace issue.";

function failureState(result) {
  if (result.reason === "catalog_unavailable") return "retry";
  if (result.reason === "wrong_organization") return "wrong_organization";
  if (["invalid_input", "calculation_date_required", "calculation_rules_unset"].includes(result.reason)) {
    return "validation";
  }
  if (result.reason === "empty_organization" || result.reason === "catalog_empty" || result.reason === "scale_not_found") {
    return "empty";
  }
  return "unauthorized";
}

export function presentLoading(title) {
  return {
    state: "loading",
    title,
    message: "Loading pay tools.",
    disclaimer: DISCLAIMER,
  };
}

export function presentRetry(title) {
  return {
    state: "retry",
    title,
    message: "The pay catalog could not be reached. Try again.",
    disclaimer: DISCLAIMER,
  };
}

export function presentCalculation(result) {
  if (!result?.ok) {
    return {
      state: failureState(result ?? { reason: "invalid_input" }),
      reason: result?.reason ?? "invalid_input",
      details: result?.details ?? null,
      title: "Wage and back-pay calculator",
      message: presentFailureMessage(result),
      disclaimer: DISCLAIMER,
    };
  }

  const cards = result.components
    .filter((row) => row.hours > 0 || row.kind === "regular")
    .map((row) => ({
      kind: row.kind,
      hours: row.hours,
      rate: formatUsdFromCents(row.rateCents),
      amount: formatUsdFromCents(row.amountCents),
    }));

  return {
    state: "success",
    title: "Wage and back-pay calculator",
    rate: {
      source: result.rate.source,
      grade: result.rate.grade,
      stepNumber: result.rate.stepNumber,
      effectiveOn: result.rate.effectiveOn,
      hourly: formatUsdFromCents(result.rate.hourlyRateCents),
      annual: result.rate.annualSalaryCents == null
        ? null
        : formatUsdFromCents(result.rate.annualSalaryCents),
    },
    cards,
    grossOwed: formatUsdFromCents(result.grossOwedCents),
    amountPaid: result.amountPaidCents == null ? null : formatUsdFromCents(result.amountPaidCents),
    underpayment: formatUsdFromCents(result.underpaymentCents),
    raise: result.raise
      ? {
        percent: result.raise.percent,
        nowAnnual: formatUsdFromCents(result.raise.currentAnnualSalaryCents),
        newAnnual: formatUsdFromCents(result.raise.newAnnualSalaryCents),
        annualDelta: formatUsdFromCents(result.raise.annualDeltaCents),
        perCheckDelta: formatUsdFromCents(result.raise.perCheckDeltaCents),
        retro: formatUsdFromCents(result.raise.retroCents),
        unpaidPayPeriods: result.raise.unpaidPayPeriods,
      }
      : null,
    backPay: formatUsdFromCents(result.backPayCents),
    disclaimer: DISCLAIMER,
  };
}

export function presentComparison(result) {
  if (!result?.ok) {
    return {
      state: failureState(result ?? { reason: "invalid_input" }),
      reason: result?.reason ?? "invalid_input",
      details: result?.details ?? null,
      title: "Pay-scale comparison",
      message: presentFailureMessage(result),
      disclaimer: DISCLAIMER,
    };
  }

  return {
    state: "success",
    title: "Pay-scale comparison",
    left: {
      grade: result.left.grade,
      stepNumber: result.left.stepNumber,
      effectiveOn: result.left.effectiveOn,
      hourly: formatUsdFromCents(result.left.hourlyRateCents),
      annual: formatUsdFromCents(result.left.annualSalaryCents),
    },
    right: {
      grade: result.right.grade,
      stepNumber: result.right.stepNumber,
      effectiveOn: result.right.effectiveOn,
      hourly: formatUsdFromCents(result.right.hourlyRateCents),
      annual: formatUsdFromCents(result.right.annualSalaryCents),
    },
    hourlyDelta: formatUsdFromCents(result.hourlyDeltaCents),
    annualDelta: formatUsdFromCents(result.annualDeltaCents),
    perCheckDelta: formatUsdFromCents(result.perCheckDeltaCents),
    percentChange: result.percentChange,
    disclaimer: DISCLAIMER,
  };
}

export function presentCatalog(result) {
  if (!result?.ok) {
    return {
      state: failureState(result ?? { reason: "invalid_input" }),
      reason: result?.reason ?? "invalid_input",
      details: result?.details ?? null,
      title: "Pay-scale tables",
      message: presentFailureMessage(result),
      rows: [],
      disclaimer: DISCLAIMER,
    };
  }
  if (result.empty) {
    return {
      state: "empty",
      title: "Pay-scale tables",
      message: "This organization has not added its contract pay rates yet. Until it does, you can enter a rate yourself in the calculator.",
      rows: [],
      disclaimer: DISCLAIMER,
    };
  }
  return {
    state: "success",
    title: "Pay-scale tables",
    rows: result.steps.map((step) => ({
      grade: step.grade,
      stepNumber: step.stepNumber,
      effectiveOn: step.effectiveOn,
      hourly: formatUsdFromCents(step.hourlyRateCents),
      annual: step.annualSalaryCents == null ? null : formatUsdFromCents(step.annualSalaryCents),
    })),
    grades: result.grades,
    disclaimer: DISCLAIMER,
  };
}

function presentFailureMessage(result) {
  switch (result?.reason) {
    case "empty_organization":
      return "No organization is selected. Zero organizations is a valid launch state.";
    case "wrong_organization":
      return "Pay records stay inside the selected organization.";
    case "membership_inactive":
    case "missing_actor":
    case "unauthorized":
      return "This pay tool is available only to an active worker in this organization.";
    case "scale_not_found":
      return "No published rate matches those inputs for the selected organization.";
    case "catalog_empty":
      return "This organization has no published pay scale yet.";
    case "catalog_unavailable":
      return "The pay catalog could not be reached. Try again.";
    case "calculation_date_required":
      return "Enter a calculation date when using a published grade and step.";
    case "calculation_rules_unset":
      return "Enter the pay rules your workplace uses for this estimate.";
    case "invalid_input":
      return "Check the hours, rates, or grade and step inputs.";
    default:
      return "The pay tool could not complete that request.";
  }
}
