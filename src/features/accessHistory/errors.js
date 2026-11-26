export const ACCESS_FAILURE_REASONS = Object.freeze([
  "missing_actor",
  "empty_organization",
  "wrong_organization",
  "membership_inactive",
  "unauthorized",
  "invalid_input",
  "catalog_unavailable",
  "mfa_required",
]);

export function accessFailure(reason, details = null) {
  const result = { ok: false, reason };
  if (details && typeof details === "object") result.details = details;
  return result;
}
