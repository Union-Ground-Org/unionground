// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001
//
// Page-aware quick help and "Ask Compass about this case" (old
// de7df4b57c^ lib/claude/quick-ask.ts and components/claude/contextual-ai-card.tsx).
// The page keys must equal COMPASS_PAGE_LABELS in api/_lib/compassPrompts.js
// and the case question keys CASE_HELP_QUESTIONS there; the server ignores any
// other value. These helpers only keep controls honest: the server enforces
// every switch.
import { isFeatureEnabled } from "../../lib/featureSwitches.js";

export const COMPASS_PAGE_KEYS = Object.freeze([
  "today", "voting", "voice", "qa", "pay", "messages",
  "numbers", "cases", "rights", "memberSupport", "events", "appointments", "accessHistory",
  "settings", "workload", "forms", "rewards", "search", "orgStructure",
  "steward", "coordinator", "advisor", "admin", "vp",
]);

export const CASE_HELP_KEYS = Object.freeze(["next", "prepare", "rights"]);

function assistantOn(configuration) {
  return Boolean(configuration && typeof configuration === "object")
    && isFeatureEnabled(configuration, "features.ai_assistant.enabled", true);
}

export function pageAwareHelpEnabled(configuration) {
  return assistantOn(configuration) && isFeatureEnabled(configuration, "features.ai_assistant.page_aware_help", false);
}

export function caseHelpEnabled(configuration) {
  return assistantOn(configuration) && isFeatureEnabled(configuration, "features.ai_assistant.case_help", false);
}

export function caseHelpIncludesNarrative(configuration) {
  return isFeatureEnabled(configuration, "features.ai_assistant.case_context_includes_narrative", false);
}
