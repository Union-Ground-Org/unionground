// @vitest-environment node
//
// BUG-UG-SURVEY-CHOICE-QUESTIONS-NOT-SAVED-20261030 (#6552): the
// builder's option parsing and draft checks, and their parity with the
// database validator (private.mi1_w2_replace_survey_questions and
// save_organization_survey_draft) that stays the authority.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SURVEY_AUTHORING_LIMITS, SURVEY_CHOICE_TYPES, parseSurveyOptionLines, surveyDraftProblem,
  surveyOptionLinesText, surveySaveFailureNotice, surveySaveRefusal,
} from "../src/features/engagement/surveyAuthoring.js";
import { catalogue, t as translate } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";

const VALIDATOR = readFileSync(new URL("../supabase/migrations/20260828220000_mi1_voice_survey_completion.sql", import.meta.url), "utf8");

const question = (fields = {}) => ({ clientKey: "q-1", type: "radio", label: "Which shift?", options: ["Yes", "No", "Not sure"], ...fields });
const draft = (fields = {}) => ({ title: "Shift bid survey", description: "", privacyMinResponses: 3, questions: [question()], ...fields });
const t = (key, values) => translate("en", key, values);

describe("option lines", () => {
  it("keeps one option per line with its inner spaces, dropping blank lines and edge spaces", () => {
    expect(parseSurveyOptionLines("Yes\nNo\nNot sure")).toEqual(["Yes", "No", "Not sure"]);
    expect(parseSurveyOptionLines("  Yes \r\n\n No\n\nNot sure  \n")).toEqual(["Yes", "No", "Not sure"]);
    expect(parseSurveyOptionLines("")).toEqual([]);
    expect(parseSurveyOptionLines(undefined)).toEqual([]);
  });

  it("writes stored options back as lines, reading value/label objects", () => {
    expect(surveyOptionLinesText(["Day", { label: "Night", value: "night" }, { value: "Swing" }])).toBe("Day\nNight\nSwing");
    expect(surveyOptionLinesText(undefined)).toBe("");
  });
});

describe("draft checks mirror the database validator", () => {
  it("accepts every choice type with three options, and the other types with none", () => {
    for (const type of SURVEY_CHOICE_TYPES) expect(surveyDraftProblem(draft({ questions: [question({ type })] }))).toBeNull();
    for (const type of ["text", "paragraph", "scale", "rating", "yes_no"]) {
      expect(surveyDraftProblem(draft({ questions: [question({ type, options: [] })] }))).toBeNull();
    }
    expect(surveyDraftProblem(draft({ questions: [question({ type: "yes_no", options: ["Agree", "Disagree"] })] }))).toBeNull();
    expect(surveyDraftProblem(draft({ questions: [question({ type: "checkbox", maxSelections: 2 })] }))).toBeNull();
    expect(surveyDraftProblem(draft({ questions: [question({ type: "checkbox", maxSelections: "" })] }))).toBeNull();
  });

  it("names the one-option choice question the old options box produced", () => {
    for (const type of SURVEY_CHOICE_TYPES) {
      expect(surveyDraftProblem(draft({ questions: [question({ type: "paragraph", options: [] }), question({ clientKey: "q-2", type, options: ["YesNoNotsure"] })] })))
        .toEqual({ question: 2, field: "options", reason: "choiceOptionCount" });
    }
    const many = Array.from({ length: 21 }, (_, n) => `Option ${n}`);
    expect(surveyDraftProblem(draft({ questions: [question({ options: many })] }))).toMatchObject({ reason: "choiceOptionCount" });
    expect(surveyDraftProblem(draft({ questions: [question({ type: "scale", options: many })] }))).toMatchObject({ reason: "optionCount" });
  });

  it.each([
    [{ title: "Hi" }, { question: null, field: "title", reason: "titleLength" }],
    [{ title: "x".repeat(201) }, { question: null, field: "title", reason: "titleLength" }],
    [{ title: undefined }, { question: null, field: "title", reason: "titleLength" }],
    [{ description: "x".repeat(4001) }, { question: null, field: "description", reason: "descriptionLength" }],
    [{ privacyMinResponses: 2 }, { question: null, field: "privacyFloor", reason: "privacyFloor" }],
    [{ privacyMinResponses: 51 }, { question: null, field: "privacyFloor", reason: "privacyFloor" }],
    [{ privacyMinResponses: 3.5 }, { question: null, field: "privacyFloor", reason: "privacyFloor" }],
    [{ questions: [] }, { question: null, field: "questions", reason: "questionCount" }],
    [{ questions: undefined }, { question: null, field: "questions", reason: "questionCount" }],
    [{ questions: Array.from({ length: 61 }, (_, n) => question({ clientKey: `q-${n}` })) }, { question: null, field: "questions", reason: "questionCount" }],
    [{ questions: [question({ label: " " })] }, { question: 1, field: "prompt", reason: "promptLength" }],
    [{ questions: [question({ label: undefined })] }, { question: 1, field: "prompt", reason: "promptLength" }],
    [{ questions: [question({ label: "x".repeat(401) })] }, { question: 1, field: "prompt", reason: "promptLength" }],
    [{ questions: [question({ type: "text", options: ["a"] })] }, { question: 1, field: "options", reason: "textOptions" }],
    [{ questions: [question({ type: "yes_no", options: ["a"] })] }, { question: 1, field: "options", reason: "yesNoOptions" }],
    [{ questions: [question({ options: ["Yes", "\u0007"] })] }, { question: 1, field: "options", reason: "optionLength" }],
    [{ questions: [question({ options: ["Yes", "x".repeat(161)] })] }, { question: 1, field: "options", reason: "optionLength" }],
    [{ questions: [question({ options: ["Yes", { label: "Yes" }] })] }, { question: 1, field: "options", reason: "optionDuplicate" }],
    [{ questions: [question({ maxSelections: 1 })] }, { question: 1, field: "maxSelections", reason: "maxSelections" }],
    [{ questions: [question({ type: "checkbox", maxSelections: 4 })] }, { question: 1, field: "maxSelections", reason: "maxSelections" }],
    [{ questions: [question({ type: "checkbox", maxSelections: 0 })] }, { question: 1, field: "maxSelections", reason: "maxSelections" }],
    [{ questions: [question(), question({ clientKey: "q-2", branchParentKey: "q-1", branchValue: " " })] }, { question: 2, field: "answerEquals", reason: "branchValue" }],
    [{ questions: [question({ type: "text", options: [] }), question({ clientKey: "q-2", branchParentKey: "q-1", branchValue: "Yes" })] }, { question: 2, field: "showAfter", reason: "branchParent" }],
    [{ questions: [question({ branchParentKey: "q-2", branchValue: "Yes" }), question({ clientKey: "q-2" })] }, { question: 1, field: "showAfter", reason: "branchParent" }],
    [{ questions: [question({ branchValue: "Yes" })] }, { question: 1, field: "showAfter", reason: "branchParent" }],
  ])("refuses %j", (fields, problem) => {
    expect(surveyDraftProblem(draft(fields))).toEqual(problem);
  });

  it("accepts a branch from an earlier selectable answer", () => {
    expect(surveyDraftProblem(draft({ questions: [question(), question({ clientKey: "q-2", type: "paragraph", options: [], branchParentKey: "q-1", branchValue: "Yes" })] }))).toBeNull();
    expect(surveyDraftProblem(null)).toEqual({ question: null, field: "title", reason: "titleLength" });
  });

  it("uses the bounds and refusal messages the database validator raises", () => {
    const L = SURVEY_AUTHORING_LIMITS;
    expect(VALIDATOR).toContain(`not between ${L.choiceOptionsMin} and ${L.optionsMax}`);
    expect(VALIDATOR).toContain(`jsonb_array_length(question_options) > ${L.optionsMax}`);
    expect(VALIDATOR).toContain(`char_length(option_value) not between 1 and ${L.optionMax}`);
    expect(VALIDATOR).toContain(`char_length(label) not between 1 and ${L.promptMax}`);
    expect(VALIDATOR).toContain(`not between ${L.questionsMin} and ${L.questionsMax}`);
    expect(VALIDATOR).toContain(`char_length(next_title) not between ${L.titleMin} and ${L.titleMax}`);
    expect(VALIDATOR).toContain(`char_length(next_description) > ${L.descriptionMax}`);
    expect(VALIDATOR).toContain(`privacy not between ${L.privacyMin} and ${L.privacyMax}`);
    expect(VALIDATOR).toContain(`question_type in ('${SURVEY_CHOICE_TYPES.join("', '")}')`);
    for (const message of [
      "choice questions require 2 to 20 options", "survey option values must be unique", "invalid survey option",
      "yes/no questions use the standard choices or two labels", "text questions do not accept options",
      "invalid multiple-choice selection limit", "conditional questions require a comparison value",
      "branch parent must be an earlier selectable question", "branch value requires a parent question",
      "survey requires 1 to 60 questions", "invalid survey question", "privacy floor must be between 3 and 50",
      "A draft needs valid title and description copy.",
    ]) {
      expect(VALIDATOR).toContain(`'${message}'`);
      expect(surveySaveRefusal({ code: "22023", message: `Save survey draft: ${message}` })).not.toBeNull();
    }
  });
});

describe("save failure notices", () => {
  it("reads database refusals into a field and reason, and leaves other errors unnamed", () => {
    expect(surveySaveRefusal({ code: "22023", message: "Save survey draft: choice questions require 2 to 20 options" }))
      .toEqual({ question: null, field: "options", reason: "choiceOptionCount" });
    expect(surveySaveRefusal({ code: "22023", message: "Save survey draft: invalid survey option" }))
      .toEqual({ question: null, field: "options", reason: "optionLength" });
    expect(surveySaveRefusal({ code: "22023", message: "something else" })).toBeNull();
    expect(surveySaveRefusal({ code: "22023" })).toBeNull();
    expect(surveySaveRefusal({ code: "42501", message: "invalid survey option" })).toBeNull();
    expect(surveySaveRefusal(null)).toBeNull();
  });

  it("names the question, field and reason in catalogue copy", () => {
    expect(surveySaveFailureNotice(t, { question: 2, field: "options", reason: "choiceOptionCount" }))
      .toBe("Survey could not be saved. Question 2, Options, one per line: a choice question needs 2 to 20 options, one per line.");
    expect(surveySaveFailureNotice(t, { question: null, field: "privacyFloor", reason: "privacyFloor" }))
      .toBe("Survey could not be saved. Privacy floor: use a whole number from 3 to 50.");
    expect(surveySaveFailureNotice(t, null)).toBe("Survey could not be saved.");
  });

  it("has English and Spanish copy for every field and reason it can name", () => {
    const reasons = ["titleLength", "titleDescription", "descriptionLength", "privacyFloor", "questionCount", "questionInvalid", "promptLength",
      "choiceOptionCount", "yesNoOptions", "textOptions", "optionCount", "optionLength", "optionDuplicate", "maxSelections", "branchParent", "branchValue"];
    for (const table of [catalogue.en, spanishCatalogue.es]) {
      for (const reason of reasons) expect(table[`engagement.surveyProblem.${reason}`]).toBeTruthy();
      expect(table["engagement.surveySaveFailedQuestion"]).toContain("{reason}");
      expect(table["engagement.surveySaveFailedField"]).toContain("{field}");
    }
    for (const field of ["title", "description", "privacyFloor", "questions", "prompt", "options", "maxSelections", "showAfter", "answerEquals"]) {
      expect(surveySaveFailureNotice(t, { question: null, field, reason: "questionInvalid" })).not.toContain("engagement.");
    }
  });
});
