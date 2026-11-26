// REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001
//
// Role-specific Compass suggested questions that organization admins edit on
// the Feature switches & limits page (migration 20261003054000). The old app
// (de7df4b57c^ components/claude/suggested-questions.tsx) showed the
// organization's list when one was set and the role default otherwise; the
// defaults below are its lists verbatim and must stay identical to the
// migration defaults and to compass.suggested.* in src/lib/i18n/compassAssistant.js.
//
// A suggestion only fills the composer. The person reviews and sends it, and
// /api/guide governs it exactly like typed text.
import { featureTextList, isFeatureEnabled } from "../../lib/featureSwitches.js";

export const SUGGESTED_QUESTIONS_SWITCH = "features.ai_assistant.suggested_questions";

export const SUGGESTED_QUESTION_LIST_KEYS = Object.freeze({
  member: "lists.ai_assistant.suggested_questions_member",
  steward: "lists.ai_assistant.suggested_questions_steward",
  admin: "lists.ai_assistant.suggested_questions_admin",
});

export const SUGGESTED_QUESTION_LIMIT = 8;

export const DEFAULT_SUGGESTED_QUESTIONS = Object.freeze({
  member: Object.freeze([
    "What are my organizing rights if I'm called into a meeting with a manager?",
    "How do I raise an issue?",
    "What can we ask for in a first contract?",
    "What should I do if I get a disciplinary notice?",
    "How do I talk with coworkers about organizing?",
    "How do I find my committee contact?",
  ]),
  steward: Object.freeze([
    "How many issues are open and how many are resolved?",
    "Show me worker stats by unit",
    "Which issues come up most often?",
    "How is org health trending across departments?",
    "Walk me through the steps to file for a union election",
  ]),
  admin: Object.freeze([
    "How's org health trending?",
    "Show me engagement trends for the last 6 months",
    "Which issues come up most across campaigns?",
    "How many workers are in each unit?",
    "How does the union election process work?",
  ]),
});

// The old app had member, steward and admin lists only. Coordinators and
// advisors work cases like stewards; vice presidents oversee like admins.
export function suggestedQuestionRole(hat) {
  if (hat === "admin" || hat === "vp") return "admin";
  if (hat === "steward" || hat === "coordinator" || hat === "advisor") return "steward";
  return "member";
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// Returns the suggestions for the selected hat, or null when no organization
// configuration is available (the caller keeps its built-in starters, as the
// demo and a failed configuration read do). An organization that left a list
// at the product default sees it in the reader's language; an edited list is
// shown exactly as the admin wrote it.
export function suggestedQuestionsFor(configuration, hat, t) {
  if (!configuration || typeof configuration !== "object") return null;
  if (!isFeatureEnabled(configuration, SUGGESTED_QUESTIONS_SWITCH, true)) return [];
  const role = suggestedQuestionRole(hat);
  const defaults = DEFAULT_SUGGESTED_QUESTIONS[role];
  const list = featureTextList(configuration, SUGGESTED_QUESTION_LIST_KEYS[role], defaults)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, SUGGESTED_QUESTION_LIMIT);
  if (typeof t === "function" && sameList(list, defaults)) {
    return defaults.map((question, index) => {
      const translated = t(`compass.suggested.${role}.${index + 1}`);
      return typeof translated === "string" && translated && !translated.startsWith("compass.") ? translated : question;
    });
  }
  return list;
}
