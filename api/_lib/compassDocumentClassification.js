import { createHash } from "node:crypto";

// Documents are classified by the database ingestion trigger, before retrieval.
// This reader checks the version and byte binding; it never classifies prose or
// accepts a publication flag as permission to send an arbitrary document.
export const COMPASS_DOCUMENT_RULE_VERSION = "compass-document-v1";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const RULES = new Set(["published-document", "public-filing"]);

function ready(classification) {
  return classification?.version === COMPASS_DOCUMENT_RULE_VERSION
    && classification.status === "ready" && RULES.has(classification.rule);
}

function validFiling(filing) {
  return typeof filing?.identity === "string" && filing.identity.trim().length > 0
    && filing.identity.length <= 200
    && ![...filing.identity].some((character) => character.codePointAt(0) < 32)
    && typeof filing.source === "string" && filing.source.length <= 1000
    && /^https:\/\/[^\s@]+$/.test(filing.source)
    && Number.isInteger(filing.year) && filing.year >= 1900 && filing.year <= 2099;
}

export function classifiedEmbeddingText(body, classification) {
  if (!ready(classification) || typeof body !== "string"
      || classification.body_sha256 !== digest(body)
      || typeof classification.text !== "string" || !classification.text.trim()
      || classification.text.length > 100000
      || classification.text_sha256 !== digest(classification.text)) return null;
  return classification.text;
}

export function classifiedCompassSource(source) {
  const classification = source?.document_classification;
  if (!ready(classification) || !String(source.source_id || "").startsWith("kb:")
      || source.kind === "case") return null;
  const fields = [source.title, source.ref, source.snippet];
  if (fields.some((text, index) => typeof text !== "string" || !text.trim()
      || text.length > [160, 120, 400][index]
      || [...text].some((character) => character.codePointAt(0) < 32))) return null;
  if (classification.payload_sha256 !== digest(fields.join("\u001f"))) return null;
  if (classification.rule === "public-filing" && !validFiling(classification.filing)) return null;
  const provenance = classification.rule === "public-filing"
    ? ` Filing: ${classification.filing.identity}; source: ${classification.filing.source}; year: ${classification.filing.year}.`
    : "";
  return { title: source.title, ref: source.ref, snippet: source.snippet, provenance };
}
