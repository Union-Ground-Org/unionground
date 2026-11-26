const MAX_ROWS = 500;
const MAX_COLUMNS = 64;
const MAX_CELL = 10000;
const MAX_BYTES = 2 * 1024 * 1024;

const IMPORT_FIELDS = Object.freeze({
  member: Object.freeze([
    "member_id", "email", "member_number", "job_title", "department",
    "work_location", "hire_date", "membership_class", "preferred_language",
    "administrative_notes",
  ]),
  grievance: Object.freeze([
    "member_id", "member_email", "chapter_id", "reference", "title",
    "deadline", "articles",
  ]),
});

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseRecords(source) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += char;
      }
    } else if (closedQuote && char !== "," && char !== "\n" && !(char === "\r" && source[index + 1] === "\n")) {
      throw new Error("Malformed CSV quote");
    } else if (char === '"') {
      if (field.length) throw new Error("Malformed CSV quote");
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
      closedQuote = false;
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
      closedQuote = false;
    } else {
      field += char;
    }
    if (field.length > MAX_CELL) throw new Error("CSV cell exceeds 10,000 characters");
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (field.length || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  return records.filter((row) => row.some((value) => value !== ""));
}

export function parseMemberOperationsCsv(input) {
  const source = String(input ?? "").replace(/^\uFEFF/, "");
  if (!source.trim()) throw new Error("CSV is empty");
  if (new TextEncoder().encode(source).length > MAX_BYTES) throw new Error("CSV exceeds 2 MB");
  const records = parseRecords(source);
  if (records.length < 2) throw new Error("CSV requires a header and at least one row");
  if (records.length - 1 > MAX_ROWS) throw new Error("CSV is limited to 500 rows");
  if (records[0].length > MAX_COLUMNS) throw new Error("CSV is limited to 64 columns");
  const headers = records[0].map(normalizeHeader);
  if (headers.some((header) => !header) || records.some((record) => record.length > headers.length)) {
    throw new Error("Every CSV column needs a header");
  }
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique after normalization");
  const rows = records.slice(1).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
  return { headers, rows };
}

export function validateMemberOperationsMapping(kind, mapping) {
  const fields = IMPORT_FIELDS[kind];
  if (!fields || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return { valid: false, errors: ["Choose a supported import type and map its columns."] };
  }
  const selected = Object.values(mapping).filter(Boolean);
  const errors = [];
  const unsupported = selected.filter((field) => !fields.includes(field));
  if (unsupported.length) errors.push("One or more columns map to unsupported fields.");
  if (new Set(selected).size !== selected.length) errors.push("Each destination field can be mapped only once.");
  const identityFields = kind === "member" ? ["member_id", "email"] : ["member_id", "member_email"];
  if (!identityFields.some((field) => selected.includes(field))) {
    errors.push(`Map either ${identityFields[0].replaceAll("_", " ")} or ${identityFields[1].replaceAll("_", " ")} to identify existing members.`);
  }
  if (kind === "grievance") {
    const missing = ["chapter_id", "reference", "title"].filter((field) => !selected.includes(field));
    if (missing.length) errors.push(`Map the required grievance fields: ${missing.map((field) => field.replaceAll("_", " ")).join(", ")}.`);
  }
  return { valid: errors.length === 0, errors };
}
