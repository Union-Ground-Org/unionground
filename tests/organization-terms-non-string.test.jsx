// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030 (#6562):
// translateWithTerms renames only text. A catalogue entry that is not a string
// (none ships today) comes back untouched rather than failing on .replace. The
// catalogue is mocked for this file alone, so the entry exists only here.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/i18n.js", async (importOriginal) => {
  const actual = await importOriginal();
  const list = ["Chapter one", "Chapter two"];
  return {
    ...actual,
    catalogue: { ...actual.catalogue, en: { ...actual.catalogue.en, "test.chapterList": list } },
    t: (lang, key, vars) => (key === "test.chapterList" ? list : actual.t(lang, key, vars)),
  };
});

const { termRules, translateWithTerms } = await import("../src/lib/LanguageContext.jsx");

describe("organization terms on a non-string catalogue entry", () => {
  it("returns the entry as it is, unrenamed", () => {
    const rules = termRules("en", { "term.chapter": "Shop" });
    expect(rules).toHaveLength(1);
    expect(translateWithTerms("en", "test.chapterList", undefined, rules)).toEqual(["Chapter one", "Chapter two"]);
    expect(translateWithTerms("en", "units.chapter", undefined, rules)).toBe("Shop");
  });
});
