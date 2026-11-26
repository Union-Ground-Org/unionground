// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
// ( THE NATIVE APP READS THE WEB SURVEYS): the one
// survey model both apps render. These are the pure decisions the web member
// surface (MemberEngagement.jsx) always made inline: how an option is read,
// which questions a branch answer reveals, which answers a submit still
// needs, and what state a member's session is in. The native app imports
// this file through apps/mobile/src/lib/memberSurveysShared.ts, so a change
// here is a change on both surfaces. The database (private.mi1_w2_upsert_
// survey_session) remains the authority on submit; these mirror its rules so
// the client can refuse an incomplete submit before the round trip.
// The database's text bounds (private.mi1_w2_upsert_survey_session) and the
// default 1–5 scale it applies when an author leaves the list empty.
export const SURVEY_TEXT_LIMITS = Object.freeze({ text: 500, paragraph: 4000 });
const SURVEY_DEFAULT_SCALE = Object.freeze([1, 2, 3, 4, 5]);

export function optionValue(option) {
  return typeof option === "object" && option !== null ? option.value ?? option.label : option;
}

export function optionLabel(option) {
  return typeof option === "object" && option !== null ? option.label ?? option.value : option;
}

function branchMatches(question, parentAnswer) {
  return Array.isArray(parentAnswer)
    ? parentAnswer.some((value) => String(value) === String(question.branchValue ?? ""))
    : String(parentAnswer ?? "") === String(question.branchValue ?? "");
}

// A branched question is visible when its parent is itself visible AND the
// parent's answer carries the branch value; an array answer (checkbox)
// matches when any selection does. Visibility follows the whole ancestor
// chain, so hiding q1 hides q2 and every question branched from q2, even
// while their retained answers still match (review thread on).
export function visibleQuestions(survey, answers = {}) {
  const questions = survey?.questions || [];
  const byId = new Map(questions.map((question) => [String(question.id), question]));
  const memo = new Map();
  function visible(question, trail = new Set()) {
    const key = String(question.id);
    if (memo.has(key)) return memo.get(key);
    if (trail.has(key)) return false;
    let result = true;
    if (question.branchParentId) {
      const parent = byId.get(String(question.branchParentId));
      trail.add(key);
      // A parent outside the question list cannot be hidden by this survey,
      // so only the answer decides (the database's own rule for that case).
      result = (!parent || visible(parent, trail)) && branchMatches(question, answers[question.branchParentId]);
    }
    memo.set(key, result);
    return result;
  }
  return questions.filter((question) => visible(question));
}

// Drops the answers of every question the current answers hide, so an
// orphaned descendant is never saved, submitted or counted as required. The
// database applies the same rule per parent; pruning first keeps the two in
// step when an ancestor changes.
export function pruneHiddenAnswers(survey, answers = {}) {
  const visible = new Set(visibleQuestions(survey, answers).map((question) => String(question.id)));
  const known = new Set((survey?.questions || []).map((question) => String(question.id)));
  const next = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (!known.has(String(questionId)) || visible.has(String(questionId))) next[questionId] = value;
  }
  return next;
}

// The choices a single- or multiple-choice question offers, including the
// defaults the database applies when an author left the list empty: Yes/No
// for yes_no and 1–5 for scale and rating.
export function surveyChoices(question, labels = { yes: "Yes", no: "No" }) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length) return options.map((option) => ({ value: optionValue(option), label: optionLabel(option) }));
  if (question?.type === "yes_no") return [{ value: "yes", label: labels.yes }, { value: "no", label: labels.no }];
  if (question?.type === "scale" || question?.type === "rating") {
    return SURVEY_DEFAULT_SCALE.map((value) => ({ value, label: String(value) }));
  }
  return [];
}

export function isAnswerEmpty(question, value) {
  if (value === undefined || value === null) return true;
  if (question?.type === "checkbox") return !Array.isArray(value) || value.length === 0;
  if (question?.type === "text" || question?.type === "paragraph") return String(value).trim() === "";
  return String(value) === "";
}

// Required, visible questions a submit would be refused for (the database
// raises 'required survey questions are missing' for the same set).
export function missingRequiredQuestions(survey, answers = {}) {
  return visibleQuestions(survey, answers).filter((question) => question.required && isAnswerEmpty(question, answers[question.id]));
}

// Applies one change to the answer map without leaving an empty key behind,
// so a cleared answer is absent rather than null when it reaches the server.
export function withAnswer(answers, questionId, value) {
  const next = { ...answers };
  if (value === undefined) delete next[questionId];
  else next[questionId] = value;
  return next;
}

// Toggles one checkbox selection under the question's maxSelections cap.
export function toggleSelection(question, current, value) {
  const selected = Array.isArray(current) ? current : [];
  const present = selected.some((item) => String(item) === String(value));
  if (present) return selected.filter((item) => String(item) !== String(value));
  if (question?.maxSelections && selected.length >= question.maxSelections) return selected;
  return [...selected, value];
}

export function surveySessionStatus(survey) {
  if (survey?.session?.status === "submitted") return "submitted";
  return survey?.session ? "in_progress" : "open";
}
