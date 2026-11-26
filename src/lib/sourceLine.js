// What the source line under a sourced figure or document shows
// (REQ-UG-PROVENANCE-CONTRACT-20261012, docs/conventions/provenance.md).
//
// Catalogue-free and DOM-free so the web SourceLine and apps/mobile's
// SourceLine render the same thing from the same record. This is a display
// check, not the validator: loaders refuse incomplete records with
// scripts/lib/provenance.mjs before anything reaches a screen. It applies the
// validator's shape rules to the required fields (the exact stored http(s)
// URL, a real UTC capture time, the id and digest formats) and refuses
// anything else; the caller then shows "source record missing" instead of a
// source. It does not recompute the fingerprint: that is a content hash, not a
// signature, so whoever could forge a row could recompute it too.
import { dateTimeFormatCore } from "./i18n/format.js";

// Stored in UTC, shown in Eastern time (contract section 2).
export const SOURCE_LINE_TIME_ZONE = "America/New_York";

const DERIVED_METHODS = new Set(["computed", "authored"]);
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const PROVENANCE_ID = /^prov-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Same acceptance as the validator's httpUrl(): the stored string itself, not
// a trimmed or normalized version of it.
function httpHref(value) {
  if (!text(value) || value !== value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.hostname ? value : null;
  } catch {
    return null;
  }
}

export function formatRetrievedDate(value, lang = "en") {
  const match = typeof value === "string" ? UTC_TIMESTAMP.exec(value) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  // Date would roll February 30 or 24:00 into another day; that is not the
  // recorded capture time.
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeFormatCore(lang, { year: "numeric", month: "short", day: "numeric", timeZone: SOURCE_LINE_TIME_ZONE }).format(date);
}

function entry(record, lang) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.provenance_id !== "string" || !PROVENANCE_ID.test(record.provenance_id)) return null;
  if (typeof record.content_sha256 !== "string" || !SHA256.test(record.content_sha256)) return null;
  if (!text(record.capture?.method) || !text(record.as_of) || !text(record.review?.status)) return null;
  const publisher = text(record.source?.publisher);
  const href = httpHref(record.source?.url);
  const retrieved = formatRetrievedDate(record.retrieved_at, lang);
  if (!publisher || !href || !retrieved) return null;
  return { publisher, href, title: text(record.source?.title), retrieved };
}

/**
 * The source line for one provenance record, or null when it cannot be shown.
 * `inputs` are the full records a computed or authored item derives from; each
 * `derived_from` reference resolves against them by provenance_id, and one that
 * does not resolve is listed by its reference rather than dropped.
 */
export function sourceLineModel(provenance, { lang = "en", inputs = [] } = {}) {
  const head = entry(provenance, lang);
  if (!head) return null;
  const derived = DERIVED_METHODS.has(provenance.capture?.method) && Array.isArray(provenance.derived_from)
    ? provenance.derived_from.filter((reference) => typeof reference === "string" && reference.length > 0)
    : [];
  const byId = new Map((Array.isArray(inputs) ? inputs : [])
    .filter((record) => typeof record?.provenance_id === "string")
    .map((record) => [record.provenance_id, record]));
  return {
    ...head,
    inputs: derived.map((reference) => {
      const shown = entry(byId.get(reference), lang);
      return shown ? { key: reference, ...shown } : { key: reference, reference };
    }),
  };
}
