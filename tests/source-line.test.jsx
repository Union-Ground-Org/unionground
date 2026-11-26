// REQ-UG-PROVENANCE-CONTRACT-20261012: the source line under every
// sourced figure or document, web side, and the shared model it renders.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceLine } from "../src/components/SourceLine.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { sourceLineCatalogue, sourceLineT } from "../src/lib/i18n/sourceLine.js";
import { SOURCE_LINE_TIME_ZONE, formatRetrievedDate, sourceLineModel } from "../src/lib/sourceLine.js";
import { stamp } from "../scripts/lib/provenance.mjs";

// 03:30 UTC on October 12 is 11:30 PM on October 11 in Eastern time, so the
// rendered date proves the conversion rather than echoing the UTC date.
const decision = stamp({
  bytes: "decision bytes",
  source: { url: "https://www.mass.gov/dlr/decisions/example", publisher: "Massachusetts Department of Labor Relations", title: "Decision example" },
  retrievedAt: "2026-10-12T03:30:00Z",
  capture: { method: "http-get" },
  asOf: "2026-03-14",
});
const payroll = "example-org/example-data@0123abc:data/pay.csv";
const computed = stamp({
  bytes: "42",
  source: { url: "https://github.com/example-org/example-repo/blob/main/scripts/example.mjs", publisher: "Union Ground analysis" },
  retrievedAt: "2026-10-12T05:00:00Z",
  capture: { method: "computed" },
  extraction: { method: "script", extractor: "scripts/example.mjs@1" },
  asOf: "2026-03-14",
  derivedFrom: [decision.provenance_id, payroll],
});

describe("sourceLineModel", () => {
  it("shows the publisher, the captured URL and the retrieval date in Eastern time", () => {
    expect(SOURCE_LINE_TIME_ZONE).toBe("America/New_York");
    expect(sourceLineModel(decision)).toEqual({
      publisher: "Massachusetts Department of Labor Relations",
      href: "https://www.mass.gov/dlr/decisions/example",
      title: "Decision example",
      retrieved: "Oct 11, 2026",
      inputs: [],
    });
    expect(formatRetrievedDate("2026-10-12T03:30:00Z", "es")).toBe("11 oct 2026");
  });

  it("lists a computed value's inputs, by record where it has one and by reference where not", () => {
    const model = sourceLineModel(computed, { inputs: [decision] });
    expect(model.inputs).toEqual([
      { key: decision.provenance_id, publisher: "Massachusetts Department of Labor Relations", href: "https://www.mass.gov/dlr/decisions/example", title: "Decision example", retrieved: "Oct 11, 2026" },
      { key: payroll, reference: payroll },
    ]);
  });

  it("refuses what it cannot show honestly", () => {
    for (const record of [
      null,
      { ...decision, source: { ...decision.source, url: "javascript:alert(1)" } },
      { ...decision, source: { ...decision.source, publisher: " " } },
      { ...decision, retrieved_at: "2026-10-12" },
      { ...decision, retrieved_at: "2026-02-30T03:30:00Z" },
      { ...decision, source: { ...decision.source, url: ` ${decision.source.url}` } },
      { ...decision, source: { ...decision.source, url: "https://user:pw@www.mass.gov/x" } },
      { ...decision, provenance_id: undefined },
      { ...decision, content_sha256: "ABC" },
      { ...decision, review: {} },
    ]) expect(sourceLineModel(record)).toBeNull();
  });
});

describe("SourceLine", () => {
  it("renders the source line with a link that opens the captured page", () => {
    render(<LanguageProvider lang="en"><SourceLine provenance={decision} /></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Massachusetts Department of Labor Relations, opens in a new tab" });
    expect(link).toHaveAttribute("href", "https://www.mass.gov/dlr/decisions/example");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.closest("p")).toHaveTextContent("Source: Massachusetts Department of Labor Relations · Decision example, retrieved Oct 11, 2026");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("renders in Spanish from the same register", () => {
    render(<LanguageProvider lang="es"><SourceLine provenance={decision} /></LanguageProvider>);
    expect(screen.getByRole("link").closest("p")).toHaveTextContent("Fuente: Massachusetts Department of Labor Relations · Decision example, consultada el 11 oct 2026");
  });

  it("puts a computed value's inputs behind an expandable list", () => {
    render(<LanguageProvider lang="en"><SourceLine provenance={computed} inputs={[decision]} /></LanguageProvider>);
    const details = screen.getByRole("group");
    expect(within(details).getByText("Inputs (2)").tagName).toBe("SUMMARY");
    const items = within(details).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Massachusetts Department of Labor Relations · Decision example, retrieved Oct 11, 2026");
    expect(items[1]).toHaveTextContent(`Record ${payroll}`);
  });

  it("says the source is missing instead of rendering an unsourced line", () => {
    render(<LanguageProvider lang="en"><SourceLine provenance={{ ...decision, source: { url: "https://example.org" } }} /></LanguageProvider>);
    expect(screen.getByRole("note")).toHaveTextContent("Source record missing. This item cannot be traced to its source.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the English and Spanish registers complete", () => {
    expect(Object.keys(sourceLineCatalogue.es).sort()).toEqual(Object.keys(sourceLineCatalogue.en).sort());
    expect(sourceLineT("es", "sourceLine.inputs", { count: 3 })).toBe("Datos de origen (3)");
  });
});
