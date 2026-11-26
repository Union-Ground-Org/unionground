// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030 (#6562):
// renaming "campaign" and "worksite" changes every title, button, menu and
// message, not only the menu labels, and never rewrites a member's own text.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider, TERM_LABEL_KEYS, termRules, translateWithTerms, useLang } from "../src/lib/LanguageContext.jsx";

function Probe({ k, vars }) {
  const { t } = useLang();
  return <p data-testid="probe">{t(k, vars)}</p>;
}

const say = (lang, overrides, key, vars) => translateWithTerms(lang, key, vars, termRules(lang, overrides));

describe("organization terms", () => {
  it("renames the chapter and worksite words inside catalogue strings, keeping each word's case", () => {
    const overrides = { "term.chapter": "Shop", "term.worksite": "garage" };
    expect(say("en", overrides, "unions.setup.addRow")).toBe("Add a shop or office");
    expect(say("en", overrides, "admin.noChapterYet.link")).toBe("Add a shop in Organization & shops");
    expect(say("en", overrides, "units.chapter")).toBe("Shop");
    expect(say("en", overrides, "units.sub")).toBe("Garages, crews, departments and garages inside a shop. They stay inside their shop and are not new shops.");
  });

  it("uses a saved plural over the singular plus s, and keeps an acronym's capitals", () => {
    expect(say("en", { "term.chapter": "Bargaining unit", "term.chapters": "Bargaining units" }, "analytics.insightPositive.attendance_vs_cases"))
      .toBe("Bargaining units with higher attendance also carry more open issues.");
    expect(say("en", { "term.chapter": "DCF office" }, "admin.noChapterYet.link")).toBe("Add a DCF office in Organization & DCF offices");
  });

  it("never rewrites a member's own text passed into a string", () => {
    const text = say("en", { "term.chapter": "Shop" }, "admin.chapterLifecycle.memberContext", { chapter: "Worcester Chapter", roles: "Steward" });
    expect(text).toContain("Worcester Chapter");
    expect(text).toMatch(/^Home shop: Worcester Chapter/);
  });

  it("renames in one pass, so one renamed word is never renamed again by another", () => {
    const overrides = { "term.chapter": "Worksite", "term.worksite": "Garage" };
    expect(say("en", overrides, "units.chapter")).toBe("Worksite");
    expect(say("en", overrides, "units.kind.worksite")).toBe("Garage");
    expect(say("en", { "term.chapter": "Worksite", "term.worksite": "Depot" }, "units.chapter")).toBe("Worksite");
    expect(say("en", { "term.chapter": "Worksite", "term.worksite": "Depot" }, "units.sub")).toBe("Garages, crews, departments and depots inside a worksite. They stay inside their worksite and are not new worksites.");
  });

  it("leaves text outside the catalogue (organization-authored form titles and labels) exactly as written", () => {
    expect(say("en", { "term.chapter": "Shop" }, "Chapter dues authorization")).toBe("Chapter dues authorization");
    expect(say("en", { "term.chapter": "Shop" }, "Boston Chapter contact")).toBe("Boston Chapter contact");
    expect(say("es", { "term.chapter": "Taller" }, "Formulario del capítulo")).toBe("Formulario del capítulo");
  });

  it("renames the Spanish word too", () => {
    expect(say("es", { "term.chapter": "Taller" }, "units.chapter")).toBe("Taller");
    // The edition's Spanish noun is feminine ("una campaña") and the renamer swaps
    // nouns, not articles, so the check is that the noun itself is renamed.
    expect(say("es", { "term.chapter": "Taller" }, "units.sub")).toContain("taller");
    expect(say("es", { "term.chapter": "Taller" }, "units.sub")).not.toContain("campaña");
  });

  it("keeps a missing var missing, leaves non-catalogue text alone in any language, and keeps an unmapped word", () => {
    const rules = termRules("en", { "term.chapter": "Shop" });
    // A null var is not swapped for a sentinel, so nothing of one leaks out.
    const text = translateWithTerms("en", "admin.chapterLifecycle.memberContext", { chapter: null, roles: "Steward" }, rules);
    expect(text).toContain("Steward");
    expect(text).not.toMatch(/[\uE000\uE001]/u);
    // Organization text stays verbatim in Spanish and in a language with no
    // catalogue of its own.
    expect(say("es", { "term.chapter": "Taller" }, "Worcester chapter grievance form")).toBe("Worcester chapter grievance form");
    expect(say("fr", { "term.chapter": "Atelier" }, "Worcester chapter grievance form")).toBe("Worcester chapter grievance form");
    // The replacer keeps a word its rule set does not map.
    expect(rules[0].replace("Garage")).toBe("Garage");
  });

  it("ignores values outside the word rule and leaves the term keys themselves alone", () => {
    expect(termRules("en", { "term.chapter": "<b>x</b>" })).toEqual([]);
    expect(termRules("en", { "term.chapter": "Shop" })).toHaveLength(1);
    expect(termRules("en", { "term.chapter": "" })).toEqual([]);
    expect(say("en", { "term.chapter": "Shop" }, "term.chapter")).toBe("campaign");
    expect(TERM_LABEL_KEYS).toEqual(["term.chapter", "term.chapters", "term.worksite", "term.worksites"]);
  });

  it("applies through the provider while explicit menu labels still win", () => {
    const { rerender } = render(<LanguageProvider lang="en" labelOverrides={{ "term.chapter": "Local" }}><Probe k="units.chapter" /></LanguageProvider>);
    expect(screen.getByTestId("probe")).toHaveTextContent("Local");
    rerender(<LanguageProvider lang="en" labelOverrides={{ "term.chapter": "Local", "nav.myChapter": "My hall" }}><Probe k="nav.myChapter" /></LanguageProvider>);
    expect(screen.getByTestId("probe")).toHaveTextContent("My hall");
  });
});
