// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAnswerEmpty, missingRequiredQuestions, optionLabel, optionValue, pruneHiddenAnswers, surveyChoices,
  surveySessionStatus, toggleSelection, visibleQuestions, withAnswer,
} from "../src/features/engagement/surveyModel.js";

// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
//: one survey model serves the web Voice surface and
// the native app; both import these decisions.
const survey = {
  id: "s1",
  questions: [
    { id: "q1", type: "yes_no", label: "Attend?", required: true, options: [] },
    { id: "q2", type: "checkbox", label: "Topics", required: false, options: ["pay", { value: "safety", label: "Safety" }], maxSelections: 2, branchParentId: "q1", branchValue: "yes" },
    { id: "q3", type: "paragraph", label: "Why not?", required: true, options: [], branchParentId: "q1", branchValue: "no" },
    { id: "q4", type: "scale", label: "Confidence", required: true, options: [] },
  ],
};

describe("shared survey model", () => {
  it("reads options as strings or value/label objects", () => {
    expect(optionValue("pay")).toBe("pay");
    expect(optionValue({ value: "safety", label: "Safety" })).toBe("safety");
    expect(optionValue({ label: "Only label" })).toBe("Only label");
    expect(optionLabel({ value: "safety", label: "Safety" })).toBe("Safety");
    expect(optionLabel({ value: "v" })).toBe("v");
  });

  it("reveals branched questions from the parent answer, including array answers", () => {
    expect(visibleQuestions(survey, {}).map((q) => q.id)).toEqual(["q1", "q4"]);
    expect(visibleQuestions(survey, { q1: "yes" }).map((q) => q.id)).toEqual(["q1", "q2", "q4"]);
    expect(visibleQuestions(survey, { q1: "no" }).map((q) => q.id)).toEqual(["q1", "q3", "q4"]);
    expect(visibleQuestions({ questions: [{ id: "c", branchParentId: "p", branchValue: "b" }] }, { p: ["a", "b"] })).toHaveLength(1);
    expect(visibleQuestions(null)).toEqual([]);
  });

  it("hides every descendant of a hidden ancestor and prunes their retained answers", () => {
    const nested = { questions: [
      { id: "q1", type: "yes_no", required: true, options: [] },
      { id: "q2", type: "yes_no", required: true, options: [], branchParentId: "q1", branchValue: "yes" },
      { id: "q3", type: "text", required: true, options: [], branchParentId: "q2", branchValue: "yes" },
      { id: "loopA", type: "text", options: [], branchParentId: "loopB", branchValue: "x" },
      { id: "loopB", type: "text", options: [], branchParentId: "loopA", branchValue: "x" },
      { id: "orphan", type: "text", options: [], branchParentId: "missing", branchValue: "x" },
    ] };
    expect(visibleQuestions(nested, { q1: "yes", q2: "yes", q3: "why" }).map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    // q1 flips to no: q2 hides, and q3 hides with it even though answers.q2 still says yes.
    const flipped = { q1: "no", q2: "yes", q3: "why", loopA: "x", loopB: "x", orphan: "x", extra: "kept" };
    expect(visibleQuestions(nested, flipped).map((q) => q.id)).toEqual(["q1"]);
    expect(missingRequiredQuestions(nested, flipped)).toEqual([]);
    expect(pruneHiddenAnswers(nested, flipped)).toEqual({ q1: "no", extra: "kept" });
    expect(pruneHiddenAnswers(nested, { q1: "yes", q2: "yes", q3: "why" })).toEqual({ q1: "yes", q2: "yes", q3: "why" });
  });

  it("offers the database defaults for yes_no and scale questions and the authored list otherwise", () => {
    expect(surveyChoices(survey.questions[0])).toEqual([{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
    expect(surveyChoices(survey.questions[0], { yes: "Sí", no: "No" })[0]).toEqual({ value: "yes", label: "Sí" });
    expect(surveyChoices(survey.questions[3]).map((c) => c.value)).toEqual([1, 2, 3, 4, 5]);
    expect(surveyChoices(survey.questions[1])).toEqual([{ value: "pay", label: "pay" }, { value: "safety", label: "Safety" }]);
    expect(surveyChoices({ type: "text" })).toEqual([]);
  });

  it("names the required visible questions a submit still needs, mirroring the server rule", () => {
    expect(missingRequiredQuestions(survey, {}).map((q) => q.id)).toEqual(["q1", "q4"]);
    expect(missingRequiredQuestions(survey, { q1: "no", q4: 3 }).map((q) => q.id)).toEqual(["q3"]);
    expect(missingRequiredQuestions(survey, { q1: "no", q3: "   ", q4: 3 }).map((q) => q.id)).toEqual(["q3"]);
    expect(missingRequiredQuestions(survey, { q1: "yes", q4: 3 })).toEqual([]);
    expect(isAnswerEmpty({ type: "checkbox" }, [])).toBe(true);
    expect(isAnswerEmpty({ type: "checkbox" }, ["pay"])).toBe(false);
    expect(isAnswerEmpty({ type: "scale" }, 0)).toBe(false);
  });

  it("keeps the answer map free of cleared keys and caps checkbox selections", () => {
    expect(withAnswer({ q1: "yes" }, "q4", 2)).toEqual({ q1: "yes", q4: 2 });
    expect(withAnswer({ q1: "yes", q4: 2 }, "q4", undefined)).toEqual({ q1: "yes" });
    const q2 = survey.questions[1];
    expect(toggleSelection(q2, undefined, "pay")).toEqual(["pay"]);
    expect(toggleSelection(q2, ["pay"], "safety")).toEqual(["pay", "safety"]);
    expect(toggleSelection(q2, ["pay", "safety"], "other")).toEqual(["pay", "safety"]);
    expect(toggleSelection(q2, ["pay", "safety"], "pay")).toEqual(["safety"]);
  });

  it("classifies a member's session", () => {
    expect(surveySessionStatus({ session: null })).toBe("open");
    expect(surveySessionStatus({ session: { status: "in_progress" } })).toBe("in_progress");
    expect(surveySessionStatus({ session: { status: "submitted" } })).toBe("submitted");
  });

  it("is the model both the web member surface and the native app import", () => {
    const web = readFileSync("src/features/engagement/MemberEngagement.jsx", "utf8");
    expect(web).toContain('import { SURVEY_TEXT_LIMITS, optionLabel, optionValue, pruneHiddenAnswers, visibleQuestions } from "./surveyModel.js";');
    expect(web).toContain("engagementApi.saveSurveySession(client, survey.id, pruneHiddenAnswers(survey, answers))");
    expect(web).toContain("engagementApi.submitSurveySession(client, survey.id, pruneHiddenAnswers(survey, answers))");
    expect(web).toContain("maxLength={question.type === \"paragraph\" ? SURVEY_TEXT_LIMITS.paragraph : SURVEY_TEXT_LIMITS.text}");
    expect(web).not.toMatch(/^function (optionValue|optionLabel|visibleQuestions)\(/m);
    const native = readFileSync("apps/mobile/src/lib/memberSurveysShared.ts", "utf8");
    expect(native).toContain("from '../../../../src/features/engagement/surveyModel.js';");
    const livedIn = readFileSync("apps/mobile/src/services/livedIn.ts", "utf8");
    expect(livedIn).not.toContain("member_surveys");
    expect(livedIn).not.toContain("submit_survey_response");
  });
});
