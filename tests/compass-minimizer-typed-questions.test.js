// @vitest-environment node
// BUG-UG-COMPASS-MINIMIZER-REFUSES-ORDINARY-TYPED-QUESTIONS-20261107 .
//
// The live SAMPLE audit (L209, Nov 7, 2026) found Compass refusing ordinary
// typed questions such as "Can my supervisor change my schedule without
// notice?" with the 422 "can't send that question as written". On Main
// 1902c0f, 22 of the 45 questions first collected here were sent. Nearly every
// refusal was one everyday word outside the closed vocabulary; "will" is also
// a given name, so it is read only as a question auxiliary. Discipline-process
// and sick-leave questions stay inside the owner's kept categories except for
// a few complete general questions.
import { describe, expect, it } from "vitest";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { buildGuideMessages, compassRetrievalQuery, minimizeCompassEmbeddingSource, minimizeCompassQuestion, unchangedCompassTrainingText } from "../api/_lib/compassPrompts.js";

const MESH_ACCESS = {
  surface: "saas",
  endpoint: "https://mesh.example.invalid/v1/chat/completions",
  credentials: { apiKey: "test-mesh-bearer", accessClientId: "test-access-id", accessClientSecret: "test-access-secret" },
  provider: { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1", connector: null },
};
const payload = (messages) => JSON.parse(buildCompassGatewayRequest(messages, MESH_ACCESS).options.body);
const source = { kind: "contract", source_id: "kb:article-14", title: "Article 14 — Grievance Procedure", ref: "Contract · Article 14", snippet: "Record what happened, preserve evidence, and reach a steward without escalating risk." };

// Realistic member and steward questions: schedules, overtime and pay, leave,
// grievances, representation, the discipline process and steward next steps.
const ORDINARY = [
  "Can my supervisor change my schedule without notice?",
  "How much notice do I get before a schedule change?",
  "Can they change my shift without asking me?",
  "Do I have to work a split shift?",
  "Can I swap shifts with a coworker?",
  "Can my employer cancel my shift at the last minute?",
  "Do I get paid if my shift is cancelled?",
  "Can my supervisor make me work overtime?",
  "Can I refuse mandatory overtime?",
  "How is overtime pay calculated?",
  "When do I get overtime pay?",
  "Do I get paid for training time?",
  "What is the pay for working on a holiday?",
  "Do I get a raise when the contract is ratified?",
  "How do I request vacation time?",
  "How much vacation time do I get?",
  "Can my supervisor deny my vacation request?",
  "How many sick days do I get?",
  "Do I need a note to use sick leave?",
  "Can I use sick leave to care for my child?",
  "How do I request time off?",
  "How do I file a grievance?",
  "How long will it take?",
  "What happens after I file a grievance?",
  "What are the steps of the grievance process?",
  "Who decides a grievance?",
  "Can I file a grievance about my schedule?",
  "What is the deadline to file a grievance?",
  "What are my rights at work?",
  "Can I bring a steward to a meeting with my supervisor?",
  "Can I have a steward with me in a meeting with management?",
  "Do I have the right to a steward?",
  "Can my supervisor retaliate against me for filing a grievance?",
  "How do I contact my steward?",
  "What is progressive discipline?",
  "What is just cause?",
  "What happens in a discipline meeting?",
  "How do I open a case for a member?",
  "What should I do when a member asks for help with a grievance?",
  "How do I help a member file a grievance?",
  "What should I prepare before a grievance meeting?",
  "How do I request information from the employer?",
  "When is the next step deadline after a grievance is denied?",
  "Can I bring a steward to a meeting with my supervisor about discipline?",
  "Can I bring a steward to a discipline meeting?",
  "How does progressive discipline work?",
  "When will I hear back about my grievance?",
  "What will happen at the meeting?",
  "How much will I get paid for overtime?",
  "Who will decide my grievance?",
  "What would it take?",
];

// Held back under the October 8, 2026 rest-break decision until the owner's
// "ALLOW BREAKS" order of November 8, 2026 (11:27 AM ET,); now sent.
const ALLOWED_BY_NOVEMBER_8_DECISION = [
  "What does the contract say about breaks?",
  "Do I get a lunch break?",
];

// Names, contact details, identifying numbers and health, discipline or
// immigration specifics, built on the newly allowed words and forms.
const ADVERSARIAL = [
  "Can my supervisor Dana Ruiz change my schedule without notice?",
  "Can my coworker jane@example.com swap shifts with me?",
  "Can my employer cancel my shift at site 4471?",
  "Can my supervisor deny my vacation because of my pregnancy?",
  "Can I bring a steward to a meeting about my suspension?",
  "Can I bring a steward to a meeting with my supervisor about my discipline?",
  "Can I bring a steward to a meeting with my supervisor about discipline for Keisha Monroe?",
  "Can I bring a steward to a meeting with Dana Ruiz about discipline?",
  "Can I bring a steward to a discipline meeting on Monday at 9?",
  "Do I need a note to use sick leave for my cancer?",
  "Do I need a doctor's note to use sick leave?",
  "Can I use sick leave to care for my child who has asthma?",
  "Can I use sick leave to care for Maya?",
  "What is progressive discipline for case 4471?",
  "I have a discipline meeting tomorrow.",
  "My child is sick.",
  "My supervisor retaliated against me after my injury.",
  "Can my supervisor retaliate against me because of my visa?",
  "Can my supervisor retaliate against me because I am undocumented?",
  "Will, how long will it take?",
  "Will how long will it take?",
  "How long will Will take?",
  "How long will it take, Will?",
  "When will Will hear back?",
  "will, how long will it take?",
  "Can Will swap shifts with me?",
  "My manager Keisha Monroe denied my training.",
  "Can my supervisor make me work overtime at Harrow Bay?",
  "Was I denied overtime because of my disability?",
];

// A leave status with a
// new modifier ("on paid family leave"), a capitalized new word used as the
// first word or a vocative ("Child, can I file a grievance?"), and a
// capitalized Will inside the auxiliary form. Every one is withheld.
const GATE_ADVERSARIAL = [
  "Against, can I file a grievance?",
  "Ask, can I file a grievance?",
  "Asking, can I file a grievance?",
  "Asks, can I file a grievance?",
  "Back, can I file a grievance?",
  "Calculate, can I file a grievance?",
  "Calculated, can I file a grievance?",
  "Cancel, can I file a grievance?",
  "Canceled, can I file a grievance?",
  "Cancelled, can I file a grievance?",
  "Cancels, can I file a grievance?",
  "Can Will swap shifts with me?",
  "Care, can I file a grievance?",
  "Child, can I file a grievance?",
  "Children, can I file a grievance?",
  "Coworker, can I file a grievance?",
  "Coworkers, can I file a grievance?",
  "Decide, can I file a grievance?",
  "Decides, can I file a grievance?",
  "Denied, can I file a grievance?",
  "Denies, can I file a grievance?",
  "Deny, can I file a grievance?",
  "Family, can I file a grievance?",
  "Hear, can I file a grievance?",
  "How long Will it take?",
  "How long will it take, Will?",
  "How long will Will it take?",
  "How long will Will take?",
  "I am on family leave.",
  "I am on family mandatory leave.",
  "I am on family mandatory paid leave.",
  "I am on family paid leave.",
  "I am on family paid mandatory leave.",
  "I am on leave.",
  "I am on mandatory family leave.",
  "I am on mandatory family paid leave.",
  "I am on mandatory leave.",
  "I am on mandatory paid family leave.",
  "I am on mandatory paid leave.",
  "I am on medical leave.",
  "I am on paid family leave.",
  "I am on paid family mandatory leave.",
  "I am on paid leave.",
  "I am on paid mandatory family leave.",
  "I am on paid mandatory leave.",
  "I am suspended.",
  "Make, can I file a grievance?",
  "Makes, can I file a grievance?",
  "Manager, can I file a grievance?",
  "Managers, can I file a grievance?",
  "Mandatory, can I file a grievance?",
  "Minute, can I file a grievance?",
  "Minutes, can I file a grievance?",
  "My child has a diagnosis.",
  "My child is sick.",
  "My manager Keisha Monroe denied my training.",
  "My steward is Will it take a day?",
  "My steward is Will it take days to file a grievance?",
  "My supervisor retaliated against me after my injury.",
  "Note, can I file a grievance?",
  "Paid, can I file a grievance?",
  "Prepare, can I file a grievance?",
  "Refuse, can I file a grievance?",
  "Retaliate, can I file a grievance?",
  "Retaliation, can I file a grievance?",
  "Split, can I file a grievance?",
  "Supervisor, can I file a grievance?",
  "Supervisors, can I file a grievance?",
  "Swap, can I file a grievance?",
  "Training, can I file a grievance?",
  "When will Will hear back?",
  "will, how long will it take?",
  "Will how long will it take?",
  "Will, how long will it take?",
];

// The repairs-only final on  (G6, head fafc133): a leave status whose
// modifiers are separated by commas, "and", slashes, hyphens or extra spaces.
// The gate's twelve comma orderings first, then this lane's own variants.
const LEAVE_STATUS_SEPARATED = [
  "I am on paid, family leave.",
  "I am on paid, mandatory leave.",
  "I am on family, paid leave.",
  "I am on family, mandatory leave.",
  "I am on mandatory, paid leave.",
  "I am on mandatory, family leave.",
  "I am on paid, family, mandatory leave.",
  "I am on paid, mandatory, family leave.",
  "I am on family, paid, mandatory leave.",
  "I am on family, mandatory, paid leave.",
  "I am on mandatory, paid, family leave.",
  "I am on mandatory, family, paid leave.",
  "I am on paid and family leave.",
  "I am on paid, and family leave.",
  "I am on paid-family leave.",
  "I am on paid  ,  family leave.",
  "I am on paid; family leave.",
  "I am on paid / family leave.",
  "I'm on mandatory, paid leave.",
  "I am currently on mandatory, paid leave.",
  "I am on mandatory (paid) leave.",
  "I am on — paid — leave.",
  "On mandatory, paid leave since Monday.",
  "I am on mandatory, paid, family, and unpaid leave.",
  "I was put on mandatory, paid leave.",
];

// General leave-policy questions that use the new words still pass.
const LEAVE_POLICY = [
  "How do I request family leave?",
  "Is family leave paid?",
  "How much paid leave do I get?",
  "Do I get paid family leave?",
  "How do I request paid leave?",
  "What is mandatory leave?",
  "Can my supervisor deny my family leave request?",
  "Who decides a family leave request?",
];

describe("Compass sends ordinary typed questions unchanged", () => {
  it("covers at least thirty realistic questions", () => {
    expect(ORDINARY.length).toBeGreaterThanOrEqual(30);
    expect(ORDINARY).toContain("How long will it take?");
    expect(ORDINARY).toContain("Can my supervisor change my schedule without notice?");
    expect(ORDINARY).toContain("Can I bring a steward to a meeting with my supervisor about discipline?");
  });

  it.each(ORDINARY)("sends %s", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
    expect(compassRetrievalQuery(question)).toBe(question);
    expect(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source])).messages.at(-1)).toEqual({ role: "user", content: question });
  });

  it.each(ALLOWED_BY_NOVEMBER_8_DECISION)("sends %s under the November 8 break decision", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
  });
});

describe("the widened words and forms still withhold what the minimizer exists to block", () => {
  it.each(ADVERSARIAL)("withholds %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each(GATE_ADVERSARIAL)("withholds the gate case %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each(LEAVE_STATUS_SEPARATED)("withholds the separated leave status %s", (question) => {
    expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
  });

  it.each(LEAVE_STATUS_SEPARATED.filter((status) => status.startsWith("I am on")))("drops %s from a message that also asks an ordinary question", (status) => {
    for (const [message, sent] of [
      [`${status} How do I file a grievance?`, "[details withheld] How do I file a grievance?"],
      [`How do I file a grievance? ${status}`, "How do I file a grievance? [details withheld]"],
    ]) {
      expect(minimizeCompassQuestion(message), message).toBe(sent);
      expect(compassRetrievalQuery(message), message).toBe("How do I file a grievance?");
      expect(payload(buildGuideMessages(message, { activePlanKinds: [] }, [], [source])).messages.at(-1)).toEqual({ role: "user", content: sent });
    }
  });

  it.each(LEAVE_POLICY)("still sends the general leave-policy question %s", (question) => {
    expect(minimizeCompassQuestion(question)).toBe(question);
  });

  it("keeps the ordinary sentence and withholds a contact detail sent with it", () => {
    const question = "Can my supervisor change my schedule without notice? Call me at 555-0100.";
    expect(minimizeCompassQuestion(question)).toBe("Can my supervisor change my schedule without notice? [details withheld]");
    expect(compassRetrievalQuery(question)).toBe("Can my supervisor change my schedule without notice?");
    expect(JSON.stringify(payload(buildGuideMessages(question, { activePlanKinds: [] }, [], [source])))).not.toContain("555");
  });

  it("reads will only as a lowercase auxiliary after a question word", () => {
    for (const question of ["Will my schedule change?", "Can Will cover my shift?", "will, what can I do?"]) {
      expect(() => minimizeCompassQuestion(question), question).toThrow("Compass minimization failed");
    }
  });

  it("widens the member question only: training and source text keep the stricter rules", () => {
    for (const question of ORDINARY.filter((item) => /supervisor|paid|cancel|will |sick leave/u.test(item))) {
      expect(unchangedCompassTrainingText(question, 1200), question).toBeNull();
      expect(() => minimizeCompassEmbeddingSource(question), question).toThrow("Compass minimization failed");
    }
  });
});
