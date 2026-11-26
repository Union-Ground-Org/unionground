import { strToU8, zipSync } from "fflate";

// A minimal Office Open XML (.xlsx) workbook writer on the existing fflate
// dependency (REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001). Every
// text cell is an inline string, so a value that starts with "=" or "+" is
// stored as text and never evaluated as a formula; finite numbers and booleans
// keep their spreadsheet types. Control characters XML 1.0 cannot carry are
// dropped rather than producing a workbook Excel refuses to open.

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Characters XML 1.0 forbids: C0 controls other than tab, LF and CR, plus the
// two non-characters U+FFFE and U+FFFF.
function stripInvalidXml(value) {
  let out = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (!control && code !== 0xfffe && code !== 0xffff) out += character;
  }
  return out;
}

function xmlText(value) {
  return stripInvalidXml(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

export function sheetName(value, used = new Set()) {
  const base = stripInvalidXml(String(value ?? "").replace(/[\][:*?/\\]/g, " ")).trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
    const tail = ` ${suffix}`;
    name = `${base.slice(0, 31 - tail.length)}${tail}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function cellXml(value, reference) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((value, columnIndex) => cellXml(value, `${columnName(columnIndex)}${rowIndex + 1}`)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

// sheets: [{ name, rows: [[cell, ...], ...] }] -> Uint8Array (.xlsx bytes)
export function buildXlsxWorkbook(sheets) {
  const list = (Array.isArray(sheets) && sheets.length ? sheets : [{ name: "Sheet", rows: [] }]);
  const used = new Set();
  const named = list.map((sheet) => ({ name: sheetName(sheet?.name, used), rows: Array.isArray(sheet?.rows) ? sheet.rows : [] }));
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((sheet, index) => `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`),
  };
  named.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheetXml(sheet.rows)); });
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
