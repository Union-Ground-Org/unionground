export const CALENDAR_FREEBUSY_FAILURE_REASONS = Object.freeze([
  "activation_unset",
  "unauthorized",
  "missing_actor",
  "empty_organization",
  "wrong_organization",
  "invalid_input",
  "unknown_provider",
  "provider_error",
  "catalog_unavailable",
]);

export function calendarFreeBusyFailure(reason, details = null) {
  return {
    ok: false,
    reason: CALENDAR_FREEBUSY_FAILURE_REASONS.includes(reason) ? reason : "invalid_input",
    details,
  };
}

export function isCalendarFreeBusyFailureReason(reason) {
  return CALENDAR_FREEBUSY_FAILURE_REASONS.includes(reason);
}
