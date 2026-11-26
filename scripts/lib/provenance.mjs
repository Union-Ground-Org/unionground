// REQ-UG-PROVENANCE-CONTRACT-20261012.
//
// The one provenance record every loader, translator and reference file in
// this repository builds and checks. The contract it implements is
// docs/conventions/provenance.md; the same shape is published as JSON Schema in
// schemas/provenance.schema.json, and tests/provenance.test.js holds the two
// in step.
//
//   stamp()        build a record from the captured bytes (or their digest),
//                  fingerprint it, and refuse it if it is incomplete.
//   validate()     schema plus the fail-closed rules; returns every error.
//   fingerprint()  the record's provenance_id: "prov-" + SHA-256 of its
//                  canonical JSON without the provenance_id field.
//
// "Unknown" is a refusal, never a default: nothing here fills in a missing
// publisher, date or digest. A caller that cannot supply one has no record.

import { createHash } from "node:crypto";

export const CAPTURE_METHODS = Object.freeze([
  "http-get", "firecrawl", "browser", "bulk-file", "prr-production", "computed", "authored",
]);
export const EXTRACTION_METHODS = Object.freeze(["verbatim", "model", "script", "manual"]);
export const QUOTE_BINDINGS = Object.freeze(["exact-substring", "offsets", "none"]);
export const REVIEW_STATUSES = Object.freeze(["unreviewed", "reviewed"]);
export const REVIEWER_ROLES = Object.freeze(["lane", "platform_editor", "owner"]);
export const REUSE_BASES = Object.freeze([
  "public-record", "public-domain", "license", "fair-use-excerpt", "owner-authored",
]);

// Dotted paths that must be present and non-empty on every record. The SQL
// CHECK on each campaign table names exactly these keys.
export const REQUIRED_PATHS = Object.freeze([
  "provenance_id",
  "source.url",
  "source.publisher",
  "retrieved_at",
  "content_sha256",
  "capture.method",
  "as_of",
  "review.status",
]);

const TOP_LEVEL_KEYS = new Set([
  "provenance_id", "source", "retrieved_at", "content_sha256", "capture",
  "extraction", "as_of", "derived_from", "review", "reuse",
]);
const OBJECT_KEYS = {
  source: new Set(["url", "publisher", "title", "document_date"]),
  capture: new Set(["method", "tool", "run_id"]),
  extraction: new Set(["method", "extractor", "quote_binding"]),
  review: new Set(["status", "reviewed_at", "reviewer_role", "note"]),
  reuse: new Set(["basis", "note"]),
};
const LIMITS = { url: 2048, short: 300, title: 500, note: 2000, derived: 512 };

const SHA256 = /^[0-9a-f]{64}$/;
const PROVENANCE_ID = /^prov-[0-9a-f]{64}$/;
// owner/repo@<commit>:<path>, the form the contract uses for a dataset file in
// another repository (example-org/example-data@<sha>:path/to/file.csv).
const REPOSITORY_REFERENCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{7,40}:[^\s:][^\s]*$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A capture time this far ahead of the checking clock is a wrong clock or a
// fabricated record, not a race.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export class ProvenanceError extends Error {
  constructor(label, errors) {
    super(`${label}: provenance refused: ${errors.join("; ")}`);
    this.name = "ProvenanceError";
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

// Sorted keys at every depth, no whitespace, and `undefined` members dropped
// the way JSON.stringify drops them. Only JSON values are accepted: a record
// that holds a Date, a Buffer or a non-finite number has no canonical bytes.
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // A hole has no JSON value of its own: map() would skip it and join() would
    // print nothing, so [ , ] and [] would share a fingerprint.
    const items = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError("canonicalJson: sparse array");
      items.push(value[index] === undefined ? "null" : canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
}

export function sha256Hex(bytes) {
  // ArrayBuffer.isView, not instanceof: bytes from another realm (a worker, a
  // test DOM) are still bytes.
  if (typeof bytes !== "string" && !ArrayBuffer.isView(bytes)) {
    throw new TypeError("sha256Hex: bytes must be a string or a typed array");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprint(record) {
  if (!isPlainObject(record)) throw new TypeError("fingerprint: record must be an object");
  const { provenance_id: _ignored, ...rest } = record;
  return `prov-${sha256Hex(canonicalJson(rest))}`;
}

function realDate(year, month, day) {
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return at.getUTCFullYear() === Number(year) && at.getUTCMonth() === Number(month) - 1 && at.getUTCDate() === Number(day);
}

function utcTimestamp(value) {
  const match = typeof value === "string" ? UTC_TIMESTAMP.exec(value) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  if (!realDate(y, mo, d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return Date.parse(value);
}

function calendarDate(value) {
  const match = typeof value === "string" ? CALENDAR_DATE.exec(value) : null;
  return Boolean(match && realDate(match[1], match[2], match[3]));
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function httpUrl(value) {
  if (!text(value) || value.length > LIMITS.url || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function at(record, path) {
  return path.split(".").reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), record);
}

/**
 * Check one record against the contract. Returns { ok, errors } and never
 * throws on malformed input; every problem is listed, not just the first.
 * `now` (ms or Date) is the clock a capture time may not run ahead of.
 */
export function validate(record, { now = Date.now() } = {}) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!isPlainObject(record)) return { ok: false, errors: ["record must be a JSON object"] };

  for (const key of Object.keys(record)) {
    if (!TOP_LEVEL_KEYS.has(key)) add(`unknown field ${key}`);
  }
  for (const [name, allowed] of Object.entries(OBJECT_KEYS)) {
    const value = record[name];
    if (value === undefined && (name === "extraction" || name === "reuse")) continue;
    if (!isPlainObject(value)) {
      add(`${name} must be an object`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) add(`unknown field ${name}.${key}`);
    }
  }
  for (const path of REQUIRED_PATHS) {
    if (!text(at(record, path))) add(`${path} is required`);
  }

  const { source, capture, extraction, review, reuse } = record;
  if (text(record.provenance_id)) {
    if (!PROVENANCE_ID.test(record.provenance_id)) add("provenance_id must be prov-<64 lowercase hex>");
    else {
      try {
        if (fingerprint(record) !== record.provenance_id) add("provenance_id does not match the record's fingerprint");
      } catch (error) {
        add(`record has no canonical form: ${error.message}`);
      }
    }
  }
  if (isPlainObject(source)) {
    if (text(source.url) && !httpUrl(source.url)) add("source.url must be an absolute http(s) URL without credentials");
    if (text(source.publisher) && source.publisher.length > LIMITS.short) add("source.publisher is too long");
    if (source.title !== undefined && (!text(source.title) || source.title.length > LIMITS.title)) add("source.title must be non-empty text when present");
    if (source.document_date !== undefined && source.document_date !== null && !calendarDate(source.document_date)) add("source.document_date must be a YYYY-MM-DD date");
  }
  if (text(record.retrieved_at)) {
    const retrieved = utcTimestamp(record.retrieved_at);
    if (retrieved === null) add("retrieved_at must be an RFC 3339 UTC timestamp ending in Z");
    else if (retrieved > Number(now) + FUTURE_TOLERANCE_MS) add("retrieved_at is in the future");
  }
  if (text(record.content_sha256) && !SHA256.test(record.content_sha256)) add("content_sha256 must be 64 lowercase hex characters");
  if (text(record.as_of) && !calendarDate(record.as_of) && utcTimestamp(record.as_of) === null) {
    add("as_of must be a YYYY-MM-DD date or an RFC 3339 UTC timestamp");
  }
  if (isPlainObject(capture)) {
    if (text(capture.method) && !CAPTURE_METHODS.includes(capture.method)) add(`capture.method must be one of ${CAPTURE_METHODS.join(", ")}`);
    for (const key of ["tool", "run_id"]) {
      if (capture[key] !== undefined && (!text(capture[key]) || capture[key].length > LIMITS.short)) add(`capture.${key} must be non-empty text when present`);
    }
  }
  if (isPlainObject(extraction)) {
    if (!EXTRACTION_METHODS.includes(extraction.method)) add(`extraction.method must be one of ${EXTRACTION_METHODS.join(", ")}`);
    if (extraction.extractor !== undefined && (!text(extraction.extractor) || extraction.extractor.length > LIMITS.short)) add("extraction.extractor must be non-empty text when present");
    if (extraction.quote_binding !== undefined && !QUOTE_BINDINGS.includes(extraction.quote_binding)) add(`extraction.quote_binding must be one of ${QUOTE_BINDINGS.join(", ")}`);
  }

  const derived = record.derived_from;
  if (derived !== undefined) {
    if (!Array.isArray(derived) || derived.length > LIMITS.derived) add("derived_from must be an array of at most 512 references");
    else {
      for (let index = 0; index < derived.length; index++) {
        const reference = derived[index];
        if (typeof reference !== "string" || !(PROVENANCE_ID.test(reference) || REPOSITORY_REFERENCE.test(reference))) {
          add(`derived_from[${index}] must be a prov- id or an owner/repo@<commit>:<path> reference`);
        }
      }
      if (new Set(derived).size !== derived.length) add("derived_from repeats a reference");
    }
  }
  const inputs = Array.isArray(derived) ? derived.length : 0;
  if (isPlainObject(capture) && capture.method === "computed") {
    if (!inputs) add("a computed record must list every input in derived_from");
    if (!text(extraction?.extractor)) add("a computed record must name its script and version in extraction.extractor");
  }
  if (isPlainObject(capture) && capture.method === "authored" && !inputs) {
    add("an authored record must list the sources it rests on in derived_from");
  }

  if (isPlainObject(review)) {
    if (text(review.status) && !REVIEW_STATUSES.includes(review.status)) add(`review.status must be one of ${REVIEW_STATUSES.join(", ")}`);
    if (review.reviewer_role !== undefined && review.reviewer_role !== null && !REVIEWER_ROLES.includes(review.reviewer_role)) {
      add(`review.reviewer_role must be one of ${REVIEWER_ROLES.join(", ")}`);
    }
    if (review.reviewed_at !== undefined && review.reviewed_at !== null) {
      const reviewed = utcTimestamp(review.reviewed_at);
      if (reviewed === null) add("review.reviewed_at must be an RFC 3339 UTC timestamp ending in Z");
      else if (reviewed > Number(now) + FUTURE_TOLERANCE_MS) add("review.reviewed_at is in the future");
    }
    if (review.status === "reviewed") {
      if (!text(review.reviewed_at)) add("a reviewed record needs review.reviewed_at");
      if (!text(review.reviewer_role)) add("a reviewed record needs review.reviewer_role");
    }
    if (review.note !== undefined && (typeof review.note !== "string" || review.note.length > LIMITS.note)) add("review.note must be text of at most 2000 characters");
  }
  if (isPlainObject(reuse)) {
    if (!REUSE_BASES.includes(reuse.basis)) add(`reuse.basis must be one of ${REUSE_BASES.join(", ")}`);
    if (reuse.note !== undefined && (typeof reuse.note !== "string" || reuse.note.length > LIMITS.note)) add("reuse.note must be text of at most 2000 characters");
  }
  return { ok: errors.length === 0, errors };
}

/** Throw a ProvenanceError naming `label` unless the record is complete. */
export function assertProvenance(record, label = "record", options) {
  const { ok, errors } = validate(record, options);
  if (!ok) throw new ProvenanceError(label, errors);
  return record;
}

// An ISO timestamp with a Z or ±hh:mm offset whose calendar and clock fields
// are real. Date would roll February 30 into March 2; that is a different
// capture time, not a normalization, so it is refused before conversion.
const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isoUtc(value, label) {
  let date = null;
  if (value instanceof Date) date = value;
  else if (typeof value === "string") {
    const match = OFFSET_TIMESTAMP.exec(value);
    if (match) {
      const [, y, mo, d, h, mi, s, oh = "00", om = "00"] = match;
      if (realDate(y, mo, d) && Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59 && Number(oh) <= 23 && Number(om) <= 59) {
        date = new Date(value);
      }
    }
  }
  if (!date || Number.isNaN(date.getTime())) throw new ProvenanceError("stamp", [`${label} must be a Date or an ISO timestamp with a real date, time and offset`]);
  return date.toISOString();
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build a complete record. Supply the captured `bytes` (string or Uint8Array)
 * or, when the bytes were hashed while streaming, their `contentSha256` —
 * exactly one. `retrievedAt` defaults to now; everything the contract
 * requires otherwise has no default, and an incomplete record throws.
 */
export function stamp({
  bytes,
  contentSha256,
  source,
  retrievedAt = new Date(),
  capture,
  extraction,
  asOf,
  derivedFrom = [],
  review = { status: "unreviewed", reviewed_at: null },
  reuse,
} = {}) {
  if ((bytes === undefined) === (contentSha256 === undefined)) {
    throw new ProvenanceError("stamp", ["supply exactly one of bytes or contentSha256"]);
  }
  // The record owns copies of what it was built from and is frozen, so a caller
  // cannot change it after its provenance_id was computed.
  let inputs;
  try {
    inputs = structuredClone({ source, capture, extraction, derivedFrom, review, reuse });
  } catch (error) {
    throw new ProvenanceError("stamp", [`record inputs are not plain data: ${error.message}`]);
  }
  ({ source, capture, extraction, derivedFrom, review, reuse } = inputs);
  const record = {
    source,
    retrieved_at: isoUtc(retrievedAt, "retrievedAt"),
    content_sha256: bytes === undefined ? contentSha256 : sha256Hex(bytes),
    capture,
    ...(extraction === undefined ? {} : { extraction }),
    as_of: asOf instanceof Date ? isoUtc(asOf, "asOf") : asOf,
    derived_from: derivedFrom,
    review,
    ...(reuse === undefined ? {} : { reuse }),
  };
  // Fingerprint only a record that has canonical bytes; validate() reports why
  // one does not.
  let id;
  try {
    id = fingerprint(record);
  } catch (error) {
    throw new ProvenanceError("stamp", [`record has no canonical form: ${error.message}`]);
  }
  return deepFreeze(assertProvenance({ provenance_id: id, ...record }, "stamp"));
}

/**
 * Every value held under a `provenance` key anywhere in a JSON document, with
 * its JSON path. Reference files under data/reference/ carry their records
 * this way: one on the file, one per row or cell as the data needs.
 */
export function collectProvenance(document) {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        const child = `${path}.${key}`;
        if (key === "provenance") found.push({ path: child, record: value });
        else walk(value, child);
      }
    }
  };
  walk(document, "$");
  return found;
}

/**
 * Validate a whole reference document: it carries at least one record, every
 * record is complete, and every prov- id a record derives from is a full
 * record in the same document (the contract's "each of those being a full
 * record"). Repository references are checked for shape only.
 */
export function validateDocument(document, options) {
  const errors = [];
  if (!isPlainObject(document) && !Array.isArray(document)) {
    return { ok: false, errors: ["document must be a JSON object or array"], records: 0 };
  }
  const found = collectProvenance(document);
  if (!found.length) errors.push("document carries no provenance record");
  const ids = new Set();
  for (const { path, record } of found) {
    const result = validate(record, options);
    for (const message of result.errors) errors.push(`${path}: ${message}`);
    if (result.ok) ids.add(record.provenance_id);
  }
  for (const { path, record } of found) {
    for (const reference of Array.isArray(record?.derived_from) ? record.derived_from : []) {
      if (typeof reference === "string" && PROVENANCE_ID.test(reference) && !ids.has(reference)) {
        errors.push(`${path}: derived_from ${reference} is not a complete record in this document`);
      }
    }
  }
  return { ok: errors.length === 0, errors, records: found.length };
}
