import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";
import { quorumTurnoutText } from "../src/lib/quorumTurnout.js";

// BUG-UG-VOTE-TURNOUT-READS-IMPOSSIBLE-20261106: the quorum target is
// not the number of eligible voters, so "68 of 40 voted" read as impossible.
describe("quorumTurnoutText", () => {
  const en = (key, vars) => t("en", key, vars);
  it("names the votes still needed below quorum", () => {
    expect(quorumTurnoutText(en, { totalVotes: 12, quorumTarget: 40 })).toBe("12 of 40 votes needed for quorum");
  });
  it("says quorum was reached at or past the target instead of an impossible ratio", () => {
    expect(quorumTurnoutText(en, { totalVotes: 68, quorumTarget: 40 })).toBe("Quorum reached: 68 votes, 40 needed");
    expect(quorumTurnoutText(en, { totalVotes: 40, quorumTarget: 40 })).toBe("Quorum reached: 40 votes, 40 needed");
    expect(quorumTurnoutText(en, { totalVotes: 538, quorumTarget: 300 })).not.toMatch(/538 of 300/);
  });
  it("treats a missing quorum or non-numeric counts as zero instead of printing NaN", () => {
    expect(quorumTurnoutText(en, undefined)).toBe("Quorum reached: 0 votes, 0 needed");
    expect(quorumTurnoutText(en, null)).toBe("Quorum reached: 0 votes, 0 needed");
    expect(quorumTurnoutText(en, { totalVotes: "n/a", quorumTarget: 40 })).toBe("0 of 40 votes needed for quorum");
    expect(quorumTurnoutText(en, { totalVotes: 12 })).toBe("Quorum reached: 12 votes, 0 needed");
  });

  it("counts a zero target as reached and passes numeric strings through", () => {
    expect(quorumTurnoutText(en, { totalVotes: 0, quorumTarget: 0 })).toBe("Quorum reached: 0 votes, 0 needed");
    expect(quorumTurnoutText(en, { totalVotes: "7", quorumTarget: "10" })).toBe("7 of 10 votes needed for quorum");
  });

  it("reads Spanish from its own table", async () => {
    const { loadLanguage } = await import("../src/lib/i18n.js");
    await loadLanguage("es");
    expect(quorumTurnoutText((key, vars) => t("es", key, vars), { totalVotes: 68, quorumTarget: 40 }))
      .toBe("Quórum alcanzado: 68 votos, se necesitaban 40");
  });
});
