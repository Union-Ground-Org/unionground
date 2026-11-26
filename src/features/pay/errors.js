export const PAY_FAILURE_REASONS = Object.freeze([
  "missing_actor",
  "empty_organization",
  "wrong_organization",
  "membership_inactive",
  "unauthorized",
  "invalid_input",
  "calculation_date_required",
  "calculation_rules_unset",
  "scale_not_found",
  "catalog_empty",
  "catalog_unavailable",
]);

export function payFailure(reason, details = null) {
  const result = { ok: false, reason };
  if (details && typeof details === "object") {
    result.details = details;
  }
  return result;
}

export function isPayFailureReason(reason) {
  return PAY_FAILURE_REASONS.includes(reason);
}
