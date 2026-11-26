// @vitest-environment node
// UX-UG-COMPASS-STEWARD-ANSWER-SAYS-CONTACT-YOUR-STEWARD-20261107 (#7434).
//
// On the SAMPLE demo the steward persona asked "How long do I have to file a
// grievance?" and the answer closed "You should contact your steward". The
// question prompt framed every reader as a member. A staff reader now gets the
// next step for that role; a member, or any role the server did not read,
// keeps the member prompt exactly.
import { describe, expect, it } from "vitest";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { buildGuideMessages, compassNoSourceAnswer, compassReaderRole } from "../api/_lib/compassPrompts.js";

const MESH_ACCESS = {
  surface: "saas",
  endpoint: "https://mesh.example.invalid/v1/chat/completions",
  credentials: { apiKey: "test-mesh-bearer", accessClientId: "test-access-id", accessClientSecret: "test-access-secret" },
  provider: { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1", connector: null },
};
const outbound = (messages) => JSON.parse(buildCompassGatewayRequest(messages, MESH_ACCESS).options.body);
const source = { kind: "contract", source_id: "kb:article-14", title: "Article 14 — Grievance Procedure", ref: "Contract · Article 14", snippet: "Record what happened, preserve evidence, and reach a steward without escalating risk." };
const QUESTION = "How long do I have to file a grievance?";
const system = (role, question = QUESTION) => outbound(buildGuideMessages(question, { activePlanKinds: [] }, [], [source], role)).messages[0].content;

// This edition's worker referrals name a campaign committee member.
const MEMBER_REFERRALS = [
  "beyond a brief committee member referral.",
  "point the worker to the closest portal area or a campaign committee member.",
  "an optional brief committee member referral.",
  "recommend contacting a campaign committee member for urgent, disciplinary, safety, deadline, or fact-specific issues.",
];
const STAFF = [
  ["steward", "committee member", "open or update the worker's issue on the Committee desk, or bring it to a campaign lead", "Escritorio del comité"],
  ["coordinator", "coordinator", "assign or review the case on the Coordinator desk", "Cola de asuntos"],
  ["advisor", "advisor", "review the case on the Advisor desk or raise it with a coordinator", "Escritorio de asesoría"],
  ["admin", "administrator", "raise it with a coordinator or check the organization's settings in Administration", "Administración"],
  ["vp", "vice president", "review it on the Vice president overview or raise it with a coordinator", "Resumen de la vicepresidencia"],
];

describe("Compass question answers follow the reader's role", () => {

  it.each(STAFF)("tells a %s reader the next step for that role, never to contact a steward", (role, label, nextStep, spanishPage) => {
    const prompt = system(role);
    const article = /^[aeiou]/u.test(label) ? "an" : "a";
    expect(compassReaderRole(role)).toBe(role);
    expect(prompt).toContain(`The reader is ${article} ${label} in this organization, the person members contact for help`);
    expect(prompt).toContain("Never tell them to contact a steward, their steward or a chapter steward, in any language.");
    expect(prompt).toContain(`When a next step helps, give this one: ${nextStep}.`);
    expect(prompt).toContain(` page is called ${spanishPage}.`);
    expect(prompt).toContain(`beyond one brief next step for ${article} ${label}.`);
    expect(prompt).toContain(`an optional brief next step for ${article} ${label}.`);
    expect(prompt).toContain(`give the next step for ${article} ${label}.`);
    for (const referral of MEMBER_REFERRALS) expect(prompt).not.toContain(referral);
  });

  it("frames a Spanish question the same way, since the model answers in the question's language", () => {
    const question = "¿Cuántos días tengo para presentar una queja?";
    expect(system("steward", question)).toContain("Never tell them to contact a steward, their steward or a chapter steward, in any language.");
    expect(system("member", question)).toContain("recommend contacting a campaign committee member");
  });

  it("changes only the referral lines and adds no personal data", () => {
    const member = system("member").split("\n");
    const steward = system("steward").split("\n");
    const added = steward.filter((line) => !member.includes(line));
    const removed = member.filter((line) => !steward.includes(line));
    expect(removed).toHaveLength(4);
    expect(added).toHaveLength(5);
    // The only new fact is the role label; no name, id, organization or case.
    for (const line of added) expect(line).not.toMatch(/[0-9]|@|Tamarack|Dylan|Kowalski/u);
    // The question itself and the grounding are unchanged.
    const messages = outbound(buildGuideMessages(QUESTION, { activePlanKinds: [] }, [], [source], "steward")).messages;
    expect(messages.at(-1)).toEqual({ role: "user", content: QUESTION });
    expect(messages[0].content).toContain(source.snippet);
  });

  it("gives the grounding gate's no-source reply for the same role", () => {
    const member = "I don't have a verified source for that question, so I won't guess. Contact your campaign committee member for the current agreement or approved guidance.";
    for (const role of [undefined, "member", "owner", "Steward"]) expect(compassNoSourceAnswer(role)).toBe(member);
    for (const [role] of STAFF) {
      expect(compassNoSourceAnswer(role)).toBe("I don't have a verified source for that question, so I won't guess. Check the current agreement or the organization's approved guidance before advising a member.");
      expect(compassNoSourceAnswer(role)).not.toMatch(/steward/iu);
    }
  });
});
