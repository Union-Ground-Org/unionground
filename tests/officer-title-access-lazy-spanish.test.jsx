// REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030,
// r1s1 on: production loads the Spanish catalogue on demand, so in a
// fresh English session every Spanish lookup answers in English. The catalogue
// is mocked that way for this file alone (tests/setup.js registers Spanish
// eagerly), and the Spanish title "Presidente/a" must still read as a title.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/i18n.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, t: (_lang, key, vars) => actual.t("en", key, vars) };
});

const { leadershipRoleLine, titleOnlyRole } = await import("../src/lib/chapterLeadership.js");
const { t } = await import("../src/lib/i18n.js");

describe("role titles in an English session with Spanish not loaded", () => {
  it("still recognizes the Spanish President and administrator titles", () => {
    expect(t("es", "settings.leadershipPresident")).toBe("Chapter lead");
    const titled = { id: "u-ana", name: "Ana", title: "Presidente/a", president: false, administrator: false, organizationAdministrator: false };
    expect(titleOnlyRole(titled)).toBe("president");
    expect(titleOnlyRole({ ...titled, title: "Administrador/a del capítulo" })).toBe("administrator");
    expect(leadershipRoleLine(titled, (key, vars) => t("en", key, vars))).toBe("Presidente/a · title only, no access");
  });
});
