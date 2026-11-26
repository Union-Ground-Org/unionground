// @vitest-environment node
// UX-UG-COMPASS-NON-ANSWER-LISTS-OFF-TOPIC-SOURCES-20261108 .
//
// The live demo answered "Can my supervisor change my schedule without
// notice?" with a non-answer that opened on the overtime rule and listed heat
// protocol and hazard sources. The prompt now says plainly when no source
// answers, and the API lists only the sources an answer names.
import { describe, expect, it } from "vitest";
import { compassCitedSources, splitCompassAnswerSources } from "../api/_lib/compassCitedSources.js";
import { COMPASS_SOURCES_USED_INSTRUCTION, buildGuideMessages } from "../api/_lib/compassPrompts.js";

const overtime = { id: "kb:ot", kind: "contract", title: "Know Your Contract: Mandatory overtime (Article 9)", ref: "County CBA 2025–2028 · Article 9" };
const heat = { id: "kb:heat", kind: "contract", title: "Know Your Contract: Health, safety and the heat protocol (Article 16)", ref: "County CBA 2025–2028 · Article 16" };
const grievance = { id: "kb:griev", kind: "contract", title: "Know Your Contract: The grievance procedure, step by step (Article 14)", ref: "County CBA 2025–2028 · Article 14" };
const hazards = { id: "kb:haz", kind: "rights", title: "Reporting hazards and refusing unsafe work", ref: "Safety rights · Article 16" };
const steward = { id: "kb:faq", kind: "faq", title: "How do I reach a steward?", ref: "FAQ · Representation" };
const guide = { id: "guide:open-a-case", kind: "product_guide", title: "Opening a case", ref: "Union Ground guide" };
const audit = [overtime, heat, grievance, hazards];

describe("compassCitedSources", () => {
  it("lists nothing for the audit's non-answer", () => {
    expect(compassCitedSources("I don't have a verified answer about schedule change notice in your contract. Contact your chapter steward.", audit)).toEqual([]);
  });

  it("lists only the article an answer cites, in English or Spanish, with or without a section", () => {
    expect(compassCitedSources("Article 14 requires you to file at Step 1 within 30 calendar days.", audit)).toEqual([grievance]);
    expect(compassCitedSources("Under Article 9.4 you may decline after 12 hours.", audit)).toEqual([overtime]);
    expect(compassCitedSources("El Artículo 16 protege tu derecho a negarte.", audit)).toEqual([heat, hazards]);
    expect(compassCitedSources("Section 14.2 sets the deadline.", audit)).toEqual([grievance]);
    expect(compassCitedSources("Article 140 is not Article 14.", [grievance])).toEqual([grievance]);
    expect(compassCitedSources("See Article 1.", audit)).toEqual([]);
  });

  it("lists a source the answer names by title even without an article", () => {
    expect(compassCitedSources("The knowledge-base answer How do I reach a steward? says to use Request a steward.", [steward, heat])).toEqual([steward]);
    expect(compassCitedSources("Your health, safety and the heat protocol rules give you a cool-down break.", audit)).toEqual([heat]);
  });

  it("keeps product-guide sources, which only come with a matching how-to question", () => {
    expect(compassCitedSources("Open My cases and choose Start a new case.", [guide, heat])).toEqual([guide]);
  });

  it("tolerates missing answers and source lists", () => {
    expect(compassCitedSources(undefined, audit)).toEqual([]);
    expect(compassCitedSources("Article 9", undefined)).toEqual([]);
    expect(compassCitedSources("Article 9", [null, overtime])).toEqual([overtime]);
  });
});

// "§ 9.2", plural, list and
// range citations matched nothing, so explicitly cited sources disappeared.
// Real model phrasings first (local and SAMPLE probes, Nov 7-8, 2026), then
// the forms the gate named.
const nine = { id: "kb:sched", kind: "contract", title: "Know Your Contract: Schedule changes and notice (Article 9)", ref: "County CBA 2025–2028 · Article 9" };
const twelve = { id: "kb:disc", kind: "contract", title: "Know Your Contract: Discipline and just cause (Article 12)", ref: "County CBA 2025–2028 · Article 12" };
const all = [nine, twelve, grievance, heat];
const titles = (answer) => compassCitedSources(answer, all).map((source) => source.id);
const PHRASINGS = [
  ["Under Article 9.2 of the County CBA 2025–2028, your regular schedule can only change with 14 calendar days' written notice unless you agree to the change.", ["kb:sched"]],
  ["Article 14 requires you to file at Step 1 within 30 calendar days of the incident. Your steward can help you write it up if needed.", ["kb:griev"]],
  ["Article 14 — Grievance Procedure requires filing a written grievance with the immediate supervisor within thirty calendar days.", ["kb:griev"]],
  ["Artículo 14 — Procedimiento de Quejas establece que la queja debe presentarse por escrito dentro de los treinta (30) días calendario.", ["kb:griev"]],
  ["Article 12 of the County CBA 2025-2028 states that an employee may request a union representative at an investigatory interview.", ["kb:disc"]],
  ["§ 9.2 requires 14 calendar days' written notice.", ["kb:sched"]],
  ["Under §9.2 your schedule needs written notice.", ["kb:sched"]],
  ["§§ 9.2–9.4 cover notice and mandatory overtime.", ["kb:sched"]],
  ["Articles 9 and 14 both apply here.", ["kb:sched", "kb:griev"]],
  ["Articles 9, 12 and 14 set the rules.", ["kb:sched", "kb:disc", "kb:griev"]],
  ["Sections 9.2-9.4 and 14.2 apply.", ["kb:sched", "kb:griev"]],
  ["Los Artículos 9 y 14 aplican.", ["kb:sched", "kb:griev"]],
  ["Las Secciones 12.1 a 14.2 lo explican.", ["kb:disc", "kb:griev"]],
  ["Articles 12 through 16 cover discipline, grievances and safety.", ["kb:disc", "kb:griev", "kb:heat"]],
  ["Art. 16 sets the heat protocol.", ["kb:heat"]],
  ["Article 140 does not exist, and neither does Section 1.", []],
];

describe("citation forms the model actually writes", () => {
  it.each(PHRASINGS)("%s", (answer, expected) => {
    expect(titles(answer)).toEqual(expected);
  });

  it("does not expand an implausible range", () => {
    expect(titles("Articles 9 to 99 were renumbered.")).toEqual(["kb:sched"]);
  });

  it("matches a short title only as a whole word, as written", () => {
    const leave = { id: "kb:leave", kind: "faq", title: "Leave", ref: "Knowledge base" };
    expect(compassCitedSources("Leave explains how to request time off.", [leave])).toEqual([leave]);
    expect(compassCitedSources("You can leave a message for your steward.", [leave])).toEqual([]);
    expect(compassCitedSources("The Leaves policy changed.", [leave])).toEqual([]);
  });
});

// A rule
// quantity right after a citation was read as another cited article. The
// gate's two answers first, then real answers that put a quantity after a
// citation (local and SAMPLE probes), in English and Spanish.
const QUANTITIES = [
  ["Under Article 9, 14 days of notice are required for schedule changes.", ["kb:sched"]],
  ["Article 9 — 14 calendar days of written notice are required for schedule changes.", ["kb:sched"]],
  ["Under Article 9.2 of the County CBA 2025–2028, your regular schedule can only change with 14 calendar days' written notice.", ["kb:sched"]],
  ["Article 9.2, 14 calendar days' written notice, unless you agree.", ["kb:sched"]],
  ["Article 14 gives you 30 days to file at Step 1.", ["kb:griev"]],
  ["Article 14 requires you to file at Step 1 within 30 calendar days of the incident.", ["kb:griev"]],
  ["Article 9, 2 mandates per pay period at most.", ["kb:sched"]],
  ["Article 9 to 14 days before the change.", ["kb:sched"]],
  ["Article 12, 12 months after a warning it comes out of your file.", ["kb:disc"]],
  ["Article 16, 15 minutes of cool-down every two hours.", ["kb:heat"]],
  ["Article 9, 14% of members were mandated.", ["kb:sched"]],
  ["Artículo 9.2, 14 días naturales de aviso por escrito.", ["kb:sched"]],
  ["Artículo 9 — 14 días de aviso por escrito.", ["kb:sched"]],
  ["Artículo 14: tienes 30 días calendario para presentar la queja.", ["kb:griev"]],
  ["Artículo 9 a 14 semanas del cambio.", ["kb:sched"]],
  ["Articles 9 and 14 of the agreement both apply.", ["kb:sched", "kb:griev"]],
];

describe("rule quantities after a citation are not citations", () => {
  it.each(QUANTITIES)("%s", (answer, expected) => {
    expect(titles(answer)).toEqual(expected);
  });
});

// A hyphenated
// quantity after a singular citation ("Article 9, 14-day notice") added
// Article 14. A singular head now takes exactly one number; only a plural
// head takes a list, and a plural list still stops at a quantity.
const SINGLE_NUMBER = [
  ["Under Article 9, 14-day written notice is required for schedule changes.", ["kb:sched"]],
  ["Article 9, 14-day notice is required.", ["kb:sched"]],
  ["Under Article 9, 14-calendar-day notice applies.", ["kb:sched"]],
  ["Article 9 requires a 14-day notice.", ["kb:sched"]],
  ["Artículo 9, aviso de 14 días.", ["kb:sched"]],
  ["Articles 9, 14-day notice is the rule.", ["kb:sched"]],
  ["Articles 9 and 14-day notice", ["kb:sched"]],
  // By design: a singular head with a list keeps only its first number.
  ["Article 9, 12 and 14 cover this.", ["kb:sched"]],
  ["Article 9-14 is not a range.", ["kb:sched"]],
  // Gate P2: an ordinary word after a plural list does not end it.
  ["Articles 9 and 14 work together to define the grievance process.", ["kb:sched", "kb:griev"]],
  ["Articles 9 and 14 full days apart.", ["kb:sched"]],
];

describe("a singular citation takes exactly one number", () => {
  it.each(SINGLE_NUMBER)("%s", (answer, expected) => {
    expect(titles(answer)).toEqual(expected);
  });
});

//  and (G3b rounds 3 and 4 on d71bbcd):
// word overlap and a shared article number are not attribution. The model
// reports the tags of the sources it relied on in a final "Used:" line; the
// server removes it and lists exactly those sources, falling back to what the
// answer names (a title, or the article a title or reference names) when the
// line is missing or names a source that was not sent.
describe("provider-reported source attribution", () => {
  const sent = (rows) => rows.map((row, index) => ({ ...row, index }));
  const handbook = { id: "kb:handbook", kind: "faq", title: "Steward handbook", ref: "Chapter library · Steward handbook" };
  const notes = { id: "kb:notes", kind: "faq", title: "Chapter meeting notes", ref: "Chapter library · Meeting notes" };
  const handbookHeat = { id: "kb:handbook-heat", kind: "faq", title: "Heat handbook", ref: "Chapter library · Heat handbook" };
  const discipline = { id: "kb:discipline", kind: "contract", title: "Know Your Contract: Discipline and just cause (Article 12)", ref: "County CBA 2025–2028 · Article 12" };
  const heatRule = { id: "kb:heat", kind: "contract", title: "Know Your Contract: Health, safety and the heat protocol (Article 16)", ref: "County CBA 2025–2028 · Article 16" };
  const schedule = { id: "kb:sched", kind: "contract", title: "Know Your Contract: Schedule changes and notice (Article 9)", ref: "County CBA 2025–2028 · Article 9" };
  const ids = (answer, rows) => {
    const { answer: text, used } = splitCompassAnswerSources(answer);
    return compassCitedSources(text, sent(rows), used).map((row) => row.id);
  };

  it("splits the Used line off the answer, and reads none, tags and malformed lines", () => {
    expect(splitCompassAnswerSources("Article 12 gives you a steward.\nUsed: S1, S3")).toEqual({ answer: "Article 12 gives you a steward.", used: [1, 3] });
    expect(splitCompassAnswerSources("No verified answer.\n\nused: none.")).toEqual({ answer: "No verified answer.", used: [] });
    expect(splitCompassAnswerSources("Article 12 applies.\nUsed: the handbook")).toEqual({ answer: "Article 12 applies.", used: null });
    expect(splitCompassAnswerSources("Article 12 applies.")).toEqual({ answer: "Article 12 applies.", used: null });
    expect(splitCompassAnswerSources(undefined)).toEqual({ answer: "", used: null });
    // The local Compass model sometimes writes the line at the end of its last
    // sentence; that counts only with well-formed tags.
    expect(splitCompassAnswerSources("El plazo es de 30 días calendario. Used: S3")).toEqual({ answer: "El plazo es de 30 días calendario.", used: [3] });
    expect(splitCompassAnswerSources("Your contract does not cover parking. Used: none")).toEqual({ answer: "Your contract does not cover parking.", used: [] });
    expect(splitCompassAnswerSources("The form is commonly used: see the guide")).toEqual({ answer: "The form is commonly used: see the guide", used: null });
    expect(splitCompassAnswerSources("Ask your steward. Used: the handbook")).toEqual({ answer: "Ask your steward. Used: the handbook", used: null });
  });

  it.each(["Used: S1", "Used: none", "Used: S9", "Used: the handbook"])("lists no sources for attribution-only output: %s", (content) => {
    const { answer, used } = splitCompassAnswerSources(content);
    expect(answer).toBe("");
    expect(compassCitedSources(answer, sent([handbook, guide]), used)).toEqual([]);
  });

  it.each([
    'Article 12 says "You may request a steward."',
    "Article 12 says “You may request a steward.”",
    "Article 12 says ‘You may request a steward.’",
    "El Artículo 12 dice «Puedes solicitar un delegado.»",
  ])("strips inline attribution after the closing quote in %s", (answer) => {
    expect(splitCompassAnswerSources(`${answer} Used: S1`)).toEqual({ answer, used: [1] });
    expect(ids(`${answer} Used: S1`, [handbook, discipline])).toEqual(["kb:handbook"]);
    expect(splitCompassAnswerSources(`${answer} Used: none`)).toEqual({ answer, used: [] });
    expect(splitCompassAnswerSources(`${answer} Used: the handbook`)).toEqual({ answer: `${answer} Used: the handbook`, used: null });
  });

  // r3s1: two generic sources; only the rule the answer used is listed.
  it("lists only the generic source the answer used, not notes that share its words (r3s1)", () => {
    const answer = "The heat handbook rule from the minutes protocol gives you a 15-minute cool-down break every two hours.";
    expect(ids(`${answer}\nUsed: S2`, [notes, handbookHeat])).toEqual(["kb:handbook-heat"]);
    // Without a Used line no generic source is listed on shared words.
    expect(ids("A 15-minute cool-down break every two hours, per the minutes protocol.", [notes, handbookHeat])).toEqual([]);
  });

  // r3s2: another source naming Article 12 never vetoes the handbook the answer used.
  it("keeps the generic handbook the answer used beside a source that names Article 12 (r3s2)", () => {
    expect(ids("Article 12 gives you the right to a steward in that meeting.\nUsed: S2", [discipline, handbook])).toEqual(["kb:handbook"]);
  });

  // r3s3: attribution does not depend on the answer's language.
  it("lists the English handbook for a faithful Spanish answer (r3s3)", () => {
    expect(ids("El Artículo 12 te da derecho a un delegado en esa reunión.\nUsed: S1", [handbook])).toEqual(["kb:handbook"]);
  });

  it("lists nothing for Used: none, even when the answer names an article", () => {
    expect(ids("Your contract does not cover schedule changes.\nUsed: none", [schedule, handbook])).toEqual([]);
  });

  it("falls back to what the answer names when a tag was not sent or the line is missing", () => {
    expect(ids("Article 16 gives you a cool-down break.\nUsed: S9", [notes, heatRule])).toEqual(["kb:heat"]);
    expect(ids("Article 16 gives you a cool-down break.", [notes, heatRule])).toEqual(["kb:heat"]);
    // The fallback never admits a generic source on an article or its words.
    expect(ids("Article 12 gives you the right to a steward.", [handbook])).toEqual([]);
    expect(ids("The Steward handbook says to ask for a steward.", [handbook])).toEqual(["kb:handbook"]);
    // A source that names its own article is never matched on another one.
    expect(ids("Article 14 gives you 30 calendar days to file.", [schedule, grievance])).toEqual(["kb:griev"]);
  });
});

describe("the question prompt for a question no source answers", () => {
  const prompt = (role) => buildGuideMessages("Can my supervisor change my schedule without notice?", { activePlanKinds: [] }, [], [], role)[0].content;

  it.each(["member", "steward"])("says so first and plainly, and names only sources that answer, for a %s", (role) => {
    expect(prompt(role)).toContain("If no source answers the question, say so first, in one plain sentence (for example, that no organizing source covers it), then ");
    expect(prompt(role)).toContain("Name only sources that answer the question; never mention or summarize a source about something else.");
    expect(prompt(role)).toContain("When a source answers the question, start with its title and its rule, with no preamble.");
    expect(prompt(role)).not.toContain("Start with the relevant source title and its rule");
    expect(prompt(role)).toContain(COMPASS_SOURCES_USED_INSTRUCTION);
  });

});
