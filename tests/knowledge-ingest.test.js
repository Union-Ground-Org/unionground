// @vitest-environment node
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  chunkKnowledgeText,
  extractKnowledgeText,
  extractKnowledgeTextInProcess,
  KNOWLEDGE_CONVERTERS,
  KNOWLEDGE_PIPELINE_VERSION,
  publicIngestError,
  resolveKnowledgeConverter,
} from "../api/_lib/knowledgeIngest.js";

describe("knowledge file extraction", () => {
  it("normalizes plain text and creates bounded overlapping chunks", async () => {
    const text = await extractKnowledgeText(Buffer.from("First line.\r\n\r\nSecond   line."), "notes.txt", "text/plain");
    expect(text).toBe("First line.\n\nSecond line.");
    const chunks = chunkKnowledgeText(`${"A".repeat(5900)}. ${"B".repeat(5900)}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.length <= 8000)).toBe(true);
    expect(chunks[1]).toContain("A");
    expect(chunks[1]).toContain("B");
  });

  it("runs extraction in a worker that the request budget can terminate", async () => {
    await expect(extractKnowledgeText(
      Buffer.from("Bounded parser input."),
      "notes.txt",
      "text/plain",
      { signal: AbortSignal.timeout(2_000) },
    )).resolves.toBe("Bounded parser input.");

    const controller = new AbortController();
    controller.abort();
    await expect(extractKnowledgeText(
      Buffer.from("Never parsed."),
      "notes.txt",
      "text/plain",
      { signal: controller.signal },
    )).rejects.toThrow("knowledge-ingest-time-budget");

    await expect(extractKnowledgeText(
      Buffer.from("Worker startup outlives this deadline."),
      "notes.txt",
      "text/plain",
      { signal: AbortSignal.timeout(1) },
    )).rejects.toThrow("knowledge-ingest-time-budget");
  });

  it("extracts modern Word package text without executing archive content", async () => {
    const archive = zipSync({
      "[Content_Types].xml": strToU8("<Types/>") ,
      "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Safety &amp; health</w:t></w:r></w:p><w:p><w:r><w:t>Article 12</w:t></w:r></w:p></w:body></w:document>"),
    });
    await expect(extractKnowledgeText(
      archive,
      "guide.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      { signal: AbortSignal.timeout(5_000) },
    ))
      .resolves.toContain("Safety & health");
  });

  it("rejects declared archive expansion before decompressing selected content", async () => {
    const archive = zipSync({
      "word/document.xml": new Uint8Array(25 * 1024 * 1024 + 1),
    });
    await expect(extractKnowledgeText(archive, "oversized.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .rejects.toThrow("knowledge-archive-too-large");
  });

  it("rejects spoofed PDFs, binary legacy Office, and empty text", async () => {
    await expect(extractKnowledgeTextInProcess(Buffer.from("not a pdf"), "guide.pdf", "application/pdf"))
      .rejects.toThrow("knowledge-pdf-signature-invalid");
    await expect(extractKnowledgeText(
      Buffer.from("not a pdf"),
      "guide.pdf",
      "application/pdf",
      { signal: AbortSignal.timeout(5_000) },
    ))
      .rejects.toThrow("knowledge-pdf-signature-invalid");
    await expect(extractKnowledgeText(Buffer.from("legacy"), "guide.doc", "application/msword"))
      .rejects.toThrow("knowledge-file-type-not-ingestible");
    await expect(extractKnowledgeText(Buffer.from("   \n"), "guide.txt", "text/plain"))
      .rejects.toThrow("knowledge-file-no-extractable-text");
  });

  it("reduces unexpected parser details to a bounded public code", () => {
    expect(publicIngestError(new Error("provider body with private detail"))).toBe("knowledge-ingest-failed");
    expect(publicIngestError(new Error("knowledge-office-signature-invalid"))).toBe("knowledge-office-signature-invalid");
  });

  // Union Ground has no CBA ingest: there is
  // no collective bargaining agreement before a first contract, and contract
  // articles are left out, so no uploaded text is split into article drafts.
  it("ships no contract-article normalizer", async () => {
    const module = await import("../api/_lib/knowledgeIngest.js");
    expect(module).not.toHaveProperty("normalizeCbaArticles");
    expect(Object.keys(module).filter((name) => /cba|article/i.test(name))).toEqual([]);
    const source = readFileSync(new URL("../api/_lib/knowledgeIngest.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/CBA_HEADING|knowledge-cba-|Collective bargaining agreement/);
  });
});

// REQ-UG-DOCUMENT-CONVERSION-PROVENANCE-20260904.
//
// The provenance ledger is only as honest as the identity this module reports.
// A constant that has drifted from the installed library would put a confident,
// wrong converter version on every row — worse than recording nothing, because
// nobody would think to doubt it.
describe("conversion provenance identity", () => {
  it("pins every converter version to what package-lock.json actually installs", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    );
    const installed = (name) => lock.packages[`node_modules/${name}`]?.version;

    expect(KNOWLEDGE_CONVERTERS.pdf).toEqual({ name: "unpdf", version: installed("unpdf") });
    for (const format of ["docx", "pptx"]) {
      expect(KNOWLEDGE_CONVERTERS[format], format).toEqual({ name: "fflate", version: installed("fflate") });
    }
    expect(KNOWLEDGE_CONVERTERS.xlsx).toEqual({ name: "fflate-saxes", version: `${installed("fflate")}+${installed("saxes")}` });
    // The remaining two are this repository's own parsers, so their "version"
    // is the pipeline's own, not a dependency's.
    expect(KNOWLEDGE_CONVERTERS.rtf.name).toBe("union-ground-rtf");
    expect(KNOWLEDGE_CONVERTERS.txt.name).toBe("union-ground-text");
    expect(KNOWLEDGE_PIPELINE_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
  });

  // Two functions decide the same thing — which parser handles this file — and
  // the ledger is a lie the moment they disagree. Every branch of the extractor
  // is replayed against the resolver here.
  it.each([
    ["agreement.pdf", "application/pdf", "pdf", "unpdf"],
    ["agreement.PDF", "", "pdf", "unpdf"],
    ["notes.docx", "", "docx", "fflate"],
    ["deck.pptx", "", "pptx", "fflate"],
    ["roster.xlsx", "", "xlsx", "fflate-saxes"],
    ["memo.rtf", "", "rtf", "union-ground-rtf"],
    ["memo.unknown", "application/rtf", "rtf", "union-ground-rtf"],
    ["notes.txt", "", "txt", "union-ground-text"],
    ["roster.csv", "", "csv", "union-ground-text"],
    ["page.html", "text/html", "txt", "union-ground-text"],
  ])("resolves %s (%s) to the parser the extractor would use", (fileName, mimeType, format, converter) => {
    expect(resolveKnowledgeConverter(fileName, mimeType)).toEqual({
      sourceFormat: format,
      converterName: converter,
      converterVersion: KNOWLEDGE_CONVERTERS[format].version,
      pipelineVersion: KNOWLEDGE_PIPELINE_VERSION,
    });
  });

  it("resolves nothing for a file the extractor refuses, so no attempt is invented", () => {
    expect(resolveKnowledgeConverter("photo.heic", "image/heic")).toBeNull();
    expect(resolveKnowledgeConverter("archive.zip", "application/zip")).toBeNull();
    expect(resolveKnowledgeConverter("", "")).toBeNull();
  });

  it("only names formats the provenance ledger's own constraint accepts", () => {
    const migration = readFileSync(
      new URL("../supabase/migrations/20260907110000_knowledge_conversion_provenance.sql", import.meta.url),
      "utf8",
    );
    const allowed = /source_format text not null check \(source_format in \(([^)]*)\)\)/.exec(migration)[1];
    for (const format of Object.keys(KNOWLEDGE_CONVERTERS)) {
      expect(allowed, format).toContain(`'${format}'`);
    }
  });
});

// The in-process extractor is what the worker thread runs, and what a direct
// caller with no abort signal runs. Exercising it here rather than only through
// the worker keeps the archive, entity and RTF paths visible to coverage — a
// worker thread's execution is not instrumented, so those branches read as dead
// code while being the ones that parse untrusted bytes.
describe("in-process extraction paths", () => {
  const office = (entries) => zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, xml]) => [name, strToU8(xml)]),
  ));

  it("decodes entities, tabs and paragraph breaks out of a Word package", async () => {
    const archive = office({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        "<w:document><w:body>"
        + "<w:p><w:r><w:t>Safety &amp; health &#38; &#x26; &lt;notice&gt;</w:t></w:r></w:p>"
        + "<w:p><w:r><w:t>Column<w:tab/>Value</w:t></w:r></w:p>"
        + "</w:body></w:document>",
      "word/footnotes.xml": "<w:document><w:p><w:r><w:t>Footnote body</w:t></w:r></w:p></w:document>",
    });

    const text = await extractKnowledgeTextInProcess(
      archive, "guide.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(text).toContain("Safety & health & & <notice>");
    // The tab survives xmlText and is then collapsed to a single space by the
    // shared normalizer, which is what every downstream chunk sees.
    expect(text).toContain("Column Value");
    expect(text).toContain("Footnote body");
  });

  it("reads slide and worksheet parts and ignores everything else in the package", async () => {
    const deck = office({
      "ppt/slides/slide2.xml": "<a:p><a:r><a:t>Second slide</a:t></a:r></a:p>",
      "ppt/slides/slide10.xml": "<a:p><a:r><a:t>Tenth slide</a:t></a:r></a:p>",
      "ppt/notesSlides/notesSlide1.xml": "<a:p><a:r><a:t>Presenter note</a:t></a:r></a:p>",
    });
    const book = office({
      "xl/sharedStrings.xml": "<sst><si><t>Harborview Care United</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>Head count</t></is></c></row></sheetData></worksheet>',
      "xl/calcChain.xml": "<calcChain><c r=\"A1\"/></calcChain>",
    });

    const slides = await extractKnowledgeTextInProcess(deck, "deck.pptx", "");
    const sheets = await extractKnowledgeTextInProcess(book, "roster.xlsx", "");

    // Numeric ordering, not lexicographic: slide10 must not sort before slide2.
    expect(slides.indexOf("Second slide")).toBeLessThan(slides.indexOf("Tenth slide"));
    expect(slides).not.toContain("Presenter note");
    expect(sheets).toContain("Harborview Care United");
    expect(sheets).toContain("Head count");
    expect(sheets).not.toContain("calcChain");
  });

  it("refuses an Office package with no content part it recognizes", async () => {
    const empty = office({ "[Content_Types].xml": "<Types/>" });

    await expect(extractKnowledgeTextInProcess(empty, "empty.docx", ""))
      .rejects.toThrow("knowledge-office-content-missing");
  });

  it("strips RTF formatting without dropping escaped document characters", async () => {
    const rtf = "{\\rtf1\\ansi\\deff0 Grievance step \\'27one\\'27\\par Filed on time.\\line Signed.}";

    const text = await extractKnowledgeTextInProcess(Buffer.from(rtf), "memo.rtf", "");

    expect(text).toContain("Grievance step");
    expect(text).toContain("'one'");
    expect(text).toContain("Filed on time.");
    expect(text).toContain("Signed.");
    expect(text).not.toContain("\\par");
    expect(text).not.toContain("rtf1");
  });

  it("selects the RTF and plain-text branches from the MIME type when the name cannot decide", async () => {
    const byMime = await extractKnowledgeTextInProcess(
      Buffer.from("{\\rtf1 Body text.}"), "attachment", "application/rtf",
    );
    const asText = await extractKnowledgeTextInProcess(
      Buffer.from("<p>Plain enough.</p>"), "attachment", "text/html",
    );

    expect(byMime).toContain("Body text.");
    expect(asText).toContain("Plain enough.");
  });

  it("refuses an empty file, an oversized file and an unknown type before parsing", async () => {
    await expect(extractKnowledgeTextInProcess(Buffer.alloc(0), "empty.txt", "text/plain"))
      .rejects.toThrow("knowledge-file-size-invalid");
    await expect(extractKnowledgeTextInProcess(Buffer.alloc(11 * 1024 * 1024, 0x41), "big.txt", "text/plain"))
      .rejects.toThrow("knowledge-file-size-invalid");
    await expect(extractKnowledgeTextInProcess(Buffer.from("binary"), "photo.heic", "image/heic"))
      .rejects.toThrow("knowledge-file-type-not-ingestible");
  });
});
