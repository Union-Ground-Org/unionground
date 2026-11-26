import { t } from "../../lib/i18n.js";

// The condition values this surface can name. The label itself lives in the
// catalogue (automation.condition.<value>) so neither locale is chosen here.
const CONDITIONS = new Set([
  "backlog", "to_do", "in_progress", "needs_review",
  "active", "missed", "confirmed", "completed", "no_show",
  "filing", "response", "hearing", "appeal", "follow_up",
  "low", "medium", "high",
  "assigned", "unassigned",
]);

export function automationConditionLabel(value, lang) {
  return CONDITIONS.has(value)
    ? t(lang, `automation.condition.${value}`)
    : t(lang, "automation.conditionUnavailable");
}
