// Short-name matches nominate values for a provenance decision; they never
// establish that a public organization value belongs to an individual.
import { createHash } from "node:crypto";
import reviewedEvidence from "../../config/catalog-short-name-evidence.json" with { type: "json" };
import { CATALOG_KEY_PATTERN, primaryKeyOf, rowViolations } from "./catalog-shape.mjs";

const SCHEMA = "catalog-short-name-evidence/1";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CLASSIFICATIONS = new Set(["person", "organization", "office_role", "unknown"]);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const keyOf = (record, recordDigest, catalogKey, path, valueDigest) => JSON.stringify([record, recordDigest, catalogKey, path, valueDigest]);

function evidenceIndex(evidence) {
  const index = new Map();
  if (evidence?.schema !== SCHEMA || !Array.isArray(evidence.entries)) return index;
  for (const entry of evidence.entries) {
    if (!entry || typeof entry.record_id !== "string" || !DIGEST.test(entry.record_digest) || !CATALOG_KEY_PATTERN.test(entry.catalog_key)
      || !DIGEST.test(entry.value_digest) || !Array.isArray(entry.paths)
      || !CLASSIFICATIONS.has(entry.classification)
      || typeof entry.observation !== "string" || !entry.observation.trim()
      || typeof entry.capture?.path !== "string" || !entry.capture.path.trim()
      || typeof entry.capture.pointer !== "string" || !entry.capture.pointer.startsWith("/")
      || !DIGEST.test(entry.capture.digest)) continue;
    for (const path of entry.paths) {
      if (typeof path !== "string" || !path) continue;
      const key = keyOf(entry.record_id, entry.record_digest, entry.catalog_key, path, entry.value_digest);
      // Conflicting or duplicated attestations never choose an allow entry.
      index.set(key, index.has(key) ? "unknown" : entry.classification);
    }
  }
  return index;
}

const FIELDS = Object.freeze({
  organizations: ["structure_note", "website", "bylaws_url"],
  subunits: ["name", "kind_label", "location", "employer", "members_source", "density_note", "election_note", "structure_note", "source_url", "website"],
  seat_outlines: ["title", "source_url"],
  contacts: ["value", "label", "source_url"],
  documents: ["title", "url"],
  edges: ["parent_label", "source_url"],
  identifiers: ["source_url"],
});

/** Stable row keys address fields; a source-array member is bound by its digest. */
export function shortNameFields(release) {
  const fields = [];
  for (const [table, columns] of Object.entries(FIELDS)) {
    for (const row of release[table] ?? []) {
      const catalogKey = table === "edges" ? row.child_key : row.catalog_key;
      const rowKey = primaryKeyOf(table, row);
      for (const column of columns) {
        const value = row[column];
        if (typeof value !== "string" || !value) continue;
        fields.push({ table, row, column, value, catalogKey,
          path: table === "organizations" ? `${table}.${column}` : `${table}.${rowKey}.${column}`,
          url: column === "url" || column === "source_url" || column === "website" || column === "bylaws_url"
            || (table === "contacts" && column === "value" && ["website", "social"].includes(row.contact_kind)),
        });
      }
      if (table === "organizations") {
        for (const column of ["source_urls", "aka"]) {
          for (const [position, value] of (row[column] ?? []).entries()) {
            fields.push({ table, row, column, position, value, catalogKey,
              path: column === "source_urls" ? "organizations.source_urls" : `organizations.aka[${position}]`,
              url: column === "source_urls",
            });
          }
        }
      }
    }
  }
  return fields;
}

/**
 * Runs after Main's existing vetoes and before its row/privacy validation.
 * Does not read a page, file, environment variable or person evidence at run time.
 * Each unknown/person field is withheld; a required-field hold propagates
 * through the already-built graph, without rebuilding or changing other rows.
 */
export function applyShortNamePrivacy(release, {
  enriched, idMap, matcherFor, report, evidence = reviewedEvidence,
  searchTextFor,
}) {
  const index = evidenceIndex(evidence);
  const records = new Map();
  const fields = shortNameFields(release);
  const present = new Set(fields.map((field) => field.catalogKey));
  for (const [id, catalogKey] of Object.entries(idMap)) {
    if (!present.has(catalogKey)) continue;
    const record = enriched[id];
    if (!record) continue;
    records.set(catalogKey, { id, hash: digest(JSON.stringify(record)), matcher: matcherFor(record) });
  }
  const held = new Map();
  const rejectedArrays = new Map();
  const changedAliases = new Set();
  const holdRow = (table, row, reason) => {
    const key = `${table}:${primaryKeyOf(table, row)}`;
    const old = held.get(key);
    held.set(key, old === "person" || reason === "person" ? "person" : reason);
  };
  for (const field of fields) {
    const subject = records.get(field.catalogKey);
    if (!subject || !subject.matcher(field.value, { url: field.url })) continue;
    const classification = index.get(keyOf(subject.id, subject.hash, field.catalogKey, field.path, digest(field.value))) ?? "unknown";
    report.drop(`short_name.candidates.${field.table}.${field.column}`, classification);
    if (classification === "organization" || classification === "office_role") continue;
    if (field.position !== undefined) {
      const set = rejectedArrays.get(field.row[field.column]) ?? new Set();
      set.add(field.position);
      rejectedArrays.set(field.row[field.column], set);
      if (field.column === "aka") changedAliases.add(field.row);
      continue;
    }
    // Hold a row whose required field cannot be published. No replacement
    // title/source is invented from an unreviewed observation.
    const changed = { ...field.row, [field.column]: null };
    if (rowViolations(field.table, changed).length > 0) holdRow(field.table, field.row, classification);
    else field.row[field.column] = null;
  }
  for (const row of release.organizations) {
    for (const column of ["source_urls", "aka"]) {
      const rejected = rejectedArrays.get(row[column]);
      if (rejected) row[column] = row[column].filter((_, i) => !rejected.has(i));
    }
    if (changedAliases.has(row)) row.search_text = searchTextFor(row);
  }
  const reasonFor = (table, row) => held.get(`${table}:${primaryKeyOf(table, row)}`);
  const subunits = new Map((release.subunits ?? []).filter((row) => reasonFor("subunits", row)).map((row) => [row.subunit_key, reasonFor("subunits", row)]));
  for (const row of release.seat_outlines ?? []) {
    if (subunits.has(row.subunit_key)) holdRow("seat_outlines", row, subunits.get(row.subunit_key));
  }
  const seats = new Map((release.seat_outlines ?? []).filter((row) => reasonFor("seat_outlines", row)).map((row) => [row.outline_key, reasonFor("seat_outlines", row)]));
  const documents = new Map((release.documents ?? []).filter((row) => reasonFor("documents", row)).map((row) => [row.document_key, reasonFor("documents", row)]));
  for (const row of release.document_subunits ?? []) {
    const reasons = [subunits.get(row.subunit_key), documents.get(row.document_key)].filter(Boolean);
    if (reasons.length) holdRow("document_subunits", row, reasons.includes("person") ? "person" : "unknown");
  }
  for (const table of [...Object.keys(FIELDS), "document_subunits"]) {
    if (!release[table]) continue;
    release[table] = release[table].filter((row) => {
      const reason = reasonFor(table, row);
      if (!reason) return true;
      report.drop(`short_name.held.${table}`, reason);
      return false;
    });
  }
  return { heldSubunits: subunits, heldSeats: seats };
}
