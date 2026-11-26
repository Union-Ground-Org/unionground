// @vitest-environment node
// UX-UG-COMPASS-ANSWER-TALKS-ABOUT-PROVIDED-SOURCES-20261108 (#7461).
//
// A SAMPLE demo answer opened "The provided sources do not contain
// information...": the model describing its prompt instead of answering the
// person. The question prompt now tells it to speak to the person and name the
// article it relies on, for every reader role.
import { describe, expect, it } from "vitest";
import { COMPASS_ANSWER_VOICE, buildGuideMessages } from "../api/_lib/compassPrompts.js";

const source = { kind: "contract", source_id: "kb:article-12", title: "Article 12 — Weingarten rights", ref: "Contract · Article 12", snippet: "Record what happened, preserve evidence, and reach a steward without escalating risk." };
const system = (role) => buildGuideMessages("Do I have the right to a steward?", { activePlanKinds: [] }, [], [source], role)[0].content;

describe("Compass answers speak to the person, not about the prompt", () => {
  it.each(["member", "steward", "coordinator", undefined])("carries the voice instruction for a %s reader", (role) => {
    const prompt = system(role);
    expect(prompt.split("\n")).toContain(COMPASS_ANSWER_VOICE);
    expect(COMPASS_ANSWER_VOICE).toContain("Speak directly to the person asking, as \"you\".");
    for (const phrase of ["the sources", "the provided sources", "the SOURCES", "the context", "the information provided", "the materials"]) {
      expect(COMPASS_ANSWER_VOICE).toContain(`"${phrase}"`);
    }
  });

  it("no longer asks the model to refer to \"these sources\" when it cannot decide applicability", () => {
    const prompt = system("member");
    expect(prompt).not.toContain("from these sources");
    expect(prompt).toContain("say you cannot determine that from the contract language alone, then briefly state only the relevant rule.");
  });

  it("keeps the grounding, scope and privacy rules and the question unchanged", () => {
    const messages = buildGuideMessages("Do I have the right to a steward?", { activePlanKinds: [] }, [], [source], "member");
    expect(messages[0].content).toContain("ground every substantive claim in the SOURCES below");
    expect(messages[0].content).toContain("Some content was withheld for privacy.");
    expect(messages[0].content).toContain(source.snippet);
    expect(messages.at(-1)).toEqual({ role: "user", content: "Do I have the right to a steward?" });
  });
});
