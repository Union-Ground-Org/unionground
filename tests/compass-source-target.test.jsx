import { describe, expect, it } from "vitest";
import { CitedCompassArticle } from "../src/features/compass/CitedCompassArticle.jsx";
import { compassArticleForFocus, compassSourceTarget } from "../src/features/compass/compassSourceTarget.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { render, screen } from "@testing-library/react";

const articles = [
  { slug: "discipline-just-cause", title: "Discipline requires just cause", title_es: "La disciplina requiere causa justa", body: "Just cause.", body_es: "Causa justa.", ref: "PREVIEW · Contract · Article 12" },
  { slug: "weingarten-rights", title: "Your Weingarten rights", title_es: "Tus derechos Weingarten", body: "Ask for a steward.", body_es: "Pide un delegado.", ref: "PREVIEW · Know your rights" },
  { id: "faq-row", slug: "grievance-deadlines", title: "How long do I have to file a grievance?", body: "21 days." },
];

describe("compassSourceTarget", () => {
  it("does not link a contract citation to the omitted Contract clauses workspace", () => {
    expect(compassSourceTarget({ id: "kb:discipline-just-cause", kind: "Contract Clause" }, articles)).toBeNull();
  });

  it("maps rights, faq and knowledge kinds onto Know your rights", () => {
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "rights" }, articles).path).toBe("/m/rights");
    expect(compassSourceTarget({ id: "faq-row", kind: "faq" }, articles).focus.slug).toBe("grievance-deadlines");
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "knowledge_article" }, articles).view).toBe("rights");
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "resource" }, articles).view).toBe("rights");
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "article" }, articles).view).toBe("rights");
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "knowledge" }, articles).view).toBe("rights");
  });

  it("returns null when the source has no viewable record", () => {
    expect(compassSourceTarget({ id: "resolved-telework", kind: "case" }, articles)).toBeNull();
    expect(compassSourceTarget({ id: "kb:missing", kind: "contract" }, articles)).toBeNull();
    expect(compassSourceTarget({ kind: "contract", title: "No id" }, articles)).toBeNull();
    expect(compassSourceTarget({ id: "weingarten-rights", kind: "rights" }, null)).toBeNull();
    expect(compassSourceTarget(null, articles)).toBeNull();
  });

  it("finds the same article from a citation focus", () => {
    const focus = { compassSource: true, sourceId: "kb:weingarten-rights", slug: "weingarten-rights", view: "rights" };
    expect(compassArticleForFocus(articles, focus).slug).toBe("weingarten-rights");
    expect(compassArticleForFocus(articles, { compassSource: true, slug: "discipline-just-cause" }).slug).toBe("discipline-just-cause");
    expect(compassArticleForFocus(articles, { view: "rights" })).toBeNull();
    expect(compassArticleForFocus(articles, { compassSource: true })).toBeNull();
    expect(compassArticleForFocus(null, focus)).toBeNull();
  });
});

describe("CitedCompassArticle", () => {
  it.each([
    ["en", "Your Weingarten rights", "Ask for a steward."],
    ["es", "Tus derechos Weingarten", "Pide un delegado."],
  ])("shows the viewer's article in %s", (lang, title, body) => {
    render(<LanguageProvider lang={lang}><CitedCompassArticle article={articles[1]} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByText("PREVIEW · Know your rights")).toBeInTheDocument();
  });

  it("renders nothing without an article or without text", () => {
    const { container, rerender } = render(<LanguageProvider lang="en"><CitedCompassArticle /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
    rerender(<LanguageProvider lang="en"><CitedCompassArticle article={{ slug: "empty" }} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });
});
