// @vitest-environment node
// BUG-UG-COMPASS-MINIMIZER-WITHHOLDS-ORDINARY-QUESTIONS-20261107 .
//
// The SAMPLE demo refused a visitor's natural first questions ("How long does
// it take?", "steps to open a case") with the 422 "can't send that question as
// written". Each was caught by the closed-vocabulary check in minimizeText:
// "long" and "take" were in no vocabulary, and "open" and "case" are product
// words admitted only in a how-to sentence, a form that did not cover a
// question asking for the steps. The repair reads "long" only inside "how
// long" and "take"/"takes" only after it, this or that in a duration question
// (never as vocabulary, so the name Long or Take is still withheld anywhere in
// the sentence), and adds the steps forms to HOW_TO_FORM; every name, digit
// and health, discipline or immigration rule still applies.
import { describe, expect, it } from "vitest";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { productGuideSources } from "../api/_lib/compassProductGuide.js";
import { buildGuideMessages, compassRetrievalQuery, minimizeCompassEmbeddingSource, minimizeCompassQuestion, unchangedCompassTrainingText } from "../api/_lib/compassPrompts.js";

const MESH_ACCESS = {
  surface: "saas",
  endpoint: "https://mesh.example.invalid/v1/chat/completions",
  credentials: { apiKey: "test-mesh-bearer", accessClientId: "test-access-id", accessClientSecret: "test-access-secret" },
  provider: { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1", connector: null },
};
const payload = (messages) => JSON.parse(buildCompassGatewayRequest(messages, MESH_ACCESS).options.body);
const source = { kind: "contract", source_id: "kb:article-14", title: "Article 14 — Grievance Procedure", ref: "Contract · Article 14", snippet: "Record what happened, preserve evidence, and reach a steward without escalating risk." };

// The record's withheld examples and the rule that caught each one.
const REFUSED = [
  ["How long does it take?", "vocabulary: long, take"],
  ["steps to open a case", "vocabulary: open, case outside a how-to form"],
  ["Which steps open a case?", "vocabulary: open, case outside a how-to form"],
  ["What are the steps to open a case?", "vocabulary: open, case outside a how-to form"],
  ["What are the steps to open a grievance case?", "vocabulary: open, case outside a how-to form"],
  ["How long does a member have to file a grievance under the contract?", "vocabulary: long"],
];
// The record's examples that were already sent, and must stay sent.
const ALLOWED = [
  "How do I open a case?",
  "How do I file a grievance?",
  "How long do I have to file a grievance?",
  "What are the steps?",
  "What is a grievance?",
  "Does a member have rights?",
];

describe("Compass sends ordinary procedural questions unchanged", () => {
  it.each(REFUSED)("sends %s (was withheld by %s)", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
    expect(compassRetrievalQuery(question)).toBe(question);
    expect(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source])).messages.at(-1)).toEqual({ role: "user", content: question });
  });

  it.each(ALLOWED)("still sends %s", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
    expect(compassRetrievalQuery(question)).toBe(question);
  });

  it("grounds a steps question in the product guide like the how-to form", () => {
    for (const question of ["What are the steps to open a case?", "Which steps open a case?", "steps to open a case"]) {
      expect(productGuideSources(compassRetrievalQuery(question))[0]?.source_id, question).toBe("guide:open-a-case");
    }
    expect(productGuideSources("How long does it take?")).toEqual([]);
  });
});

describe("the narrowed rules still withhold what they exist to block", () => {
  it("withholds names, contact details, identifying numbers and private topics in the newly sent forms", () => {
    for (const question of [
      "How long does it take for Keisha Monroe?",
      "How long does Dana Ruiz take to respond?",
      "What are the steps to open a case for Keisha Monroe?",
      "Which steps open a case for jane@example.com?",
      "steps to open a case at 555-0100",
      "What are the steps to open a case 4471?",
      "What are the steps to open a case at Harrow Bay?",
      "How long does it take after my suspension?",
      "How long does my medical leave take?",
      "How long does it take to heal my injury?",
      "steps to open a case about my discipline",
      "What are the steps to open a case about my diagnosis?",
      "What are the steps to open a case about my visa?",
      "Which steps open a case about my immigration status?",
    ]) expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  // Long as a personal
  // name, first in the sentence, vocative or later, in any case.
  it.each([
    "Long, how long does it take?",
    "Long takes how many days of leave?",
    "long, how long does it take?",
    "LONG, how long does it take?",
    "Long: how long does it take?",
    "Long how long does it take?",
    "How long does it take, Long?",
    "how long does it take, long?",
    "How long does Long take?",
    "how long does long take?",
    "How long will Long take?",
    "Long takes too long.",
    "long takes how many days?",
    "Long, what are the steps to open a case?",
    "Take, how long does it take?",
    "take, how long does it take?",
    "How long does it take Take?",
    "Dana Long, how long does it take?",
  ])("withholds the name in %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it("reads long and take only in the duration question forms", () => {
    for (const question of ["How long does it take?", "How long?", "How many days does it take?", "How long it takes to file a grievance?", "What would it take?"]) {
      expect(minimizeCompassQuestion(question), question).toBe(question);
    }
    for (const question of ["Is it long?", "I take leave.", "Take a grievance.", "It takes days.", "How long is Long?"]) {
      expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
    }
  });

  it("keeps the ordinary sentence and withholds a private one sent with it", () => {
    const question = "How long does it take? My supervisor Dana Ruiz wrote me up on Monday.";
    expect(minimizeCompassQuestion(question)).toBe("How long does it take? [details withheld]");
    expect(compassRetrievalQuery(question)).toBe("How long does it take?");
    const outbound = JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source])));
    for (const fact of ["Dana", "Ruiz", "wrote"]) expect(outbound).not.toContain(fact);
  });

  it("opens product words to the steps form only, at the start of a sentence", () => {
    for (const question of ["I want to open a case.", "Open a case for me.", "I know the steps to open a case.", "Take a case."]) {
      expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
    }
  });

  it("widens the member question only: training and source text keep the stricter rules", () => {
    for (const [question] of REFUSED) {
      expect(unchangedCompassTrainingText(question, 1200), question).toBeNull();
      expect(() => minimizeCompassEmbeddingSource(question), question).toThrow("Compass minimization failed");
    }
  });
});
