// OPS-UG-LAW-LIBRARY-STRIP-INTERNAL-SOURCE-PATHS-20261110: reference
// data the app ships shows where each fact came from (the public source link,
// publisher, retrieval date and content hash), never internal repository
// names, folder paths or build tool and run identifiers. The generators pass
// their output through publicReferenceDocument() before writing, and
// tests/public-reference-internal-paths.test.js holds the shipped files to it.
import { canonicalJson, collectProvenance, fingerprint, sha256Hex } from "./provenance.mjs";

// What a shipped file may not contain, anywhere.
export const INTERNAL_IDENTIFIERS = Object.freeze([
  { name: "internal repository name", pattern: /\b[\w.-]+-chapters-data\b/u },
  { name: "owner/repo@commit reference", pattern: /\b[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}:/u },
  { name: "internal chapter folder path", pattern: /\bchapters\/[A-Z][\w-]*\/data\/|\b[A-Z]{2,6}-Det\b/u },
  { name: "repository issue or pull request link", pattern: /\bgithub\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\//iu },
  { name: "build run identifier", pattern: /\bbuild-it-all-\d{8}\b|\blane-[A-Z]{1,3}\b|\bL\d+[a-z]?-phase\d/u },
  { name: "lane identifier", pattern: /\blane L\d+[a-z]?\b|\bL\d+[a-z]?[/:]|\bL\d+[a-z]? [a-z0-9]+(?:-[a-z0-9]+)+\b/u },
  { name: "build tool path", pattern: /\bscripts\/[\w.-]+\.(?:mjs|js|py)@\d+/u },
]);

const TOP_LEVEL_INTERNAL_FIELDS = ["library", "generated_by", "built_by"];
const PROVENANCE_ID = /^prov-[0-9a-f]{64}$/u;
const INTERNAL_SOURCE_KEY_PREFIX = /^(?:L\d+[a-z]?|[\w.-]+-chapters-data):/u;

// A review note may cite a capture by its key; the lane prefix goes
// ("(L7 ma-150e-s11)" reads "(capture ma-150e-s11)").
export function publicNoteText(text) {
  return String(text ?? "").replace(/\bL\d+[a-z]? (?=[a-z0-9]+(?:-[a-z0-9]+)+\b)/gu, "capture ");
}

// The extractor keeps the method and model; build-tool paths and lane names go.
export function publicExtractor(text) {
  return text
    .replace(/\s*\(lane [^)]*\)/gu, "")
    .replace(/\b(?:L\d+[a-z]?\/)?scripts\/(?:fetch_source\.py|capture\.mjs)@(\d+)/gu, "source capture@$1")
    .replace(/\b(?:L\d+[a-z]?\/)?scripts\/[\w.-]+\.(?:mjs|js|py)@(\d+)/gu, "library build@$1");
}

function walk(value, visit) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === "object") {
    visit(value);
    for (const item of Object.values(value)) walk(item, visit);
  }
}

// Provenance records are the values under a `provenance` key, as the contract's
// collectProvenance() reads them; a bare provenance_id elsewhere is a reference.
const provenanceRecords = (document) => collectProvenance(document)
  .filter(({ record }) => record && typeof record === "object" && typeof record.provenance_id === "string");

function replaceIds(value, ids) {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIds(item, ids)]));
  }
  return value;
}

// Every place a shipped value still names an internal identifier.
export function internalIdentifierFindings(document) {
  const findings = [];
  const scan = (value, path) => {
    if (typeof value === "string") {
      for (const { name, pattern } of INTERNAL_IDENTIFIERS) if (pattern.test(value)) findings.push(`${path}: ${name}`);
    } else if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) scan(item, path ? `${path}.${key}` : key);
    }
  };
  scan(document, "");
  for (const { path, record } of provenanceRecords(document)) {
    for (const key of ["tool", "run_id"]) if (record.capture && key in record.capture) findings.push(`${path}.capture.${key}: build tool or run identifier`);
  }
  return findings;
}

// The public form of a reference document: provenance keeps the source link,
// publisher, retrieval date, content hash and methods; capture.tool and
// capture.run_id go, extractors lose build paths and lane names, derived_from
// keeps only prov- inputs, and every id is recomputed with its references.
// Throws when anything internal is left, so a rebuild cannot ship it.
export function publicReferenceDocument(source, label = "document") {
  const document = structuredClone(source);
  for (const key of TOP_LEVEL_INTERNAL_FIELDS) delete document[key];
  // A record whose content_sha256 is the hash of its own parent object (an
  // authored card that carries its evidence ids and source keys) is re-hashed
  // from the public parent, so the hash still covers what ships.
  const parentOf = new Map();
  const parentHashed = new Set();
  walk(document, (node) => {
    const record = node.provenance;
    if (!record || typeof record !== "object" || typeof record.provenance_id !== "string") return;
    parentOf.set(record, node);
    const { provenance: _record, ...content } = node;
    if (sha256Hex(canonicalJson(content)) === record.content_sha256) parentHashed.add(record);
  });
  walk(document, (node) => {
    if (typeof node.source_key === "string") node.source_key = node.source_key.replace(INTERNAL_SOURCE_KEY_PREFIX, "source:");
  });
  const records = provenanceRecords(document).map(({ record }) => record);
  for (const record of records) {
    if (record.capture && typeof record.capture === "object") {
      delete record.capture.tool;
      delete record.capture.run_id;
    }
    if (typeof record.extraction?.extractor === "string") record.extraction.extractor = publicExtractor(record.extraction.extractor);
    if (Array.isArray(record.derived_from)) record.derived_from = record.derived_from.filter((reference) => PROVENANCE_ID.test(reference));
  }

  // Inputs first: a record's id covers its derived_from (and a parent-hashed
  // record's hash covers its parent), which name other records' ids, so ids
  // are recomputed in dependency order.
  const ids = new Map();
  const known = new Set(records.map((record) => record.provenance_id));
  const contentOf = (record) => {
    const { provenance: _record, ...content } = parentOf.get(record);
    return content;
  };
  const dependencies = (record) => [...(record.derived_from ?? []),
    ...(parentHashed.has(record) ? JSON.stringify(contentOf(record)).match(/prov-[0-9a-f]{64}/gu) ?? [] : [])]
    .filter((reference) => known.has(reference) && reference !== record.provenance_id);
  let pending = records;
  while (pending.length) {
    const next = pending.filter((record) => dependencies(record).some((reference) => !ids.has(reference)));
    const ready = pending.filter((record) => !next.includes(record));
    if (!ready.length) throw new Error(`${label}: provenance derived_from has a cycle`);
    for (const record of ready) {
      if (parentHashed.has(record)) record.content_sha256 = sha256Hex(canonicalJson(replaceIds(contentOf(record), ids)));
      const { provenance_id: oldId, ...rest } = record;
      const newId = fingerprint(replaceIds(rest, ids));
      if (ids.has(oldId) && ids.get(oldId) !== newId) throw new Error(`${label}: two records share ${oldId} but differ`);
      ids.set(oldId, newId);
    }
    pending = next;
  }
  const result = replaceIds(document, ids);
  const findings = internalIdentifierFindings(result);
  if (findings.length) throw new Error(`${label} still names internal identifiers:\n${findings.join("\n")}`);
  return result;
}
