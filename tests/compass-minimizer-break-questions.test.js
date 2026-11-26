// @vitest-environment node
// BUG-UG-COMPASS-WITHHOLDS-REST-AND-MEAL-BREAK-QUESTIONS-20261108 (#7553).
//
// Owner order "ALLOW BREAKS", November 8, 2026, 11:27 AM ET:
// Compass
// answers general rest-break and meal-break questions from the contract. On
// Main 57c0b66 none of these were sent. Every name, digit, contact, health,
// discipline, immigration and leave-status rule still applies, and a
// capitalized break word used as a name or vocative stays withheld.
import { describe, expect, it } from "vitest";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { buildGuideMessages, compassRetrievalQuery, isMemberQuestionSeparator, minimizeCompassEmbeddingSource, minimizeCompassQuestion, unchangedCompassTrainingText } from "../api/_lib/compassPrompts.js";

const MESH_ACCESS = {
  surface: "saas",
  endpoint: "https://mesh.example.invalid/v1/chat/completions",
  credentials: { apiKey: "test-mesh-bearer", accessClientId: "test-access-id", accessClientSecret: "test-access-secret" },
  provider: { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1", connector: null },
};
const payload = (messages) => JSON.parse(buildCompassGatewayRequest(messages, MESH_ACCESS).options.body);
const source = { kind: "contract", source_id: "kb:article-9", title: "Article 9 — Hours of work", ref: "Contract · Article 9", snippet: "Record what happened, preserve evidence, and reach a steward without escalating risk." };

const BREAK_QUESTIONS = [
  "Do I get a lunch break?",
  "What does the contract say about breaks?",
  "How long is my meal break?",
  "Can I be denied a break?",
  "Do I get rest breaks?",
  "How many breaks do I get?",
  "When do I get a meal break?",
  "Is my lunch break paid?",
  "How long are rest breaks?",
  "Can my supervisor make me work through my lunch break?",
  "What happens if I miss my meal break?",
  "Do stewards get breaks?",
  "Can a member be denied a rest break?",
  "What about rest breaks?",
  "¿Tengo derecho a un descanso para comer?",
  "¿Qué dice el contrato sobre los descansos?",
  "¿Cuánto dura mi descanso para comer?",
  "¿Me pueden negar un descanso?",
];

const BREAK_ADVERSARIAL = [
  "Did my supervisor Dana Ruiz deny my lunch break?",
  "Can Keisha Monroe take a lunch break?",
  "Do I get a lunch break at site 4471?",
  "Can I be denied a break because of my pregnancy?",
  "Do I get a meal break for my diabetes?",
  "I was denied a break after my injury.",
  "My break was denied because of my disability.",
  "Can I be denied a break because of my visa?",
  "Do I get a lunch break during my suspension?",
  "Lunch, can I file a grievance?",
  "Break, can I file a grievance?",
  "Meal, can I file a grievance?",
  "Do I get my two 15-minute breaks during probation?",
  "Do I get rest breaks during my probation?",
  "rest breaks probation",
];

describe("Compass sends general rest-break and meal-break questions", () => {
  it.each(BREAK_QUESTIONS)("sends %s on the member and steward paths", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
    expect(compassRetrievalQuery(question)).toBe(question);
    for (const role of ["member", "steward"]) {
      expect(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)).messages.at(-1), role).toEqual({ role: "user", content: question });
    }
  });

  it("covers the owner's examples in English and Spanish", () => {
    for (const question of ["Do I get a lunch break?", "What does the contract say about breaks?", "How long is my meal break?", "Can I be denied a break?", "¿Qué dice el contrato sobre los descansos?"]) {
      expect(BREAK_QUESTIONS).toContain(question);
    }
  });
});

describe("break questions still withhold what the minimizer exists to block", () => {
  it.each(BREAK_ADVERSARIAL)("withholds %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it("keeps the break question and withholds a contact detail sent with it", () => {
    const question = "Can my supervisor deny my lunch break? Call me at 555-0100.";
    expect(minimizeCompassQuestion(question)).toBe("Can my supervisor deny my lunch break? [details withheld]");
    expect(compassRetrievalQuery(question)).toBe("Can my supervisor deny my lunch break?");
    expect(JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source])))).not.toContain("555");
  });

  it("widens the member question only: training and source text keep their rules", () => {
    for (const question of BREAK_QUESTIONS) {
      expect(unchangedCompassTrainingText(question, 1200), question).toBeNull();
      expect(() => minimizeCompassEmbeddingSource(question), question).toThrow("Compass minimization failed");
    }
  });
});

// "miss"/"missed" as free words
// let a missed-period health statement through, and "lunch"/"meal"/"comida"
// let cooking questions through. They are now read only in break grammar, and
// a missed or late period or menstruation is private health.
const HEALTH_WITHHELD = [
  "I missed my period.",
  "I have missed my period.",
  "I missed two periods.",
  "My period was missed.",
  "My period is late.",
  "Do I get a break during my period?",
  "Tengo la menstruación, ¿me dan un descanso?",
  "No me ha bajado la menstruación.",
];
const OFF_TOPIC_WITHHELD = [
  "How do I make lunch?",
  "What meals can I make?",
  "¿Qué comida puedo comer?",
  "Do I get lunch?",
  "What should I eat for my meal?",
];

describe("break grammar never admits health or cooking text (G6 on #7554)", () => {
  it.each([...HEALTH_WITHHELD, ...OFF_TOPIC_WITHHELD])("withholds %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each([
    ["Can I get a lunch break? I missed my period.", "Can I get a lunch break? [details withheld]", "Can I get a lunch break?"],
    ["I missed my period. Can I get a lunch break?", "[details withheld] Can I get a lunch break?", "Can I get a lunch break?"],
  ])("sends only the break question from %s, on the member and steward paths", (question, sent, retrieved) => {
    expect(minimizeCompassQuestion(question)).toBe(sent);
    expect(compassRetrievalQuery(question)).toBe(retrieved);
    for (const role of ["member", "steward"]) {
      const body = JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)));
      expect(body, role).not.toContain("period");
      expect(body, role).toContain("Can I get a lunch break?");
    }
  });

  it("still sends missed-break and rest-period questions", () => {
    for (const question of ["What happens if I miss my meal break?", "What if I missed my rest break?", "Is my lunch period paid?", "How long is a rest period?"]) {
      expect(minimizeCompassQuestion(question), question).toBe(question);
    }
  });
});

// The break
// rewrite erased "missed" before the health check ran, and a personal period
// after "for my" or "on my" was not health. The health check now reads the
// sentence before any rewrite, and a personal period is health unless a rest,
// meal, lunch, pay or break word sits right before it.
const ROUND_3_WITHHELD = [
  "Can I get a lunch break for my period?",
  "Do I get a lunch break on my period?",
  "Can I get a break on my period?",
  "Do I get rest breaks on my period?",
  "I missed my lunch break and two periods.",
  "What if I missed my meal break and my period?",
  "I missed my rest break and my period.",
  "I missed (my) period.",
  "I missed my monthly period.",
  "I missed my first period.",
  "My periods are late.",
  "My period — is late.",
  "¿Me dan un descanso por mi regla?",
  "¿Puedo tomar un descanso durante mi período?",
  "Can I miss meals for a week?",
  "How many days can I miss meals?",
];

describe("a break sentence with private health text is withheld whole (G6 rounds 3 and 4)", () => {
  it.each(ROUND_3_WITHHELD)("withholds %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each([
    ["Can I get a lunch break? I missed my lunch break and two periods.", "Can I get a lunch break? [details withheld]", "Can I get a lunch break?"],
    ["Can I get a break? I missed my rest break and my period.", "Can I get a break? [details withheld]", "Can I get a break?"],
    ["¿Tengo derecho a un descanso para comer? Tengo la menstruación.", "¿Tengo derecho a un descanso para comer? [details withheld]", "¿Tengo derecho a un descanso para comer?"],
  ])("sends only the clean break sentence of %s, on the member and steward paths", (question, sent, retrieved) => {
    expect(minimizeCompassQuestion(question)).toBe(sent);
    expect(compassRetrievalQuery(question)).toBe(retrieved);
    for (const role of ["member", "steward"]) {
      const body = JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)));
      expect(body, role).not.toMatch(/period|menstru/iu);
    }
  });

  it("still sends explicit rest, meal, lunch and pay periods and missed rest periods", () => {
    for (const question of ["What if I missed my rest period?", "How many rest periods do I get?", "Is my lunch period paid?", "How long is a rest period?", "What happens if I miss my meal break?"]) {
      expect(minimizeCompassQuestion(question), question).toBe(question);
    }
  });
});

// An adjective between
// the personal determiner and "period" escaped the adjacency rule. A personal
// determiner, up to two words and "period" is health unless one of those
// words is a break, rest, meal, lunch, pay or notice word.
const ROUND_5_WITHHELD = ["for", "on"].flatMap((preposition) => ["current", "second", "next", "last"]
  .map((adjective) => `Can I get a lunch break ${preposition} my ${adjective} period?`))
  .concat([
    "¿Puedo tomar un descanso durante mi próximo período?",
    "Do I get a rest break during your next period?",
    "Can I take a break in our last period?",
  ]);

describe("a personal period with an adjective is health (G6 round 5)", () => {
  it("pins G6's eight cases", () => {
    expect(ROUND_5_WITHHELD.slice(0, 8)).toHaveLength(8);
  });

  it.each(ROUND_5_WITHHELD)("withholds %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each([
    ["Can I get a lunch break? I am on my current period.", "Can I get a lunch break? [details withheld]", "Can I get a lunch break?"],
    ["¿Tengo derecho a un descanso para comer? Estoy en mi segundo período.", "¿Tengo derecho a un descanso para comer? [details withheld]", "¿Tengo derecho a un descanso para comer?"],
  ])("sends only the clean break sentence of %s, on the member and steward paths", (question, sent, retrieved) => {
    expect(minimizeCompassQuestion(question)).toBe(sent);
    expect(compassRetrievalQuery(question)).toBe(retrieved);
    for (const role of ["member", "steward"]) {
      const body = JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)));
      expect(body, role).not.toMatch(/period|per[íi]odo/iu);
    }
  });

  it("still sends rest, lunch, meal, pay and notice periods", () => {
    for (const question of ["What is my notice period?", "Is my lunch period paid?", "How long is my rest period?", "Is my next pay period paid?", "When is my meal period?"]) {
      expect(minimizeCompassQuestion(question), question).toBe(question);
    }
  });
});

// An en dash between the
// determiner, an adjective and "period" escaped the separator class. Every
// Unicode dash and space variant is normalized before the tokenizer, the
// break grammar and the health check read the sentence.
const ROUND_6_WITHHELD = [
  "Can I get a lunch break for my current–period?",
  "Can I get a lunch break on my current – period?",
  "Can I get a lunch break on my current–period?",
  "Can I get a lunch break on my–current period?",
  "Can I get a lunch break on my current—period?",
  "Can I get a lunch break on my current−period?",
  "Can I get a lunch break on my current－period?",
  "Can I get a lunch break on my current period?",
  "Can I get a lunch break on my current period?",
  "Can I get a lunch break on my　period?",
  "¿Me dan un descanso para comer durante mi próximo período?",
  "¿Puedo tomar un descanso durante mi–período?",
];

describe("dash and space variants never split a personal period (G6 round 6)", () => {
  it.each(ROUND_6_WITHHELD)("withholds %j", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it("still sends break questions written with a no-break space", () => {
    expect(minimizeCompassQuestion("Do I get a lunch break?")).toBe("Do I get a lunch break?");
    expect(minimizeCompassQuestion("How long is my rest period?")).toBe("How long is my rest period?");
    expect(minimizeCompassQuestion("¿Cuánto dura mi descanso para comer?")).toBe("¿Cuánto dura mi descanso para comer?");
  });
});

// A middle dot (U+00B7,
// U+0387) separated words for the tokenizer but not for the health check.
// The tokenizer, the break grammar and the health check now share one
// separator definition after NFKC, and a line break no longer ends a member
// sentence. The walk takes every code point that is a separator after NFKC by
// the tokenizer's own definition, not a hand list.
const SEPARATORS = [];
for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
  const character = String.fromCodePoint(codePoint).normalize("NFKC");
  if (isMemberQuestionSeparator(character)) SEPARATORS.push(codePoint);
}
const G6_EIGHT = ROUND_5_WITHHELD.slice(0, 8);
const sendsNoPeriod = (question) => {
  let sent = "";
  try { sent = minimizeCompassQuestion(question); } catch { return; }
  expect(sent, JSON.stringify(question)).not.toMatch(/period/iu);
};

describe("every tokenizer separator keeps a personal period private (G6 round 7)", () => {
  it("finds the separators G6 named among the tokenizer's own", () => {
    for (const codePoint of [0x20, 0x2d, 0xb7, 0x387, 0x2013, 0x2028, 0x0a]) expect(SEPARATORS, codePoint.toString(16)).toContain(codePoint);
    expect(SEPARATORS.length).toBeGreaterThan(40);
  });

  it.each(SEPARATORS.map((codePoint) => [`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`, String.fromCodePoint(codePoint)]))("withholds G6's eight sentences with %s for the space and the hyphen", (_, separator) => {
    for (const question of G6_EIGHT) {
      sendsNoPeriod(question.replace(/ period\?$/u, `${separator}period?`));
      sendsNoPeriod(question.replace(/ my /u, ` my${separator}`));
      sendsNoPeriod(question.replace(/ period\?$/u, `-period?`).replace("-", separator));
    }
  });

  it.each(SEPARATORS.map((codePoint) => [`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`, String.fromCodePoint(codePoint)]))("sends only the clean break sentence with %s, through retrieval and both bodies", (_, separator) => {
    for (const question of [`Can I get a lunch break? I am on my current${separator}period.`, `Can I get a lunch break? I am on my${separator}current period.`]) {
      sendsNoPeriod(question);
      expect(compassRetrievalQuery(question), JSON.stringify(question)).not.toMatch(/period/iu);
      for (const role of ["member", "steward"]) {
        const body = JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)));
        expect(body, `${role} ${JSON.stringify(question)}`).not.toMatch(/period/iu);
      }
    }
  });

  it("still sends work periods and break questions across a line break", () => {
    expect(minimizeCompassQuestion("How long is my rest period?")).toBe("How long is my rest period?");
    expect(minimizeCompassQuestion("Do I get a lunch\nbreak?")).toBe("Do I get a lunch break?");
  });
});
