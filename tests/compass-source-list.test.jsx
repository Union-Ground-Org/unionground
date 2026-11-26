// UX-UG-COMPASS-WEB-SOURCES-ONE-CLUTTERED-LINE-20261108 (#7462).
//
// The live demo printed an answer's sources as one uppercase run:
// "SOURCES · WEINGARTEN RIGHTS · ARTICLE 12, COUNTY CBA 2025-2028 · ARTICLE 16,
// COUNTY CBA 2025-2028 · ARTICLE 12". They are a labelled list now: one row per
// source, its title and the article it cites, in the order Compass returned.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompassSourceList, compassSourceRows } from "../src/features/compass/CompassSourceList.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

const rows = (sources) => compassSourceRows(sources).map(({ name, reference }) => [name, reference]);

describe("compassSourceRows", () => {
  it("turns the audit's sources into titles with their article, without the repeated agreement name", () => {
    expect(rows([
      { id: "kb:a", kind: "faq", title: "Weingarten rights", ref: "Weingarten rights · Article 12" },
      { id: "kb:b", kind: "contract", title: "Know Your Contract: Seniority and shift bids", ref: "County CBA 2025-2028 · Article 16" },
      { id: "kb:c", kind: "contract", title: "Know Your Contract: Investigatory meetings", ref: "County CBA 2025-2028 · Article 12" },
    ])).toEqual([
      ["Weingarten rights", "Article 12"],
      ["Know Your Contract: Seniority and shift bids", "Article 16"],
      ["Know Your Contract: Investigatory meetings", "Article 12"],
    ]);
  });

  it("does not repeat a citation the title already names", () => {
    expect(rows([{ title: "Know Your Contract: The grievance procedure (Article 14)", ref: "County CBA 2025-2028 · Article 14" }]))
      .toEqual([["Know Your Contract: The grievance procedure (Article 14)", ""]]);
  });

  it("shows a reference without a citation whole, and a source without a title by its reference", () => {
    expect(rows([{ title: "How do I file a grievance?", ref: "Knowledge base" }, { ref: "Contract · Article 12" }, { title: "Union Ground guide: Open a case", ref: "" }]))
      .toEqual([["How do I file a grievance?", "Knowledge base"], ["Contract · Article 12", ""], ["Union Ground guide: Open a case", ""]]);
  });

  it("keeps the demo's PREVIEW marker on every fixture row", () => {
    expect(rows([{ title: "How long do I have to file a grievance?", ref: "PREVIEW · Contract · Article 5" }, { title: "Contract", ref: "PREVIEW · Contract" }]))
      .toEqual([["How long do I have to file a grievance?", "PREVIEW · Article 5"], ["Contract", "PREVIEW"]]);
  });

  it("keeps the order, drops exact repeats and empty rows, and tolerates a missing list", () => {
    expect(rows([{ title: "B", ref: "Article 2" }, { title: "A", ref: "Article 1" }, { title: "B", ref: "Article 2" }, { title: "", ref: "" }, null]))
      .toEqual([["B", "Article 2"], ["A", "Article 1"]]);
    expect(compassSourceRows(undefined)).toEqual([]);
  });
});

describe("CompassSourceList", () => {
  it.each(["en", "es"])("renders a list labelled with the localized sources label under lang=%s", (lang) => {
    render(<LanguageProvider lang={lang}><CompassSourceList sources={[{ title: "Weingarten rights", ref: "County CBA 2025-2028 · Article 12" }]} /></LanguageProvider>);
    const list = screen.getByRole("list", { name: t(lang, "compass.sourcesLabel") });
    const [item] = within(list).getAllByRole("listitem");
    expect([...item.children].map((part) => part.textContent)).toEqual(["Weingarten rights", "Article 12"]);
  });

  it("renders nothing without sources", () => {
    const { container } = render(<LanguageProvider lang="en"><CompassSourceList sources={[]} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  // Contract articles are left out of this edition, so a contract citation
  // stays text; a rights article the viewer holds opens on the rights page.
  it("opens a rights article the viewer holds and leaves contract and case citations as text", () => {
    const onOpen = vi.fn();
    const articles = [
      { slug: "weingarten-rights", kind: "rights", title: "Weingarten rights" },
      { slug: "discipline-just-cause", kind: "contract", title: "Discipline requires just cause" },
    ];
    render(<LanguageProvider lang="en"><CompassSourceList articles={articles} onOpen={onOpen} sources={[
      { id: "kb:weingarten-rights", kind: "rights", title: "Weingarten rights", ref: "PREVIEW · Know your rights" },
      { id: "kb:discipline-just-cause", kind: "contract", title: "Discipline requires just cause", ref: "PREVIEW · Contract · Article 12" },
      { id: "resolved-telework", kind: "case", title: "Telework schedule restored", ref: "PREVIEW · TW-14" },
      { id: "kb:missing", kind: "rights", title: "Not on file", ref: "Article 99" },
    ]} /></LanguageProvider>);
    const open = screen.getByRole("button", { name: /Weingarten rights/ });
    expect(open).toHaveAccessibleName(/Weingarten rights/);
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      view: "rights",
      path: "/m/rights",
      focus: expect.objectContaining({ compassSource: true, slug: "weingarten-rights", sourceId: "kb:weingarten-rights" }),
    }));
    expect(screen.queryByRole("button", { name: /Discipline requires just cause/ })).toBeNull();
    expect(screen.getByText("Discipline requires just cause")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Telework schedule restored/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Not on file/ })).toBeNull();
    expect(screen.getByText("Telework schedule restored")).toBeInTheDocument();
  });
});
