// Table shapes for the public-record union catalog (spec
// docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md §2.2).
//
// Every CHECK and NOT NULL that the private.catalog_* tables declare is
// restated here as a JavaScript predicate. Two callers depend on it:
//
//   * the exporter (privacy-filter.mjs) asserts every row it built before it
//     writes a release, so a filter bug surfaces as a named row, not as a
//     500-row batch failure at load time;
//   * the loader (load-union-catalog.mjs) re-checks every row of a release
//     before it opens a transaction, the way load-union-orgs.mjs does.
//
// Keep this file and the migration in step. A predicate here that is looser
// than the CHECK is a load-time surprise; one that is stricter silently drops
// rows the database would have accepted.

import { LOCALE_TABLES, localeViolations } from "./catalog-locale.mjs";
import { validate as validateProvenance } from "../lib/provenance.mjs";

export const RELEASE_SCHEMA = "union-catalog-release/1";
export const RELEASE_LABEL_PATTERN = /^[0-9]{8}-[0-9]{2}$/;
export const FILTER_VERSION_PATTERN = /^privacy-filter\/[0-9]{1,3}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// An organization name may be long (registered union names reach 622
// characters); it is never shortened (#8743, migration 20261113133200).
export const ORGANIZATION_NAME_MAX = 1000;
export const CATALOG_KEY_PATTERN = /^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$/;
export const SUBUNIT_KEY_PATTERN = /^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})~[a-z_]{3,20}-[0-9a-f]{12}$/;
export const DOCUMENT_KEY_PATTERN = /^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})~[0-9a-f]{16}$/;

export const TIERS = Object.freeze(["national", "regional", "state", "local", "sub_local"]);
export const SECTORS = Object.freeze(["public", "private", "mixed"]);
export const GEO_PRECISIONS = Object.freeze(["zip", "city", "state"]);
export const CONFIDENCES = Object.freeze(["official_site", "secondary", "olms_filing", "not_found", "unreviewed"]);
export const ORIGINS = Object.freeze(["research", "contribution"]);
export const EDGE_KINDS = Object.freeze(["olms_parent", "parent_body", "regional_body", "state_body", "state_federation"]);
export const EDGE_CERTAINTIES = Object.freeze(["filed", "confirmed", "inferred", "split"]);
export const SUBUNIT_KINDS = Object.freeze([
  "chapter", "unit", "bargaining_unit", "retiree_chapter", "local", "district",
  "division", "region", "sector", "department", "council", "committee", "other",
]);
export const SEAT_CLASSES = Object.freeze(["officer", "board", "steward", "delegate"]);
export const CONTACT_KINDS = Object.freeze(["website", "social", "email", "phone", "office_address"]);
export const CONTACT_BASES = Object.freeze(["own_site", "family_national_site"]);
export const DOC_KINDS = Object.freeze(["contract", "bylaws", "form", "newsletter", "handbook", "other"]);

// Research release tables (translate-research-export.mjs). The evidence tier
// is the research chain's, never the organization level the `tier` column of
// organizations means: 1 kept by R1 typing but not R1 to R4 eligible (with
// any ur-* unresolved codes), 2 eligible under R1 to R4, 3 a category
// observation of the versioned Q9 category gate. A fact names its subject
// only when the chain's issuer binding is `bound`; otherwise it lists
// unconfirmed publisher candidates and no subject. Kinds and category
// outcomes are the vocabularies of union-directory-research-export/1.
export const RESEARCH_FACT_KEY_PATTERN = /^rf-[0-9a-f]{32}$/;
export const RESEARCH_CATEGORY_KEY_PATTERN = /^rc-[0-9a-f]{32}$/;
export const RESEARCH_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
export const RESEARCH_UNRESOLVED_PATTERN = /^ur-[0-9a-f]{12}$/;
export const RESEARCH_FACT_KINDS = Object.freeze([
  "contract", "governance", "document", "form", "grievance", "parent", "sub_unit", "jurisdiction", "merger", "bargaining_unit",
]);
export const RESEARCH_MAX_CANDIDATES = 50;
export const RESEARCH_BINDINGS = Object.freeze(["bound", "unconfirmed"]);
export const RESEARCH_CATEGORY_OUTCOMES = Object.freeze(["captured_publication", "checked_not_published"]);
// Tier 3 keeps the definition the owner authorized on 2026-10-12.
export const RESEARCH_GATE_CONTRACTS = Object.freeze(["usability_contract_v5.category_gate"]);

// The release arrays, in load order (parents before children). The two
// research tables are optional in an artifact: a release built by
// export-release.mjs carries neither, and releaseTablesOf() skips them.
export const RELEASE_TABLES = Object.freeze([
  "organizations",
  "edges",
  "subunits",
  "seat_outlines",
  "contacts",
  "documents",
  "document_subunits",
  "research_facts",
  "research_categories",
  "identifiers",
]);
export const RESEARCH_TABLES = Object.freeze(["research_facts", "research_categories"]);
export const OPTIONAL_TABLES = Object.freeze([...RESEARCH_TABLES, "identifiers"]);
export const CONTENT_TABLES = Object.freeze(RELEASE_TABLES.filter((table) => !OPTIONAL_TABLES.includes(table)));

/**
 * The tables a release object carries: the seven content tables always, and a
 * research table only when the release has that key. Counts, sweeps and
 * staging follow this list, so a release without research tables keeps the
 * counts and digest it had before they existed.
 */
export function releaseTablesOf(release) {
  return RELEASE_TABLES.filter((table) => !OPTIONAL_TABLES.includes(table) || Object.hasOwn(release ?? {}, table));
}

// Postgres char_length counts code points; String#length counts UTF-16 units.
export function charLength(value) {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

// Postgres [[:cntrl:]] under a UTF-8 locale: C0 controls, DEL and C1 controls.
export function hasControlCharacter(value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// btrim() with no second argument strips spaces only, not every whitespace.
function btrimSpaces(value) {
  return value.replace(/^ +| +$/g, "");
}

const HTTP_URL = /^https?:\/\//;
const HTTPS_URL = /^https:\/\//;
const STATE = /^[A-Z]{2}$/;
const ZIP5 = /^[0-9]{5}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const isNull = (v) => v === null || v === undefined;
const isText = (v) => typeof v === "string";

export function isRealIsoDate(value) {
  if (!isText(value) || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function fitsNumeric74(value) {
  // numeric(7,4): at most three integer digits, rounded to four decimals.
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1000
    && Math.round(value * 10000) / 10000 === value;
}

function textArray(value, max) {
  return Array.isArray(value) && value.every(isText) && (max === undefined || value.length <= max);
}

function optionalText(out, row, column, max) {
  const v = row[column];
  if (isNull(v)) return;
  if (!isText(v)) out.push(`${column} is not text`);
  else if (charLength(v) > max) out.push(`${column} is longer than ${max}`);
}

function optionalUrl(out, row, column, max, pattern = HTTP_URL) {
  const v = row[column];
  if (isNull(v)) return;
  if (!isText(v) || !pattern.test(v)) out.push(`${column} is not an ${pattern === HTTPS_URL ? "https" : "http(s)"} URL`);
  else if (charLength(v) > max) out.push(`${column} is longer than ${max}`);
}

function requiredUrl(out, row, column, max, pattern = HTTP_URL) {
  if (isNull(row[column])) out.push(`${column} is null`);
  else optionalUrl(out, row, column, max, pattern);
}

function enumValue(out, row, column, values, { nullable = false } = {}) {
  const v = row[column];
  if (isNull(v)) {
    if (!nullable) out.push(`${column} is null`);
    return;
  }
  if (!values.includes(v)) out.push(`${column} ${JSON.stringify(v)} is not one of ${values.join("/")}`);
}

function optionalDate(out, row, column) {
  const v = row[column];
  if (!isNull(v) && !isRealIsoDate(v)) out.push(`${column} is not a real YYYY-MM-DD date`);
}

function optionalInteger(out, row, column, { min, max } = {}) {
  const v = row[column];
  if (isNull(v)) return;
  if (!Number.isInteger(v)) out.push(`${column} is not an integer`);
  else if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
    out.push(`${column} ${v} is outside ${min ?? "-inf"}..${max ?? "inf"}`);
  }
}

function boundedTrimmed(out, row, column, min, max) {
  const v = row[column];
  if (isNull(v)) {
    out.push(`${column} is null`);
    return;
  }
  if (!isText(v)) {
    out.push(`${column} is not text`);
    return;
  }
  const n = charLength(btrimSpaces(v));
  if (n < min || n > max) out.push(`${column} trimmed length ${n} is outside ${min}..${max}`);
}

function requiredKey(out, row, column, pattern) {
  const v = row[column];
  if (!isText(v) || v.length === 0) out.push(`${column} is null`);
  else if (pattern && !pattern.test(v)) out.push(`${column} does not match its key pattern`);
}

const CHECKS = {
  identifiers(row) {
    const out = [];
    requiredKey(out, row, "identifier_key", /^ri-[0-9a-f]{32}$/);
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    if (!isText(row.namespace) || !/^[a-z][a-z0-9_-]{1,39}$/.test(row.namespace) || row.namespace === "olms") out.push("namespace is not a foreign registry namespace");
    if (!isText(row.identifier) || !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/.test(row.identifier)) out.push("identifier is not a bounded registry identifier");
    requiredUrl(out, row, "source_url", 1000);
    if (!isRealIsoDate(row.as_of)) out.push("as_of is not a real YYYY-MM-DD date");
    if (!validateProvenance(row.provenance).ok) out.push("provenance is not a complete, fingerprinted source record");
    else {
      if (row.provenance.source.url !== row.source_url || row.provenance.as_of !== row.as_of) out.push("provenance does not agree with identifier source/as_of");
      // Identifier provenance is a name-free capture receipt. Narrative
      // titles/review notes remain in the canonical evidence corpus.
      if (row.provenance.source.publisher !== new URL(row.provenance.source.url).hostname
          || row.provenance.source.title || row.provenance.review.note || row.provenance.reuse?.note) out.push("identifier provenance carries narrative text instead of a name-free receipt");
    }
    return out;
  },
  organizations(row) {
    const out = [];
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    optionalInteger(out, row, "olms_file_number", { min: 1, max: 2147483647 });
    if (!isNull(row.olms_file_number) && row.catalog_key !== `olms-${row.olms_file_number}`) {
      out.push("catalog_key does not agree with olms_file_number");
    }
    optionalText(out, row, "union_org_id", Number.MAX_SAFE_INTEGER);
    enumValue(out, row, "origin", ORIGINS);
    boundedTrimmed(out, row, "name", 2, ORGANIZATION_NAME_MAX);
    if (isText(row.name) && hasControlCharacter(row.name)) out.push("name contains a control character");
    if (!textArray(row.aka, 20)) out.push("aka is not a text array of at most 20");
    optionalText(out, row, "family", 40);
    optionalText(out, row, "designation", 160);
    optionalText(out, row, "local_number", 20);
    enumValue(out, row, "tier", TIERS);
    optionalText(out, row, "org_type_label", 120);
    enumValue(out, row, "sector", SECTORS, { nullable: true });
    for (const column of ["industries", "occupations", "trades"]) {
      if (!textArray(row[column])) out.push(`${column} is not a text array`);
    }
    optionalText(out, row, "city", Number.MAX_SAFE_INTEGER);
    if ((!Object.hasOwn(row, "country") ? "US" : row.country) === "US") {
      if (!isNull(row.state) && !(isText(row.state) && STATE.test(row.state))) out.push("state is not two capital letters");
      if (!isNull(row.zip5) && !(isText(row.zip5) && ZIP5.test(row.zip5))) out.push("zip5 is not five digits");
    } else if (!isNull(row.state) || !isNull(row.zip5)) out.push("non-US rows must use subdivision/postal_code and leave state/zip5 null");
    optionalText(out, row, "census_region", Number.MAX_SAFE_INTEGER);
    optionalText(out, row, "census_division", Number.MAX_SAFE_INTEGER);
    for (const column of ["latitude", "longitude"]) {
      if (!isNull(row[column]) && !fitsNumeric74(row[column])) out.push(`${column} does not fit numeric(7,4)`);
    }
    if (isNull(row.latitude) !== isNull(row.longitude)) out.push("latitude/longitude are not paired");
    enumValue(out, row, "geo_precision", GEO_PRECISIONS, { nullable: true });
    optionalUrl(out, row, "website", 500);
    optionalInteger(out, row, "members_reported", { min: 0, max: 2147483647 });
    optionalInteger(out, row, "members_fiscal_year", { min: -32768, max: 32767 });
    if (isNull(row.members_reported) !== isNull(row.members_fiscal_year)) out.push("members_reported/members_fiscal_year are not paired");
    optionalText(out, row, "structure_note", 3000);
    optionalInteger(out, row, "election_term_years", { min: 1, max: 10 });
    optionalDate(out, row, "next_election_on");
    optionalUrl(out, row, "bylaws_url", 1000, HTTPS_URL);
    enumValue(out, row, "confidence", CONFIDENCES);
    optionalDate(out, row, "researched_on");
    if (!textArray(row.source_urls, 150)) out.push("source_urls is not a text array of at most 150");
    if (!isNull(row.duplicate_of) && !(isText(row.duplicate_of) && CATALOG_KEY_PATTERN.test(row.duplicate_of))) {
      out.push("duplicate_of is not a catalog key");
    }
    if (!isText(row.search_text)) out.push("search_text is null");
    else if (charLength(row.search_text) > 4000) out.push("search_text is longer than 4000");
    return out;
  },

  edges(row) {
    const out = [];
    requiredKey(out, row, "edge_key");
    requiredKey(out, row, "child_key", CATALOG_KEY_PATTERN);
    if (!isNull(row.parent_key) && !(isText(row.parent_key) && CATALOG_KEY_PATTERN.test(row.parent_key))) {
      out.push("parent_key is not a catalog key");
    }
    if (!isNull(row.parent_label)) {
      if (!isText(row.parent_label)) out.push("parent_label is not text");
      else {
        const n = charLength(row.parent_label);
        if (n < 2 || n > 300) out.push(`parent_label length ${n} is outside 2..300`);
      }
    }
    enumValue(out, row, "edge_kind", EDGE_KINDS);
    enumValue(out, row, "certainty", EDGE_CERTAINTIES);
    optionalUrl(out, row, "source_url", 1000);
    if (isNull(row.parent_key) && isNull(row.parent_label)) out.push("edge has neither parent_key nor parent_label");
    if (!isNull(row.parent_key) && row.parent_key === row.child_key) out.push("edge points at itself");
    return out;
  },

  subunits(row) {
    const out = [];
    requiredKey(out, row, "subunit_key", SUBUNIT_KEY_PATTERN);
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    if (!isNull(row.parent_subunit_key) && !(isText(row.parent_subunit_key) && SUBUNIT_KEY_PATTERN.test(row.parent_subunit_key))) {
      out.push("parent_subunit_key is not a sub-unit key");
    }
    enumValue(out, row, "kind", SUBUNIT_KINDS);
    if (!isText(row.kind_label)) out.push("kind_label is null");
    else {
      const n = charLength(row.kind_label);
      if (n < 1 || n > 60) out.push(`kind_label length ${n} is outside 1..60`);
    }
    boundedTrimmed(out, row, "name", 1, 200);
    optionalText(out, row, "location", 200);
    optionalText(out, row, "employer", 300);
    optionalInteger(out, row, "members", { min: 0, max: 2147483647 });
    optionalText(out, row, "members_source", 300);
    optionalText(out, row, "density_note", 200);
    optionalUrl(out, row, "website", 500);
    optionalText(out, row, "election_note", 300);
    optionalText(out, row, "structure_note", 1000);
    enumValue(out, row, "confidence", CONFIDENCES);
    requiredUrl(out, row, "source_url", 1000);
    optionalDate(out, row, "as_of");
    if (isText(row.subunit_key) && isText(row.catalog_key) && !row.subunit_key.startsWith(`${row.catalog_key}~`)) {
      out.push("subunit_key does not start with its catalog_key");
    }
    return out;
  },

  seat_outlines(row) {
    const out = [];
    requiredKey(out, row, "outline_key");
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    if (!isNull(row.subunit_key) && !(isText(row.subunit_key) && SUBUNIT_KEY_PATTERN.test(row.subunit_key))) {
      out.push("subunit_key is not a sub-unit key");
    }
    enumValue(out, row, "seat_class", SEAT_CLASSES);
    boundedTrimmed(out, row, "title", 1, 120);
    if (!Number.isInteger(row.listed) || row.listed < 0) out.push("listed is not a non-negative integer");
    if (!Number.isInteger(row.vacant) || row.vacant < 0 || (Number.isInteger(row.listed) && row.vacant > row.listed)) {
      out.push("vacant is outside 0..listed");
    }
    requiredUrl(out, row, "source_url", 1000);
    optionalDate(out, row, "as_of");
    // A seat outline carries no holder. The column does not exist; a key that
    // looks like one is a filter bug, so it is a violation here.
    for (const forbidden of ["holder", "name", "email", "phone"]) {
      if (Object.hasOwn(row, forbidden)) out.push(`seat outline carries a ${forbidden} field`);
    }
    return out;
  },

  contacts(row) {
    const out = [];
    requiredKey(out, row, "contact_key");
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    enumValue(out, row, "contact_kind", CONTACT_KINDS);
    if (!isText(row.value)) out.push("value is null");
    else {
      const n = charLength(row.value);
      if (n < 3 || n > 500) out.push(`value length ${n} is outside 3..500`);
    }
    optionalText(out, row, "label", 80);
    enumValue(out, row, "basis", CONTACT_BASES);
    requiredUrl(out, row, "source_url", 1000);
    optionalDate(out, row, "as_of");
    return out;
  },

  documents(row) {
    const out = [];
    requiredKey(out, row, "document_key", DOCUMENT_KEY_PATTERN);
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    if (isText(row.document_key) && row.document_key.split("~")[0] !== row.catalog_key) {
      out.push("document_key does not agree with catalog_key");
    }
    enumValue(out, row, "doc_kind", DOC_KINDS);
    boundedTrimmed(out, row, "title", 1, 300);
    if (typeof row.title_derived !== "boolean") out.push("title_derived is not a boolean");
    requiredUrl(out, row, "url", 2000, HTTPS_URL);
    if (!isText(row.url_host)) out.push("url_host is null");
    else if (charLength(row.url_host) > 253) out.push("url_host is longer than 253");
    optionalDate(out, row, "as_of");
    return out;
  },

  document_subunits(row) {
    const out = [];
    requiredKey(out, row, "document_key", DOCUMENT_KEY_PATTERN);
    requiredKey(out, row, "subunit_key", SUBUNIT_KEY_PATTERN);
    return out;
  },

  research_facts(row) {
    const out = [];
    requiredKey(out, row, "fact_key", RESEARCH_FACT_KEY_PATTERN);
    if (![1, 2].includes(row.evidence_tier)) out.push("evidence_tier is not 1 or 2");
    enumValue(out, row, "binding", RESEARCH_BINDINGS);
    if (!isNull(row.catalog_key) && !(isText(row.catalog_key) && CATALOG_KEY_PATTERN.test(row.catalog_key))) {
      out.push("catalog_key is not a catalog key");
    }
    if ((row.binding === "bound") !== !isNull(row.catalog_key)) out.push("catalog_key is set exactly when binding is bound");
    if (!textArray(row.publisher_candidates, RESEARCH_MAX_CANDIDATES) || !row.publisher_candidates.every((k) => CATALOG_KEY_PATTERN.test(k))) {
      out.push(`publisher_candidates is not an array of at most ${RESEARCH_MAX_CANDIDATES} catalog keys`);
    } else if (new Set(row.publisher_candidates).size !== row.publisher_candidates.length) {
      out.push("publisher_candidates repeats a key");
    }
    if (isNull(row.catalog_key) && Array.isArray(row.publisher_candidates) && row.publisher_candidates.length === 0) {
      out.push("an unbound fact names no publisher candidate");
    }
    enumValue(out, row, "fact_kind", RESEARCH_FACT_KINDS);
    if (!isNull(row.title)) boundedTrimmed(out, row, "title", 1, 300);
    if (isText(row.title) && hasControlCharacter(row.title)) out.push("title contains a control character");
    requiredUrl(out, row, "url", 2000, HTTP_URL);
    if (!isText(row.url_host) || row.url_host.length === 0) out.push("url_host is null");
    else if (charLength(row.url_host) > 253) out.push("url_host is longer than 253");
    optionalDate(out, row, "as_of");
    if (!textArray(row.unresolved, 10) || !row.unresolved.every((code) => RESEARCH_UNRESOLVED_PATTERN.test(code))) {
      out.push("unresolved is not an array of at most 10 ur-* codes");
    } else if (row.evidence_tier === 2 && row.unresolved.length > 0) {
      out.push("a tier 2 fact carries an unresolved reason");
    }
    if (!isText(row.source_sha256) || !SHA256_PATTERN.test(row.source_sha256)) out.push("source_sha256 is not a lowercase hex sha256");
    return out;
  },

  research_categories(row) {
    const out = [];
    requiredKey(out, row, "category_key", RESEARCH_CATEGORY_KEY_PATTERN);
    requiredKey(out, row, "catalog_key", CATALOG_KEY_PATTERN);
    if (row.evidence_tier !== 3) out.push("evidence_tier is not 3");
    if (!isText(row.category) || !RESEARCH_CODE_PATTERN.test(row.category)) out.push("category is not a category code");
    enumValue(out, row, "outcome", RESEARCH_CATEGORY_OUTCOMES);
    enumValue(out, row, "gate_contract", RESEARCH_GATE_CONTRACTS);
    if (!isRealIsoDate(row.evaluated_on)) out.push("evaluated_on is not a real YYYY-MM-DD date");
    return out;
  },
};

/** Every CHECK the named table declares, evaluated in JS. Empty means the row loads. */
export function rowViolations(table, row) {
  const check = CHECKS[table];
  if (!check) throw new Error(`Unknown catalog table ${table}`);
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row is not an object"];
  return [...check(row), ...(LOCALE_TABLES.includes(table) ? localeViolations(row) : [])];
}

const PRIMARY_KEYS = {
  organizations: (r) => r.catalog_key,
  edges: (r) => r.edge_key,
  subunits: (r) => r.subunit_key,
  seat_outlines: (r) => r.outline_key,
  contacts: (r) => r.contact_key,
  documents: (r) => r.document_key,
  document_subunits: (r) => `${r.document_key}|${r.subunit_key}`,
  research_facts: (r) => r.fact_key,
  research_categories: (r) => r.category_key,
  identifiers: (r) => r.identifier_key,
};

export function primaryKeyOf(table, row) {
  return PRIMARY_KEYS[table](row);
}

/**
 * Structural validation of a whole release: every row passes its CHECKs,
 * primary keys are unique, every foreign key resolves inside the release,
 * and no parent_body edge is keyed to a duplicate organization. Returns human-readable problems naming keys only, never values.
 */
export function releaseViolations(release) {
  const problems = [];
  if (!release || release.schema !== RELEASE_SCHEMA) {
    problems.push(`release schema is not ${RELEASE_SCHEMA}`);
    return problems;
  }
  const keys = {};
  for (const table of releaseTablesOf(release)) {
    const rows = release[table];
    if (!Array.isArray(rows)) {
      problems.push(`release.${table} is not an array`);
      continue;
    }
    const seen = new Set();
    for (const row of rows) {
      const key = isNull(row) ? "(null row)" : primaryKeyOf(table, row);
      for (const v of rowViolations(table, row)) problems.push(`${table} ${key}: ${v}`);
      if (seen.has(key)) problems.push(`${table} ${key}: duplicate primary key`);
      seen.add(key);
    }
    keys[table] = seen;
  }
  if (problems.length > 0) return problems;

  const orgs = keys.organizations;
  const subunits = keys.subunits;
  const documents = keys.documents;
  const ref = (table, row, column, target, label) => {
    const v = row[column];
    if (!isNull(v) && !target.has(v)) problems.push(`${table} ${primaryKeyOf(table, row)}: ${column} does not resolve to a ${label}`);
  };
  for (const row of release.organizations) ref("organizations", row, "duplicate_of", orgs, "catalog organization");
  // A parent_body edge is keyed only by an exact name match to a primary
  // filer (privacy-filter.mjs buildEdges), never to a duplicate one.
  const duplicateKeys = new Set(release.organizations.filter((row) => !isNull(row.duplicate_of)).map((row) => row.catalog_key));
  for (const row of release.edges) {
    ref("edges", row, "child_key", orgs, "catalog organization");
    ref("edges", row, "parent_key", orgs, "catalog organization");
    if (row.edge_kind === "parent_body" && duplicateKeys.has(row.parent_key)) {
      problems.push(`edges ${primaryKeyOf("edges", row)}: parent_key names a duplicate organization`);
    }
  }
  for (const row of release.subunits) {
    ref("subunits", row, "catalog_key", orgs, "catalog organization");
    ref("subunits", row, "parent_subunit_key", subunits, "sub-unit");
  }
  for (const row of release.seat_outlines) {
    ref("seat_outlines", row, "catalog_key", orgs, "catalog organization");
    ref("seat_outlines", row, "subunit_key", subunits, "sub-unit");
  }
  for (const row of release.contacts) ref("contacts", row, "catalog_key", orgs, "catalog organization");
  for (const row of release.documents) ref("documents", row, "catalog_key", orgs, "catalog organization");
  for (const row of release.document_subunits) {
    ref("document_subunits", row, "document_key", documents, "document");
    ref("document_subunits", row, "subunit_key", subunits, "sub-unit");
  }
  // A research row may name only a live, primary organization of the same
  // release: a duplicate filer carries no facts (F12).
  const primaryOrgs = new Set([...orgs].filter((key) => !duplicateKeys.has(key)));
  const identifierTuples = new Set();
  for (const row of release.identifiers ?? []) {
    ref("identifiers", row, "catalog_key", primaryOrgs, "primary catalog organization");
    const tuple = JSON.stringify([row.catalog_key, row.namespace, row.identifier]);
    if (identifierTuples.has(tuple)) problems.push(`identifiers ${row.identifier_key}: duplicate registry identifier`);
    identifierTuples.add(tuple);
  }
  for (const row of release.research_facts ?? []) {
    ref("research_facts", row, "catalog_key", primaryOrgs, "primary catalog organization");
    if (row.publisher_candidates.some((key) => !primaryOrgs.has(key))) {
      problems.push(`research_facts ${row.fact_key}: publisher_candidates names a key that is not a primary catalog organization`);
    }
  }
  for (const row of release.research_categories ?? []) {
    ref("research_categories", row, "catalog_key", primaryOrgs, "primary catalog organization");
  }
  return problems;
}

// ---------------------------------------------------------------- private.catalog_releases

// pg_column_size caps on the two jsonb columns. counts keeps the spec's 4096
// (§2.2). drop_report is capped at 16384 in the catalog_releases migration,
// raised from the spec draft's 4096, because the filter's (path, reason) key
// space is far larger than any one release's report.
export const RELEASE_COUNTS_MAX_BYTES = 4096;
export const RELEASE_DROP_REPORT_MAX_BYTES = 16384;

// pg_column_size of a jsonb value is not the length of its JSON text. Measured
// on local Postgres 17.6 with fictional flat objects of short keys and integer
// values, jsonb ran 1.24 to 2.6 times the compact JSON text: about 1.24 for
// drop-report-shaped keys ("contacts.email:unsourced": 12), rising to 2.6
// for one- or two-character keys, because every member costs two 4-byte
// entries plus an aligned numeric. A text-length ratio is therefore not a safe
// bound. jsonbSizeUpperBound instead adds up the jsonb layout per member, with
// the worst case for padding and numeric headers:
//   value:   4 (varlena header) + container
//   object:  4 (count) + per member 8 (key and value entries) + key bytes + value
//   array:   4 (count) + per element 4 + value
//   string:  its UTF-8 bytes;  true, false, null: 0
//   number:  3 (alignment) + 8 (varlena and long numeric header)
//            + 2 per base-10000 digit group, one group more than its text needs
//   nested:  3 (alignment) + container
// Checked against pg_column_size on 64 fictional objects (flat and nested,
// 1 to 120 keys): it was never below the database figure, and at most 31%
// above it. Values from '{}' up are pinned in tests/union-catalog-plan.test.js.
function jsonbValueBound(value) {
  if (value === null || typeof value === "boolean") return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number") return 3 + 8 + 2 * (Math.ceil(String(value).length / 4) + 1);
  return 3 + jsonbContainerBound(value);
}

function jsonbContainerBound(value) {
  if (Array.isArray(value)) return 4 + value.reduce((n, item) => n + 4 + jsonbValueBound(item), 0);
  return 4 + Object.entries(value).reduce((n, [key, item]) => n + 8 + Buffer.byteLength(key, "utf8") + jsonbValueBound(item), 0);
}

/** A conservative upper bound on pg_column_size(value::jsonb) for a JSON-safe object or array. */
export function jsonbSizeUpperBound(value) {
  return 4 + jsonbContainerBound(value);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Every CHECK and NOT NULL on the private.catalog_releases row the load
 * inserts from a release manifest (label, schema_version, filter_version,
 * source_sha256, artifact_sha256, source_built_at, counts, drop_report).
 * Returns problems naming fields and sizes only, never a value.
 */
export function releaseRecordViolations(manifest) {
  if (!isPlainObject(manifest)) return ["manifest is not an object"];
  const problems = [];
  const text = (v) => typeof v === "string";
  if (!text(manifest.label) || !RELEASE_LABEL_PATTERN.test(manifest.label)) problems.push("label does not match YYYYMMDD-NN");
  if (manifest.releaseSchema !== RELEASE_SCHEMA) problems.push(`releaseSchema (schema_version) is not ${RELEASE_SCHEMA}`);
  if (!text(manifest.filterVersion) || !FILTER_VERSION_PATTERN.test(manifest.filterVersion)) {
    problems.push("filterVersion (filter_version) does not match privacy-filter/N");
  }
  if (!text(manifest.sourceSha256) || !SHA256_PATTERN.test(manifest.sourceSha256)) problems.push("sourceSha256 is not a lowercase hex sha256");
  if (!text(manifest.artifact?.sha256) || !SHA256_PATTERN.test(manifest.artifact.sha256)) {
    problems.push("artifact.sha256 is not a lowercase hex sha256");
  }
  if (!text(manifest.sourceBuiltAt) || Number.isNaN(Date.parse(manifest.sourceBuiltAt))) {
    problems.push("sourceBuiltAt (source_built_at) is not a timestamp");
  }
  if (!isPlainObject(manifest.counts)) {
    problems.push("counts is not a JSON object");
  } else {
    const size = jsonbSizeUpperBound(manifest.counts);
    if (size > RELEASE_COUNTS_MAX_BYTES) {
      problems.push(`counts (${Object.keys(manifest.counts).length} keys) may take ${size} bytes as jsonb; the cap is ${RELEASE_COUNTS_MAX_BYTES}`);
    }
  }
  if (manifest.dropReport === null || typeof manifest.dropReport !== "object") {
    problems.push("dropReport is not a JSON object or array");
  } else {
    const size = jsonbSizeUpperBound(manifest.dropReport);
    if (size > RELEASE_DROP_REPORT_MAX_BYTES) {
      problems.push(`dropReport (${Object.keys(manifest.dropReport).length} keys) may take ${size} bytes as jsonb; the cap is ${RELEASE_DROP_REPORT_MAX_BYTES}`);
    }
  }
  return problems;
}
