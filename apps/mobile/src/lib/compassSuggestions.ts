// REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001, native half.
//
// The phone Guide panel is the worker assistant (staff data answers are a
// web staff surface), so it shows the organization's worker list. The
// defaults are organizing starters rather than the old app's member questions
// (de7df4b57c^ components/claude/suggested-questions.tsx:5-12): this campaign
// has no steward or grievance procedure to ask about. They are the web's
// worker list (src/features/compass/suggestedQuestions.js
// DEFAULT_SUGGESTED_QUESTIONS.member), word for word and in order; a test pins
// the two together. A suggestion only fills the composer.
import { featureTextList, isFeatureEnabled, type OrganizationSwitchConfiguration } from './featureSwitches';

export const SUGGESTED_QUESTIONS_SWITCH = 'features.ai_assistant.suggested_questions';
export const MEMBER_SUGGESTED_QUESTIONS_KEY = 'lists.ai_assistant.suggested_questions_member';
export const SUGGESTED_QUESTION_LIMIT = 8;

export const DEFAULT_MEMBER_SUGGESTED_QUESTIONS: readonly string[] = Object.freeze([
  "What are my organizing rights if I'm called into a meeting with a manager?",
  'How do I raise an issue?',
  'What can we ask for in a first contract?',
  'What should I do if I get a disciplinary notice?',
  'How do I talk with coworkers about organizing?',
  'How do I find my committee contact?',
]);

// Preview and a configuration that has not loaded keep the panel's built-in
// starters (each one carries a keyword the preview knowledge answers).
export const BUILT_IN_COMPASS_SUGGESTIONS: readonly string[] = Object.freeze([
  'Can I talk with coworkers about organizing on my break?',
  'What should I write down if a manager asks about the campaign?',
  'How do we keep our list of names private?',
]);

export function memberSuggestedQuestions(configuration: OrganizationSwitchConfiguration): string[] {
  if (!configuration || typeof configuration !== 'object') return [...BUILT_IN_COMPASS_SUGGESTIONS];
  if (!isFeatureEnabled(configuration, SUGGESTED_QUESTIONS_SWITCH, true)) return [];
  return featureTextList(configuration, MEMBER_SUGGESTED_QUESTIONS_KEY, [...DEFAULT_MEMBER_SUGGESTED_QUESTIONS])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, SUGGESTED_QUESTION_LIMIT);
}

/** Drop scoped payloads immediately on a tenant change, before effects reload. */
export function scopedCompassValue<T>(loadedScope: string | null, currentScope: string, loaded: T, fallback: T): T {
  return loadedScope === currentScope ? loaded : fallback;
}
