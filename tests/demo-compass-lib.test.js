import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { demoCompassAnswer } from "../src/lib/demoCompass.js";
import { t } from "../src/lib/i18n.js";

// The demo Guide brain composes answers from explicitly marked PREVIEW
// fixtures — it never authors or presents organizing guidance as
// authoritative. These tests pin that boundary: every KB answer must
// CONTAIN its fixture body verbatim, so a later "make the demo answers nicer"
// pass that paraphrases (and thereby invents) legal or organizing facts fails
// here.
describe("demoCompassAnswer", () => {
  const kbRefs = new Set(fallbackData.kbArticles.map((article) => article.ref));
  const article = (slug) => fallbackData.kbArticles.find((entry) => entry.slug === slug);

  it("marks every fixture and citation as preview content", () => {
    expect(fallbackData.kbArticles.every((entry) => entry.preview === true)).toBe(true);
    const { answer, sources } = demoCompassAnswer(t("en", "compass.chipGrievance"), fallbackData, "en");
    expect(answer).toMatch(/^PREVIEW — fictional demo content/);
    expect(answer).toContain("PREVIEW");
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.preview === true && source.ref.startsWith("PREVIEW · "))).toBe(true);
  });

  it("answers each suggested chip, in both locales, from the organizing fixtures", () => {
    const expected = {
      "compass.chipDiscipline": ["supervisor-questions", "section-7-concerted-activity"],
      "compass.chipGrievance": ["captive-meeting"],
      "compass.chipTelework": ["cards-and-recognition"],
    };
    for (const lang of ["en", "es"]) {
      for (const [key, slugs] of Object.entries(expected)) {
        const { answer, sources } = demoCompassAnswer(t(lang, key), fallbackData, lang);
        expect(sources.map((source) => source.id), `${lang} ${key}`).toEqual(slugs);
        for (const source of sources) expect(kbRefs.has(source.ref)).toBe(true);
        for (const slug of slugs) {
          expect(answer).toContain(lang === "es" ? article(slug).body_es : article(slug).body);
        }
        expect(answer).toContain(lang === "en" ? "PREVIEW" : "VISTA PREVIA");
      }
    }
    // A card majority is never presented as recognition.
    expect(demoCompassAnswer(t("en", "compass.chipTelework"), fallbackData, "en").answer).toContain("A card majority is not certification");
  });

  it("answers no chip with Union Ground's grievance, discipline or telework fixtures", () => {
    for (const lang of ["en", "es"]) {
      for (const key of ["compass.chipDiscipline", "compass.chipGrievance", "compass.chipTelework"]) {
        const { answer, sources } = demoCompassAnswer(t(lang, key), fallbackData, lang);
        expect(answer).not.toMatch(/grievance|queja formal|Weingarten|just cause|Article \d|telework|teletrabajo/i);
        expect(sources.every((source) => !/Contract|GR-/.test(source.ref))).toBe(true);
      }
    }
  });

  it("quotes the fixture body verbatim for every KB-grounded answer", () => {
    for (const entry of fallbackData.kbArticles) {
      const { answer } = demoCompassAnswer(entry.title, fallbackData, "en");
      expect(answer).toContain(entry.body);
    }
  });

  it("quotes the Spanish fixture body and title with Spanish selected, retaining source identity", () => {
    for (const entry of fallbackData.kbArticles) {
      const { answer, sources } = demoCompassAnswer(entry.title_es, fallbackData, "es");
      expect(answer).toContain(entry.body_es);
      expect(answer).not.toContain(entry.body);
      expect(sources).toContainEqual(expect.objectContaining({ id: entry.slug, title: entry.title_es, ref: entry.ref, preview: true }));
    }
  });

  it("keeps an untranslated fixture verbatim instead of inventing a translation", () => {
    for (const [key, slug] of [["compass.chipGrievance", "captive-meeting"], ["compass.chipTelework", "cards-and-recognition"]]) {
      const untranslated = { ...article(slug) };
      delete untranslated.title_es;
      delete untranslated.body_es;
      const data = { ...fallbackData, kbArticles: [untranslated] };
      const { answer, sources } = demoCompassAnswer(t("es", key), data, "es");
      expect(answer).toContain(untranslated.body);
      expect(sources[0].title).toBe(untranslated.title);
    }
  });

  it("falls back to keyword matching for free-text questions", () => {
    const supervisor = demoCompassAnswer("what can my supervisor ask about the card I signed", fallbackData, "en");
    expect(supervisor.sources[0].ref).toBe("PREVIEW · Organizing rights · supervisor questions");
    const cards = demoCompassAnswer("does a card majority mean we won recognition", fallbackData, "en");
    expect(cards.sources[0].id).toBe("cards-and-recognition");
    const captive = demoCompassAnswer("do I have to speak in a captive meeting", fallbackData, "en");
    expect(captive.sources[0].id).toBe("captive-meeting");
  });

  it("invents no telework rule or record the preview does not carry", () => {
    const { answer, sources } = demoCompassAnswer("Can I keep my remote telework schedule?", fallbackData, "en");
    expect(answer).toBe(t("en", "compass.demoNoMatch"));
    expect(sources).toEqual([]);
  });

  it("admits it has no source rather than inventing one", () => {
    const { answer, sources } = demoCompassAnswer("zxqv flurble", fallbackData, "en");
    expect(answer).toBe(t("en", "compass.demoNoMatch"));
    expect(sources).toEqual([]);
  });

  it.each(["¿Cuánto tiempo tengo de vacaciones?", "¿Cuánto tiempo tengo para solicitar vacaciones?"])("does not ground Spanish question scaffolding in a fixture: %s", (question) => {
    expect(demoCompassAnswer(question, fallbackData, "es")).toEqual({ answer: t("es", "compass.demoNoMatch"), sources: [] });
  });

  it("grounds Spanish free text in the cards fixture through its chip's own words", () => {
    const result = demoCompassAnswer("¿Una mayoría de tarjetas significa reconocimiento?", fallbackData, "es");
    expect(result.sources[0].id).toBe("cards-and-recognition");
    expect(result.answer).toContain(article("cards-and-recognition").body_es);
    expect(result.answer).not.toContain(article("cards-and-recognition").body);
  });

  it("refuses a question that shares only scaffolding and one word with an article", () => {
    // "card" alone is not grounding: quoting the card fixture at a payment
    // card question would be fabricated applicability.
    for (const question of ["How do I file for unemployment?", "Where is my credit card?"]) {
      const { answer, sources } = demoCompassAnswer(question, fallbackData, "en");
      expect(answer, question).toBe(t("en", "compass.demoNoMatch"));
      expect(sources).toEqual([]);
    }
  });

  it("never throws on missing fixture slices", () => {
    expect(demoCompassAnswer("anything", {}, "en").sources).toEqual([]);
    const noArticles = { ...fallbackData, kbArticles: [], cases: [], forms: [] };
    const result = demoCompassAnswer(t("en", "compass.chipTelework"), noArticles, "en");
    expect(result.answer).toBe(t("en", "compass.demoNoMatch"));
  });
});
