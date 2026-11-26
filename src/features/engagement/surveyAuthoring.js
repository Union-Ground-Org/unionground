// BUG-UG-SURVEY-CHOICE-QUESTIONS-NOT-SAVED-20261030: the staff survey
// builder's authoring rules. The "Options, one per line" box used to re-parse
// its text on every keystroke, so a typed line break or trailing space was
// trimmed away before the next character arrived ("Yes", "No", "Not sure"
// became one "YesNoNotsure" option) and save_organization_survey_draft
// refused the single-option choice question with HTTP 400. The editor now
// keeps the raw text and parses it here. The bounds below mirror
// private.mi1_w2_replace_survey_questions and save_organization_survey_draft
// (supabase/migrations/20260828220000_mi1_voice_survey_completion.sql), which
// stay the authority; checking them first lets a failed save name the
// question, the field and the reason.
export const SURVEY_CHOICE_TYPES = Object.freeze(["radio", "checkbox", "dropdown"]);
export const SURVEY_AUTHORING_LIMITS = Object.freeze({
  titleMin: 3, titleMax: 200, descriptionMax: 4000,
  privacyMin: 3, privacyMax: 50,
  questionsMin: 1, questionsMax: 60,
  promptMax: 400,
  choiceOptionsMin: 2, optionsMax: 20, optionMax: 160,
});

// REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: the survey
// readers hold reports, exports, the worksite split and response review at
// greatest(25, the organization floor, the survey's own floor)
// (supabase/migrations/20261104095000_survey_report_floor_25_server_side.sql).
export const SURVEY_REPORT_MINIMUM = 25;

const L = SURVEY_AUTHORING_LIMITS;

// One option per line; surrounding spaces and blank lines are dropped, the
// spaces inside an option are kept.
export function parseSurveyOptionLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function surveyOptionLinesText(options) {
  return (options || []).map((option) => typeof option === "object" && option !== null ? option.label ?? option.value : option).join("\n");
}

// The database's own option reading: value or label, control characters as
// spaces, trimmed.
function storedOptionValue(option) {
  const raw = typeof option === "object" && option !== null ? option.value ?? option.label : option;
  return Array.from(String(raw ?? ""), (character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim();
}

function questionProblem(question, number, earlier) {
  const problem = (field, reason) => ({ question: number, field, reason });
  const type = question.type;
  const options = Array.isArray(question.options) ? question.options : [];
  const label = String(question.label ?? "").trim();
  if (label.length < 1 || label.length > L.promptMax) return problem("prompt", "promptLength");
  if (["text", "paragraph"].includes(type) && options.length) return problem("options", "textOptions");
  if (SURVEY_CHOICE_TYPES.includes(type) && (options.length < L.choiceOptionsMin || options.length > L.optionsMax)) {
    return problem("options", "choiceOptionCount");
  }
  if (type === "yes_no" && ![0, 2].includes(options.length)) return problem("options", "yesNoOptions");
  if (options.length > L.optionsMax) return problem("options", "optionCount");
  const seen = new Set();
  for (const option of options) {
    const value = storedOptionValue(option);
    if (value.length < 1 || value.length > L.optionMax) return problem("options", "optionLength");
    if (seen.has(value)) return problem("options", "optionDuplicate");
    seen.add(value);
  }
  const maxSelections = question.maxSelections;
  if (maxSelections !== null && maxSelections !== undefined && maxSelections !== "") {
    const limit = Number(maxSelections);
    if (type !== "checkbox" || !Number.isInteger(limit) || limit < 1 || limit > options.length) {
      return problem("maxSelections", "maxSelections");
    }
  }
  const branchValue = String(question.branchValue ?? "").trim();
  if (question.branchParentKey) {
    if (!earlier.has(question.branchParentKey)) return problem("showAfter", "branchParent");
    if (!branchValue) return problem("answerEquals", "branchValue");
  } else if (branchValue) {
    return problem("showAfter", "branchParent");
  }
  return null;
}

// The first rule the draft payload breaks, as { question, field, reason }
// (question is the 1-based number, or null for a survey-level field), or null.
export function surveyDraftProblem(payload) {
  const title = String(payload?.title ?? "").trim();
  if (title.length < L.titleMin || title.length > L.titleMax) return { question: null, field: "title", reason: "titleLength" };
  if (String(payload?.description ?? "").trim().length > L.descriptionMax) return { question: null, field: "description", reason: "descriptionLength" };
  const privacy = Number(payload?.privacyMinResponses);
  if (!Number.isInteger(privacy) || privacy < L.privacyMin || privacy > L.privacyMax) return { question: null, field: "privacyFloor", reason: "privacyFloor" };
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (questions.length < L.questionsMin || questions.length > L.questionsMax) return { question: null, field: "questions", reason: "questionCount" };
  const selectable = new Set();
  for (const [index, question] of questions.entries()) {
    const found = questionProblem(question, index + 1, selectable);
    if (found) return found;
    if (question.type !== "text" && question.type !== "paragraph") selectable.add(question.clientKey);
  }
  return null;
}

// The database's refusal messages (22023), read into the same field and
// reason so the notice uses catalogue copy instead of echoing the database.
const SERVER_REFUSALS = [
  ["choice questions require 2 to 20 options", "options", "choiceOptionCount"],
  ["survey option values must be unique", "options", "optionDuplicate"],
  ["invalid survey option", "options", "optionLength"],
  ["yes/no questions use the standard choices or two labels", "options", "yesNoOptions"],
  ["text questions do not accept options", "options", "textOptions"],
  ["invalid multiple-choice selection limit", "maxSelections", "maxSelections"],
  ["conditional questions require a comparison value", "answerEquals", "branchValue"],
  ["branch parent must be an earlier selectable question", "showAfter", "branchParent"],
  ["branch value requires a parent question", "showAfter", "branchParent"],
  ["survey requires 1 to 60 questions", "questions", "questionCount"],
  ["invalid survey question", "questions", "questionInvalid"],
  ["privacy floor must be between 3 and 50", "privacyFloor", "privacyFloor"],
  ["A draft needs valid title and description copy.", "title", "titleDescription"],
];

export function surveySaveRefusal(error) {
  if (error?.code !== "22023") return null;
  const message = String(error?.message ?? "");
  const match = SERVER_REFUSALS.find(([text]) => message.includes(text));
  return match ? { question: null, field: match[1], reason: match[2] } : null;
}

const FIELD_LABEL_KEYS = Object.freeze({
  title: "engagement.title",
  description: "engagement.description",
  privacyFloor: "engagement.privacyFloor",
  questions: "engagement.questionsSections",
  prompt: "engagement.prompt",
  options: "engagement.optionsLines",
  maxSelections: "engagement.maximumSelections",
  showAfter: "engagement.showAfter",
  answerEquals: "engagement.answerEquals",
});

// The notice a refused save shows: the question (when known), the field and
// the reason, or the plain failure line when the cause is not a known rule.
export function surveySaveFailureNotice(t, problem) {
  if (!problem) return t("engagement.surveySaveFailed");
  const field = t(FIELD_LABEL_KEYS[problem.field]);
  const reason = t(`engagement.surveyProblem.${problem.reason}`);
  return problem.question
    ? t("engagement.surveySaveFailedQuestion", { number: problem.question, field, reason })
    : t("engagement.surveySaveFailedField", { field, reason });
}
