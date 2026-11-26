import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { MEMBER_FEATURES } from "../src/features/onboardingGuideEngine/memberLayers.js";

// BUG-UG-EVENTS-GUIDE-REPEATS-VOTING-NEVER-20261106: the Events
// page guide listed the Voting page's Never line ("Need to tell anyone how you
// voted."). Events carries the member rule the other member pages use, and the
// Site guide list's filler line reads as product copy.
describe("member guide copy", () => {
  it("gives Events a Never line that is true on Events", () => {
    const events = MEMBER_FEATURES.find((entry) => entry.feature === "events");
    expect(events.never).toEqual(["guideEngine.fg.member.neverPost"]);
    expect(events.never).not.toContain("guideEngine.fg.member.neverVote");
    // Voting keeps its own line.
    expect(MEMBER_FEATURES.find((entry) => entry.feature === "ballots").never).toEqual(["guideEngine.fg.member.neverVote"]);
  });

  it("words the Site guide list's other-feature line as product copy", () => {
    expect(catalogue.en["guideEngine.why.r36.rest"]).toBe("Another page you can use.");
    expect(catalogue.es["guideEngine.why.r36.rest"]).toBe("Otra página que puedes usar.");
    for (const lang of ["en", "es"]) expect(catalogue[lang]["guideEngine.why.r36.rest"]).not.toMatch(/role|rol\b/i);
  });
});
