// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractKnowledgeText, extractKnowledgeTextInProcess, resolveKnowledgeConverter } from "../api/_lib/knowledgeIngest.js";

const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function workbook(rows, strings) {
  const parts = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "xl/workbook.xml": `<workbook xmlns="${ns}"><sheets><sheet name="Policy" sheetId="1"/></sheets></workbook>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${ns}"><sheetData>${rows}</sheetData></worksheet>`,
  };
  if (strings !== undefined) parts["xl/sharedStrings.xml"] = `<sst xmlns="${ns}">${strings}</sst>`;
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])));
}
const extract = bytes => extractKnowledgeTextInProcess(bytes, "policy.xlsx", "");

describe("XLSX worksheet cell extraction", () => {
  it.each(["inlineStr", "s"])("rejects a workbook containing only whitespace in %s cells", async type => {
    const cell = type === "s" ? "<v>0</v>" : '<is><t xml:space="preserve">   </t></is>';
    await expect(extract(workbook(`<row><c r="A1" t="${type}">${cell}</c></row>`, "<si><t>   </t></si>")))
      .rejects.toThrow("knowledge-file-no-extractable-text");
  });

  it("indexes the referenced current policy without unused stale text or dictionary indexes", async () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"><v>1</v></c></row>',
      '<si><t>STALE: dues are 500 dollars.</t></si><si><t>CURRENT: dues are 10 dollars.</t></si>');
    expect(await extract(bytes)).toBe("A1: CURRENT: dues are 10 dollars.");
  });

  it("preserves row order, sparse cell references, reused indexes and numeric/inline values", async () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="s"><v>0</v></c></row>'
      + '<row r="2"><c r="B2" t="s"><v>1</v></c><c r="D2"><v>42</v></c>'
      + '<c r="F2" t="inlineStr"><is><r><t>Inline&amp;</t></r><r><t xml:space="preserve"> text</t></r></is></c></row>',
      '<si><t>First</t></si><si><t>Second</t></si><si><t>Unused</t></si>');
    expect(await extract(bytes)).toBe("A1: Second\nC1: First\nB2: Second\nD2: 42\nF2: Inline& text");
  });

  it("joins rich-text runs, omits phonetics and formula source, and retains cached display values", async () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="b"><v>1</v></c>'
      + '<c r="C1"><f>INTERNAL_FORMULA()</f><v>99</v></c></row>',
    '<si><r><t xml:space="preserve">Current </t></r><r><t>policy</t></r><rPh sb="0" eb="1"><t>phonetics</t></rPh></si>');
    expect(await extract(bytes)).toBe("A1: Current policy\nB1: TRUE\nC1: 99");
  });

  it("supports inline-only workbooks and blank shared-string cells", async () => {
    const bytes = workbook('<row r="1"><c r="A1" t="s"/><c r="B1" t="inlineStr"><is><t>Only visible cell</t></is></c></row>');
    expect(await extract(bytes)).toBe("B1: Only visible cell");
  });

  it("ignores non-cell extension metadata without duplicating the last worksheet row", async () => {
    const xml = `<worksheet xmlns="${ns}"><sheetData><row><c r="A1" t="inlineStr"><is><t>Current</t></is>`
      + '<extLst><is><t>STALE</t></is></extLst></c></row></sheetData>'
      + '<extLst><row><c t="inlineStr"><is><t>STALE</t></is></c></row></extLst></worksheet>';
    expect(await extract(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) }))).toBe("A1: Current");
  });

  it("bounds XML nesting before walking deeply nested metadata", async () => {
    const xml = `<worksheet>${"<ext>".repeat(65)}${"</ext>".repeat(65)}</worksheet>`;
    await expect(extract(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) })))
      .rejects.toThrow("knowledge-archive-too-large");
  });

  it.each(["-1", "1.5", "9", "bad", "9007199254740993"])("refuses an invalid shared-string reference %s", async index => {
    await expect(extract(workbook(`<row><c t="s"><v>${index}</v></c></row>`, "<si><t>Current</t></si>")))
      .rejects.toThrow("knowledge-xlsx-shared-string-invalid");
  });

  it("refuses a referenced shared-string table that is missing", async () => {
    await expect(extract(workbook('<row><c t="s"><v>0</v></c></row>')))
      .rejects.toThrow("knowledge-xlsx-shared-string-invalid");
  });

  it("does not treat an unreferenced dictionary as worksheet content", async () => {
    await expect(extract(workbook("<row/>", "<si><t>Unused</t></si>")))
      .rejects.toThrow("knowledge-file-no-extractable-text");
  });

  it("requires a worksheet even when the archive has a shared-string dictionary", async () => {
    await expect(extract(zipSync({ "xl/sharedStrings.xml": strToU8("<sst><si><t>Unused</t></si></sst>") })))
      .rejects.toThrow("knowledge-office-content-missing");
  });

  it("preserves CDATA cell text and false/zero values", async () => {
    const bytes = workbook('<row><c r="A1" t="inlineStr"><is><t><![CDATA[Literal & text]]></t></is></c>'
      + '<c r="B1" t="b"><v>0</v></c><c r="C1"><v>0</v></c></row>');
    expect(await extract(bytes)).toBe("A1: Literal & text\nB1: FALSE\nC1: 0");
  });

  it("keeps the archive entry limit before parsing worksheet content", async () => {
    const parts = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`ignored/${index}.txt`, strToU8("ignored")]));
    parts["xl/worksheets/sheet1.xml"] = strToU8("<worksheet/>");
    await expect(extract(zipSync(parts))).rejects.toThrow("knowledge-archive-too-many-files");
  });

  it("supports prefixed strict SpreadsheetML namespaces", async () => {
    const xml = '<x:worksheet xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main"><x:sheetData><x:row>'
      + '<x:c r="A1" t="inlineStr"><x:is><x:t>Strict cell</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>';
    expect(await extract(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) }))).toBe("A1: Strict cell");
  });

  it.each(["<worksheet><sheetData>", '<!DOCTYPE worksheet [<!ENTITY stale "STALE">]><worksheet/>' ])("refuses malformed XML and DTDs", async xml => {
    await expect(extract(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) })))
      .rejects.toThrow("knowledge-xlsx-xml-invalid");
  });

  it("bounds expanded output even when a large shared string is reused many times", async () => {
    const cells = Array.from({ length: 26 }, () => '<c t="s"><v>0</v></c>').join("");
    await expect(extract(workbook(`<row>${cells}</row>`, `<si><t>${"x".repeat(1024 * 1024)}</t></si>`)))
      .rejects.toThrow("knowledge-archive-too-large");
  });

  it.each(["cells", "strings"])("bounds %s even when their content is empty", async kind => {
    const bytes = kind === "cells"
      ? workbook(`<row>${"<c/>".repeat(100_001)}</row>`)
      : workbook("<row/>", "<si/>".repeat(100_001));
    await expect(extract(bytes)).rejects.toThrow("knowledge-archive-too-large");
  });

  it("uses the same cell extraction inside the cancellable worker", async () => {
    const bytes = workbook('<row><c r="A1" t="s"><v>0</v></c></row>', "<si><t>Worker cell</t></si>");
    expect(await extractKnowledgeText(bytes, "policy.xlsx", "", { signal: AbortSignal.timeout(5000) }))
      .toBe("A1: Worker cell");
  });

  it("identifies both parser libraries and the changed pipeline in provenance", () => {
    expect(resolveKnowledgeConverter("policy.xlsx", "")).toMatchObject({
      converterName: "fflate-saxes", converterVersion: "0.8.3+6.0.0", pipelineVersion: "2026.10.23",
    });
  });
});
