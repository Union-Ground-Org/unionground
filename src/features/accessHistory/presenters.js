import { t } from "../../lib/i18n.js";

export const ACCESS_VIEW_STATES = Object.freeze([
  "empty",
  "loading",
  "success",
  "unauthorized",
  "wrong_organization",
  "retry",
  "mfa_required",
]);

const ACTION_KEYS = Object.freeze({
  viewed_profile: "accessHistory.action.viewed_profile",
  viewed_case: "accessHistory.action.viewed_case",
  updated_profile: "accessHistory.action.updated_profile",
  updated_case: "accessHistory.action.updated_case",
  granted_role: "accessHistory.action.granted_role",
  revoked_role: "accessHistory.action.revoked_role",
});

// BUG-UG-HOME-AND-TOP-BAR-CALL-OFFICERS-MEMBER-20261006: a role change
// the caller made themselves reads as their own action, not "Renata gave you".
const SELF_ACTION_KEYS = Object.freeze({
  granted_role: "accessHistory.action.granted_role_self",
  revoked_role: "accessHistory.action.revoked_role_self",
});

function eventLabel(lang, event) {
  if (event.actorIsSelf && SELF_ACTION_KEYS[event.action]) return copy(lang, SELF_ACTION_KEYS[event.action]);
  return `${event.actorLabel} ${ACTION_KEYS[event.action] ? copy(lang, ACTION_KEYS[event.action]) : event.action}`;
}

const FAILURE_KEYS = Object.freeze({
  empty_organization: "accessHistory.failure.empty_organization",
  wrong_organization: "accessHistory.failure.wrong_organization",
  membership_inactive: "accessHistory.failure.membership_inactive",
  unauthorized: "accessHistory.failure.unauthorized",
  catalog_unavailable: "accessHistory.failure.catalog_unavailable",
  mfa_required: "accessHistory.mfaRequired",
});

// The empty sentence names the range the reader chose, so it never says
// "in this window" above the buttons it depends on (#9529).
const EMPTY_RANGE_KEYS = Object.freeze({
  30: "accessHistory.emptyRange.30",
  90: "accessHistory.emptyRange.90",
  365: "accessHistory.emptyRange.365",
});

function copy(lang, key, vars) {
  return t(lang, key, vars);
}

function failureState(result) {
  if (result?.reason === "catalog_unavailable") return "retry";
  if (result?.reason === "mfa_required") return "mfa_required";
  if (result?.reason === "wrong_organization") return "wrong_organization";
  if (result?.reason === "empty_organization") return "empty";
  return "unauthorized";
}

export function presentLoading(lang = "en") {
  return {
    state: "loading",
    title: copy(lang, "accessHistory.title"),
    message: copy(lang, "accessHistory.loading"),
    disclaimer: copy(lang, "accessHistory.disclaimer"),
    events: [],
  };
}

export function presentRetry(lang = "en") {
  return {
    state: "retry",
    title: copy(lang, "accessHistory.title"),
    message: copy(lang, "accessHistory.retry"),
    disclaimer: copy(lang, "accessHistory.disclaimer"),
    events: [],
  };
}

export function presentMfaRequired(lang = "en") {
  return {
    state: "mfa_required",
    title: copy(lang, "accessHistory.title"),
    message: copy(lang, "accessHistory.mfaRequired"),
    disclaimer: copy(lang, "accessHistory.disclaimer"),
    events: [],
  };
}

export function presentFailureMessage(result, lang = "en") {
  return copy(lang, FAILURE_KEYS[result?.reason] || "accessHistory.failure.unavailable");
}

export function presentAccessHistory(result, lang = "en") {
  if (!result?.ok) {
    const failed = {
      state: failureState(result),
      reason: result?.reason ?? "unauthorized",
      title: copy(lang, "accessHistory.title"),
      message: presentFailureMessage(result, lang),
      disclaimer: copy(lang, "accessHistory.disclaimer"),
      events: [],
    };
    if (result?.details) failed.details = result.details;
    return failed;
  }
  if (!result.events.length) {
    return {
      state: "empty",
      title: copy(lang, "accessHistory.title"),
      message: copy(lang, EMPTY_RANGE_KEYS[result.rangeDays] || "accessHistory.empty"),
      disclaimer: copy(lang, "accessHistory.disclaimer"),
      events: [],
      rangeDays: result.rangeDays,
    };
  }
  const count = result.events.length;
  return {
    state: "success",
    title: copy(lang, "accessHistory.title"),
    message: copy(lang, count === 1 ? "accessHistory.count.one" : "accessHistory.count.many", { count }),
    disclaimer: copy(lang, "accessHistory.disclaimer"),
    rangeDays: result.rangeDays,
    events: result.events.map((event) => ({
      ...event,
      label: eventLabel(lang, event),
    })),
  };
}
