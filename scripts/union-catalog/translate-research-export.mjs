// Translates the union-directory research export into a complete
// union-catalog-release/1 snapshot that carries two research tables
// 2026-10-12 on the tiered export flow).
//
//   CATALOG_EXCLUSIONS_FILE=/path/outside/every/repo/catalog-exclusions.json \
//     node scripts/union-catalog/translate-research-export.mjs \
//       --export <research export batch dir> --base <accepted release dir> \
//       --base-sha256 <its artifact sha256> --out <new release dir> --label YYYYMMDD-NN \
//       [--previous <active research release dir>]
//
// The output is a cumulative snapshot, never a delta. Activation retires
// every live row a release does not carry, so the seven content tables are
// carried forward unchanged from the pinned base release (pinned by its
// artifact sha256), and the research tables hold every record the export
// currently lists. A research fact leaves only through an inventory row in
// state `withdrawn`, or by being held out (its body no longer maps) after
// the active research release (--previous, or the base when it carries
// research rows) loaded it; those keys are listed in the manifest so the
// loader's plan and load can prove nothing else retires. A held-out key no
// release loaded is not listed.
//
// What it reads: the base release directory (through readRelease, which
// proves the artifact against its manifest) and one export batch directory
// of union-directory-research-export/1: MANIFEST.json plus tier1-facts,
// tier2-facts, tier3-categories and inventory, each checked against its
// sha256 and record count and read twice to refuse a torn file. held.jsonl,
// the exporter's own refusals, is never read. A manifest schema this file
// does not know refuses the run.
//
// Privacy, fail closed. The exporter owns the name-free rule; this file
// refuses, and never repairs:
//   * any input record carrying `quote`, `label`, `value`, `holder`, `name`,
//     `email` or `phone` at any depth, or any field outside the allow-list;
//   * any emitted string, in the release or the held-out sidecar, with an
//     email or phone pattern, an election, candidate, ballot or nomination
//     source URL or title, election-result wording in a title, or a match on
//     the owner's exclusion list (F3, F8, F9);
//   * a role or any other fact kind outside the export v1 kinds, and a
//     record_id that repeats (the export's stable key must name one record).
// A single violation refuses the whole release; nothing is written.
//
// Keys. A record reaches the release only under a catalog key of the base
// release (`olms-N`, the OLMS file number, or `ug-*`) that is a primary
// organization. A fact names its subject only when its nested body is
// `bound`; otherwise it lists its publisher candidates, which are host
// claims and never a subject. Export v1 carries no document title.
// Records on `loc-` or `irs-` bodies, or with no mappable key, are held out
// into research-held.json beside the release, which no loader reads.
//
// It never prints a value from the export; messages name keys, fields and
// counts only.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { assertReleasePrivacy, exclusionMatchCount, readRelease, releaseCounts, unintendedRetirement } from "../load-union-catalog.mjs";
import {
  CATALOG_KEY_PATTERN,
  CONTENT_TABLES,
  RELEASE_LABEL_PATTERN,
  RELEASE_SCHEMA,
  RESEARCH_CATEGORY_OUTCOMES,
  RESEARCH_CODE_PATTERN,
  RESEARCH_FACT_KINDS,
  RESEARCH_GATE_CONTRACTS,
  RESEARCH_MAX_CANDIDATES,
  RESEARCH_UNRESOLVED_PATTERN,
  SHA256_PATTERN,
  isRealIsoDate,
  releaseRecordViolations,
  releaseViolations,
} from "./catalog-shape.mjs";
import {
  ARTIFACT_FILE,
  ID_MAP_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  insideGitRepository,
  loadExclusionList,
  readConfig,
  readStableInput,
  refuseExistingOutput,
} from "./export-release.mjs";
import {
  ELECTION_RESULT_PATTERN,
  ELECTION_SOURCE_PATTERN,
  ExclusionMatcher,
  RESEARCH_FORBIDDEN_FIELDS,
  blockedDomainList,
  containsContactPattern,
  isResearchDigest,
  safeDecode,
} from "./privacy-filter.mjs";

import { LOCALE_COLUMNS, researchLocale } from "./catalog-locale.mjs";

export const TRANSLATOR_VERSION = "research-translator/2";
export const HELD_FILE = "research-held.json";
export const HELD_SCHEMA = "union-catalog-research-held/1";
export const EXPORT_MANIFEST_FILE = "MANIFEST.json";
// The export schemas this translator knows: union-directory-research-export/1,
// the contract the research lane published with batch A89 on 2026-10-12. An
// export under any other schema refuses until an adapter for it is reviewed.
export const KNOWN_EXPORT_SCHEMAS = Object.freeze(["union-directory-research-export/1"]);
// The batch files the manifest names. The translator reads the first four;
// held.jsonl is the exporter's own refusals and is never read.
export const STREAMS = Object.freeze({
  tier1: "tier1-facts.jsonl",
  tier2: "tier2-facts.jsonl",
  tier3: "tier3-categories.jsonl",
  inventory: "inventory.jsonl",
});
const BATCH_FILES = new Set([...Object.values(STREAMS), "held.jsonl"]);
const FACT_SCHEMA = "union-directory-research-fact/1";
const CATEGORY_SCHEMA = "union-directory-research-category/1";
const INVENTORY_SCHEMA = "union-directory-research-inventory/1";
const TIER_OF_STREAM = { tier1: "research-t1", tier2: "research-t2" };
const TIERS = { "research-t1": 1, "research-t2": 2 };
const INVENTORY_STATES = new Set(["new", "unchanged", "updated", "withdrawn"]);

const MANIFEST_FIELDS = new Set([
  "schema", "written_at_et", "batch_id", "produced_by", "owner_authorisation", "source", "consumer_contract",
  "unresolved_legend", "files", "counts", "counts_detail", "store_writes", "model_or_source_calls", "batch_path",
]);
const FILE_FIELDS = new Set(["path", "records", "bytes", "sha256"]);
const FACT_FIELDS = new Set([
  ...LOCALE_COLUMNS,
  "schema", "record_id", "evidence_tier", "category", "kind", "host", "page_key", "source_url", "source_raw_sha256",
  "source_text_sha256", "as_of", "packet_sha256", "fact_index", "original_fact_sha256", "country", "country_evidence_kinds",
  "country_registry_replay_passed", "native_source_replay_passed", "publication_status", "publication_date",
  "unresolved_codes", "body", "body_held_reasons", "publisher_candidates", "publisher_candidate_count",
]);
const BODY_FIELDS = new Set([
  "binding", "body_id", "catalog_key_mappable", "id_namespace", "independent_publishers",
  "issuer_catalog_target_sha256", "two_independent_exact_sources",
]);
const CANDIDATE_FIELDS = new Set(["binding", "body_id", "id_namespace"]);
const CATEGORY_FIELDS = new Set([
  ...LOCALE_COLUMNS,
  "schema", "evidence_tier", "target_key", "body_id", "id_namespace", "catalog_key_mappable", "category", "contract",
  "credit_kind", "observation", "projection_version",
]);
const INVENTORY_FIELDS = new Set([
  "schema", "batch_id", "record_id", "state", "evidence_tier", "host", "page_key", "sha", "packet_sha256", "fact_index",
  "content_sha256", "previous_content_sha256",
]);
const BODY_ID = /^(olms|ug|loc|irs)-[a-z0-9]{1,24}$/;
// B05: catalog_key_mappable is syntactic. It is true for an olms- body, true
// for a ug- body whose id is a catalog key (ug- and ten characters), and
// false for loc-, irs- and any other id. A ug- catalog key exported before
// this rule as false (the research builds' former convention) is still
// accepted. Whether the body is in the base release is decided separately
// (mapBody), for both flags.
const MAPPABLE_RULE = "catalog_key_mappable does not match the body id (true for an olms- body, true or the legacy false for a ug- catalog key, false otherwise)";
function mappableAgrees(flag, bodyId) {
  if (bodyId.startsWith("olms-")) return flag === true;
  if (bodyId.startsWith("ug-") && CATALOG_KEY_PATTERN.test(bodyId)) return flag === true || flag === false;
  return flag === false;
}
const ET_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?([+-]\d{2}:\d{2})$/;
const EASTERN_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function researchFactKey(recordId) {
  return `rf-${sha256(`research-fact|${recordId}`).slice(0, 32)}`;
}

export function researchCategoryKey(targetKey) {
  return `rc-${sha256(`research-category|${targetKey}`).slice(0, 32)}`;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Refuses a forbidden (packet text or person-shaped) key at any depth of a record. */
function assertNoForbiddenKey(value, where) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKey(item, where);
  } else if (isPlainObject(value)) {
    for (const [field, inner] of Object.entries(value)) {
      if (RESEARCH_FORBIDDEN_FIELDS.includes(field)) {
        throw new Error(`privacy: ${where} carries a forbidden ${field} field; the export must be name-free and the release is refused`);
      }
      assertNoForbiddenKey(inner, where);
    }
  }
}

/**
 * The allow-list check every input record passes first. A forbidden field
 * (packet text, or anything person-shaped) anywhere in the record is named as
 * such; any other unknown field means the export does not follow a schema
 * this file knows.
 */
export function assertRecordFields(record, allowed, where) {
  if (!isPlainObject(record)) throw new Error(`${where} is not a JSON object`);
  assertNoForbiddenKey(record, where);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw new Error(`${where} carries ${field}, which the export schema does not define`);
  }
}

function fail(where, problem) {
  throw new Error(`${where}: ${problem}`);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The ET calendar date of an export timestamp, or null when it is not one. */
function etDate(value) {
  const match = typeof value === "string" ? ET_TIMESTAMP.exec(value) : null;
  if (!match || !isRealIsoDate(match[1])) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  // Date parsing accepts other offsets and normalizes 24:00 into tomorrow.
  // Prove the source clock and its seasonal offset actually describe ET before
  // retaining the source's date, including both occurrences of a fall-back hour.
  const parts = Object.fromEntries(EASTERN_CLOCK.formatToParts(timestamp).map(({ type, value: part }) => [type, part]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return date === match[1] && time === match[2] && parts.timeZoneName === `GMT${match[4]}` ? date : null;
}

/**
 * The Tier 3 gate contract a manifest locks. tier3_definition_locked is
 * prose that opens with the contract name ("usability_contract_v5.category_gate,
 * unchanged by this export"); each category record names it exactly again.
 */
function gateContractOf(manifest) {
  const text = manifest.consumer_contract?.tier3_definition_locked;
  if (typeof text !== "string") return null;
  return RESEARCH_GATE_CONTRACTS.find((contract) => text === contract || text.startsWith(`${contract},`)) ?? null;
}

/** Parses and checks a batch MANIFEST.json of a research export. */
export function parseExportManifest(raw) {
  const manifest = JSON.parse(raw);
  if (!isPlainObject(manifest)) throw new Error("the export manifest is not a JSON object");
  if (!KNOWN_EXPORT_SCHEMAS.includes(manifest.schema)) {
    throw new Error(`the export manifest schema is not one this translator knows (${KNOWN_EXPORT_SCHEMAS.join(", ")}); refusing until an adapter for it is reviewed`);
  }
  assertRecordFields(manifest, MANIFEST_FIELDS, "the export manifest");
  if (!etDate(manifest.written_at_et)) throw new Error("the export manifest written_at_et is not an Eastern timestamp");
  if (typeof manifest.batch_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.batch_id)) {
    throw new Error("the export manifest batch_id is not a batch id");
  }
  if (!gateContractOf(manifest)) {
    throw new Error(`the export manifest's tier3_definition_locked is not ${RESEARCH_GATE_CONTRACTS.join(" or ")}; Tier 3 keeps its authorized definition`);
  }
  if (!isPlainObject(manifest.unresolved_legend)
      || !Object.keys(manifest.unresolved_legend).every((code) => RESEARCH_UNRESOLVED_PATTERN.test(code))) {
    throw new Error("the export manifest unresolved_legend is not a map of ur-* codes");
  }
  if (!isPlainObject(manifest.files)) throw new Error("the export manifest files is not an object");
  for (const name of Object.keys(manifest.files)) if (!BATCH_FILES.has(name)) throw new Error(`the export manifest names an unknown file ${name}`);
  for (const name of Object.values(STREAMS)) {
    const file = manifest.files[name];
    assertRecordFields(file, FILE_FIELDS, `the export manifest file ${name}`);
    if (typeof file.path !== "string" || basename(file.path) !== name) throw new Error(`the export manifest file ${name} path does not end in ${name}`);
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) throw new Error(`the export manifest file ${name} sha256 is not a lowercase hex sha256`);
    if (!Number.isInteger(file.records) || file.records < 0) throw new Error(`the export manifest file ${name} records is not a count`);
  }
  return manifest;
}

/** Parses one JSONL stream. Blank lines are not allowed; each line is one record. */
export function parseJsonl(raw, name) {
  if (raw === "") return [];
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      // A JSON.parse message quotes input text, so only the line number is kept.
      throw new Error(`${name} line ${i + 1} is not JSON`);
    }
  });
}

/**
 * Reads a batch directory: its MANIFEST.json and the four streams the
 * translator uses, each read from this directory under its manifest name and
 * proven against the declared sha256 and record count.
 */
export function readResearchExport(exportDir) {
  const dir = resolve(exportDir);
  const manifestInput = readStableInput(join(dir, EXPORT_MANIFEST_FILE), EXPORT_MANIFEST_FILE, (raw) => parseExportManifest(raw));
  const manifest = manifestInput.value;
  const streams = {};
  for (const [stream, file] of Object.entries(STREAMS)) {
    const { sha256: declared, records } = manifest.files[file];
    const input = readStableInput(join(dir, file), file, (raw) => parseJsonl(raw, file));
    if (input.sha256 !== declared) throw new Error(`${file} does not match the sha256 its manifest declares`);
    if (input.value.length !== records) throw new Error(`${file} holds ${input.value.length} records; its manifest declares ${records}`);
    streams[stream] = { ...input, file };
  }
  return { manifest, manifestSha256: manifestInput.sha256, streams };
}

// ---------------------------------------------------------------- record checks

const isSha256 = (v) => typeof v === "string" && SHA256_PATTERN.test(v);
const namespaceOf = (bodyId) => bodyId.slice(0, bodyId.indexOf("-"));

/**
 * Checks one v1 fact record and reduces it to what the release can carry:
 * no page key, packet index, country evidence or replay flags leave here.
 */
function readFact(record, where, tier, legend) {
  assertRecordFields(record, FACT_FIELDS, where);
  if (record.schema !== FACT_SCHEMA) fail(where, `schema is not ${FACT_SCHEMA}`);
  if (!isSha256(record.record_id)) fail(where, "record_id is not a lowercase hex sha256");
  if (record.evidence_tier !== TIER_OF_STREAM[tier]) fail(where, `evidence_tier is not ${TIER_OF_STREAM[tier]}, the tier of its stream`);
  if (!RESEARCH_FACT_KINDS.includes(record.kind)) fail(where, `kind is not one of ${RESEARCH_FACT_KINDS.join("/")}`);
  if (typeof record.source_url !== "string" || !/^https?:\/\//.test(record.source_url) || record.source_url.length > 2000 || !hostOf(record.source_url)) {
    fail(where, "source_url is not an http(s) URL of at most 2000 characters");
  }
  if (typeof record.host !== "string" || !/^[a-z0-9.-]{1,253}$/.test(record.host)) fail(where, "host is not a host name");
  const asOf = etDate(record.as_of);
  if (record.as_of !== null && !asOf) fail(where, "as_of is not null or an Eastern timestamp");
  if (!Array.isArray(record.unresolved_codes) || record.unresolved_codes.length > 10
      || !record.unresolved_codes.every((code) => typeof code === "string" && Object.hasOwn(legend, code))) {
    fail(where, "unresolved_codes is not an array of at most 10 codes the manifest's unresolved_legend defines");
  }
  if (tier === "tier2" && record.unresolved_codes.length > 0) fail(where, "a tier 2 fact carries an unresolved code");
  if (!isSha256(record.packet_sha256)) fail(where, "packet_sha256 is not a lowercase hex sha256");

  let bodyId = null;
  if (record.body !== null) {
    assertRecordFields(record.body, BODY_FIELDS, `${where} body`);
    if (record.body.binding !== "bound") fail(where, "body.binding is not bound; only a bound issuer names its subject");
    if (typeof record.body.body_id !== "string" || !BODY_ID.test(record.body.body_id)) fail(where, "body.body_id is not a body id");
    if (record.body.id_namespace !== namespaceOf(record.body.body_id)) fail(where, "body.id_namespace does not match body.body_id");
    if (!mappableAgrees(record.body.catalog_key_mappable, record.body.body_id)) {
      fail(where, `body.${MAPPABLE_RULE}`);
    }
    bodyId = record.body.body_id;
  }
  if (!Array.isArray(record.publisher_candidates) || record.publisher_candidates.length > RESEARCH_MAX_CANDIDATES) {
    fail(where, `publisher_candidates is not an array of at most ${RESEARCH_MAX_CANDIDATES} candidates`);
  }
  const candidates = record.publisher_candidates.map((candidate, i) => {
    assertRecordFields(candidate, CANDIDATE_FIELDS, `${where} publisher_candidates[${i}]`);
    // A candidate is a host claim, never a subject.
    if (candidate.binding !== "unconfirmed") fail(where, "a publisher candidate is not marked unconfirmed");
    if (typeof candidate.body_id !== "string" || !BODY_ID.test(candidate.body_id)) fail(where, "a publisher candidate body_id is not a body id");
    if (candidate.id_namespace !== namespaceOf(candidate.body_id)) fail(where, "a publisher candidate id_namespace does not match its body_id");
    return candidate.body_id;
  });
  return {
    locale: researchLocale(record),
    id: record.record_id,
    tier: TIERS[record.evidence_tier],
    kind: record.kind,
    url: record.source_url,
    host: record.host,
    asOf,
    bodyId,
    candidates,
    unresolved: [...record.unresolved_codes],
    packetSha256: record.packet_sha256,
  };
}

function readCategory(record, where, gateContract, evaluatedOn) {
  assertRecordFields(record, CATEGORY_FIELDS, where);
  if (record.schema !== CATEGORY_SCHEMA) fail(where, `schema is not ${CATEGORY_SCHEMA}`);
  if (record.evidence_tier !== "research-t3") fail(where, "evidence_tier is not research-t3");
  if (!isSha256(record.target_key)) fail(where, "target_key is not a lowercase hex sha256");
  if (typeof record.body_id !== "string" || !BODY_ID.test(record.body_id)) fail(where, "body_id is not a body id");
  if (record.id_namespace !== namespaceOf(record.body_id)) fail(where, "id_namespace does not match body_id");
  if (!mappableAgrees(record.catalog_key_mappable, record.body_id)) fail(where, MAPPABLE_RULE);
  if (typeof record.category !== "string" || !RESEARCH_CODE_PATTERN.test(record.category)) fail(where, "category is not a category code");
  if (!RESEARCH_CATEGORY_OUTCOMES.includes(record.credit_kind)) fail(where, `credit_kind is not one of ${RESEARCH_CATEGORY_OUTCOMES.join("/")}`);
  if (record.contract !== gateContract) fail(where, "contract is not the manifest's Tier 3 gate contract");
  // target_key names the body the gate evaluated; one observation is one
  // (target, category) pair.
  return { locale: researchLocale(record), id: `${record.target_key}|${record.category}`, bodyId: record.body_id, category: record.category, outcome: record.credit_kind, gateContract, evaluatedOn };
}

function readInventory(record, where) {
  assertRecordFields(record, INVENTORY_FIELDS, where);
  if (record.schema !== INVENTORY_SCHEMA) fail(where, `schema is not ${INVENTORY_SCHEMA}`);
  if (!isSha256(record.record_id)) fail(where, "record_id is not a lowercase hex sha256");
  if (!INVENTORY_STATES.has(record.state)) fail(where, `state is not one of ${[...INVENTORY_STATES].join("/")}`);
  return { id: record.record_id, withdrawn: record.state === "withdrawn" };
}

/**
 * Reads the parsed v1 streams into the translator's record shape. Every
 * record of every stream is checked; one fault refuses the whole release.
 */
export function readExportRecords({ manifest, streams }) {
  const legend = manifest.unresolved_legend;
  const gateContract = gateContractOf(manifest);
  const facts = [];
  for (const tier of ["tier1", "tier2"]) {
    streams[tier].value.forEach((record, i) => facts.push(readFact(record, `${STREAMS[tier]} record ${i + 1}`, tier, legend)));
  }
  const evaluatedOn = etDate(manifest.written_at_et);
  const categories = streams.tier3.value.map((record, i) => readCategory(record, `${STREAMS.tier3} record ${i + 1}`, gateContract, evaluatedOn));
  const inventory = streams.inventory.value.map((record, i) => readInventory(record, `${STREAMS.inventory} record ${i + 1}`));
  return { facts, categories, inventory, gateContract };
}

// ---------------------------------------------------------------- string gate

/**
 * The election-url, email and phone checks over every string a row emits,
 * plus the owner's exclusion list. Used on the held-out sidecar, which the
 * loader's assertReleasePrivacy never sees; the release rows pass both this
 * and assertReleasePrivacy.
 */
export function assertResearchStrings(rows, label, matcher) {
  for (const row of rows) {
    const key = row.fact_key ?? row.category_key ?? "(row)";
    for (const [column, value] of Object.entries(row)) {
      // Keys are hashes or catalog keys, checked by pattern, as in the release gate.
      if (column.endsWith("_key")) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item !== "string" || isResearchDigest(column, item)) continue;
        // publisher_candidates are catalog keys (checked by pattern); a ug-
        // key's ten characters can read as a phone, so only the exclusion
        // list applies to them.
        if (column !== "publisher_candidates" && containsContactPattern(item, { url: column === "url" })) {
          throw new Error(`F8 research gate: ${label}.${column} of ${key} carries an email or phone pattern; refusing the release`);
        }
        if (matcher.matches(item)) throw new Error(`F9 research gate: ${label}.${column} of ${key} matches the exclusion list; refusing the release`);
      }
    }
    if (typeof row.url === "string" && ELECTION_SOURCE_PATTERN.test(safeDecode(row.url))) {
      throw new Error(`F3 research gate: ${label}.url of ${key} is an election, candidate, ballot or nomination source; refusing the release`);
    }
    if (typeof row.title === "string" && (ELECTION_SOURCE_PATTERN.test(row.title) || ELECTION_RESULT_PATTERN.test(row.title))) {
      throw new Error(`F8 research gate: ${label}.title of ${key} carries election wording; refusing the release`);
    }
  }
}

// ---------------------------------------------------------------- translation

/** The base release's primary organizations: the only keys a research row may name. */
function primaryKeysOf(release) {
  return new Set(release.organizations.filter((o) => o.duplicate_of === null || o.duplicate_of === undefined).map((o) => o.catalog_key));
}

function heldReason(bodyId) {
  if (bodyId.startsWith("loc-")) return "loc_body";
  if (bodyId.startsWith("irs-")) return "irs_body";
  return "body_not_in_base";
}

/**
 * Pure translation of the read export records onto a base release. Returns
 * the research tables, the held-out rows, the withdrawn keys and counts.
 * Throws on any structural fault. Withdrawals come from inventory rows in
 * state `withdrawn`, and from held-out facts the base or `previous` release
 * loaded (a key no release loaded is not listed); the inventory and the fact streams must name the same
 * records, each once.
 */
export function translateResearch({ base, previous = null, facts, categories, inventory, gateContract }) {
  const primary = primaryKeysOf(base);
  // The fact keys a release before this one loaded: a held-out fact among
  // them is withdrawn, not silently retired.
  const loadedFacts = new Set([base, previous].flatMap((release) => (release?.research_facts ?? []).map((row) => row.fact_key)));
  const heldLoaded = [];
  const mapBody = (bodyId) => (CATALOG_KEY_PATTERN.test(bodyId) && primary.has(bodyId) ? bodyId : null);
  const researchFacts = [];
  const researchCategories = [];
  const held = { research_facts: [], research_categories: [] };
  const heldCounts = {};
  const countHeld = (table, reason) => {
    const key = `${table}:held_${reason}`;
    heldCounts[key] = (heldCounts[key] ?? 0) + 1;
  };

  const factIds = new Set();
  facts.forEach((record, i) => {
    if (factIds.has(record.id)) {
      fail(`fact ${i + 1}`, "record_id repeats an earlier fact; the export's stable key must name one record");
    }
    factIds.add(record.id);
    const fact = {
      ...record.locale,
      fact_key: researchFactKey(record.id),
      evidence_tier: record.tier,
      binding: record.bodyId === null ? "unconfirmed" : "bound",
      catalog_key: null,
      publisher_candidates: [],
      fact_kind: record.kind,
      // Export v1 carries no document title.
      title: null,
      url: record.url,
      url_host: record.host,
      as_of: record.asOf,
      unresolved: record.unresolved,
      source_sha256: record.packetSha256,
    };
    const candidates = [...new Set(record.candidates.map(mapBody).filter(Boolean))].slice(0, RESEARCH_MAX_CANDIDATES);
    let reason = null;
    if (record.bodyId !== null) {
      fact.catalog_key = mapBody(record.bodyId);
      if (!fact.catalog_key) reason = heldReason(record.bodyId);
    } else if (candidates.length === 0) {
      reason = record.candidates.length === 0 ? "no_candidate" : heldReason(record.candidates[0]);
    }
    if (reason) {
      held.research_facts.push({ ...fact, catalog_key: undefined, body_id: record.bodyId, research_candidates: record.candidates, held_reason: reason });
      countHeld("research_facts", reason);
      if (loadedFacts.has(fact.fact_key)) heldLoaded.push(fact.fact_key);
      return;
    }
    fact.publisher_candidates = candidates;
    researchFacts.push(fact);
  });

  const categoryIds = new Set();
  categories.forEach((record, i) => {
    if (categoryIds.has(record.id)) fail(`category ${i + 1}`, "repeats an earlier observation of the same target_key and category");
    categoryIds.add(record.id);
    const row = {
      ...record.locale,
      category_key: researchCategoryKey(record.id),
      catalog_key: mapBody(record.bodyId),
      evidence_tier: 3,
      category: record.category,
      outcome: record.outcome,
      gate_contract: gateContract,
      evaluated_on: record.evaluatedOn,
    };
    if (!row.catalog_key) {
      const reason = heldReason(record.bodyId);
      held.research_categories.push({ ...row, catalog_key: undefined, body_id: record.bodyId, held_reason: reason });
      countHeld("research_categories", reason);
      return;
    }
    researchCategories.push(row);
  });

  const withdrawn = new Set();
  const listed = new Set();
  inventory.forEach((record, i) => {
    const where = `inventory record ${i + 1}`;
    if (withdrawn.has(record.id) || listed.has(record.id)) fail(where, "record_id repeats an earlier inventory record");
    if (record.withdrawn) {
      if (factIds.has(record.id)) fail(where, "withdraws a fact the fact streams still list");
      withdrawn.add(record.id);
    } else {
      if (!factIds.has(record.id)) fail(where, "lists a record no fact stream carries");
      listed.add(record.id);
    }
  });
  if (listed.size !== factIds.size) {
    throw new Error(`the inventory lists ${listed.size} current records but the fact streams carry ${factIds.size}; refusing an unreconciled export`);
  }

  const byKey = (field) => (a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0);
  researchFacts.sort(byKey("fact_key"));
  researchCategories.sort(byKey("category_key"));
  for (const rows of Object.values(held)) rows.sort(byKey(rows === held.research_facts ? "fact_key" : "category_key"));
  return {
    research_facts: researchFacts,
    research_categories: researchCategories,
    held,
    heldCounts: Object.fromEntries(Object.entries(heldCounts).sort(([a], [b]) => a.localeCompare(b))),
    // Export v1 has no inventory for Tier 3 categories, so none is withdrawn.
    withdrawn: { research_facts: [...[...withdrawn].map(researchFactKey), ...heldLoaded].sort(), research_categories: [] },
  };
}

/**
 * Builds the release payload: the seven content tables of the base, as they
 * are, plus the research tables. Throws unless every row passes its CHECKs,
 * foreign keys and the release privacy gate, the sidecar passes the string
 * gate, and nothing of the base would retire.
 */
export function buildResearchRelease({ base, previous = null, exportData, label, exclusions, blockedDomains }) {
  if (!RELEASE_LABEL_PATTERN.test(label ?? "")) throw new Error("--label must match YYYYMMDD-NN");
  if (label === base.manifest.label) throw new Error("--label must differ from the base release's label");
  const { manifest: exportManifest } = exportData;
  const records = readExportRecords(exportData);
  const translated = translateResearch({ base: base.release, previous: previous?.release ?? null, ...records });

  const payload = {
    schema: RELEASE_SCHEMA,
    filterVersion: base.release.filterVersion,
    label,
    // source_built_at is the public dataAsOf (get_union_catalog_status). The
    // content rows are the base's, so it stays the base's; the export's
    // timestamp is kept on manifest.research, which no public path reads.
    sourceBuiltAt: base.manifest.sourceBuiltAt,
    sourceSha256: exportData.manifestSha256,
  };
  for (const table of CONTENT_TABLES) payload[table] = base.release[table];
  if (Object.hasOwn(base.release, "identifiers")) payload.identifiers = base.release.identifiers;
  payload.research_facts = translated.research_facts;
  payload.research_categories = translated.research_categories;

  const problems = releaseViolations(payload);
  if (problems.length > 0) {
    throw new Error(`${problems.length} row(s) would violate a catalog table constraint:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
  }
  assertReleasePrivacy(payload, { blocked: blockedDomainList(blockedDomains) });
  const matcher = new ExclusionMatcher(exclusions);
  assertResearchStrings(payload.research_facts, "research_facts", matcher);
  assertResearchStrings(payload.research_categories, "research_categories", matcher);
  assertResearchStrings(translated.held.research_facts, "held research_facts", matcher);
  assertResearchStrings(translated.held.research_categories, "held research_categories", matcher);
  // The carried content rows too: an exclusion added after the base was
  // exported refuses here, before anything is written, not first at load.
  const carriedMatches = exclusionMatchCount(payload, new ExclusionMatcher(exclusions));
  if (carriedMatches > 0) throw new Error(`F9 research gate: ${carriedMatches} release value(s) match the exclusion list; refusing the release`);

  const research = {
    translator: TRANSLATOR_VERSION,
    exportSchema: exportManifest.schema,
    exportManifestSha256: exportData.manifestSha256,
    exportBatch: exportManifest.batch_id,
    exportWrittenAt: new Date(exportManifest.written_at_et).toISOString(),
    gateContract: records.gateContract,
    base: {
      label: base.manifest.label,
      artifactSha256: base.manifest.artifact.sha256,
      sourceSha256: base.manifest.sourceSha256,
      filterVersion: base.manifest.filterVersion,
    },
    heldOut: {
      research_facts: translated.held.research_facts.length,
      research_categories: translated.held.research_categories.length,
    },
    withdrawn: translated.withdrawn,
  };
  // The carry-forward proof: against the base, no content row retires, and
  // no research row retires except the ones the export withdraws.
  const retirement = unintendedRetirement(base.release, payload, { research });
  if (retirement.total > 0) throw new Error(`the snapshot would retire ${retirement.total} row(s) of its base; refusing`);
  return { payload, research, held: translated.held, heldCounts: translated.heldCounts, matchCount: matcher.matchCount };
}

// ---------------------------------------------------------------- CLI

export function translateResearchExport({ exportDir, baseDir, baseSha256, previousDir = null, outDir, label, env = process.env, now = new Date(), log = () => {} }) {
  if (!exportDir || !baseDir || !outDir) throw new Error("Pass --export <dir>, --base <release dir>, --base-sha256 <sha256> and --out <release dir>");
  if (typeof baseSha256 !== "string" || !SHA256_PATTERN.test(baseSha256)) throw new Error("--base-sha256 must pin the base release's artifact sha256");
  const exclusions = loadExclusionList(env);
  const out = resolve(outDir);
  if (insideGitRepository(out)) {
    throw new Error("--out points inside a git repository. Release artifacts live outside every repository and are never committed.");
  }
  for (const file of [ARTIFACT_FILE, ID_MAP_FILE, MANIFEST_FILE, HELD_FILE]) refuseExistingOutput(join(out, file));

  const base = readRelease(resolve(baseDir));
  if (base.manifest.artifact.sha256 !== baseSha256) throw new Error("the base release's artifact sha256 is not the pinned one");
  // Read only to learn which fact keys it loaded; plan and load still prove
  // the retirement against the active release and the live rows.
  const previous = previousDir ? readRelease(resolve(previousDir)) : null;
  if (previous && previous.manifest.label === label) throw new Error("--label must differ from the previous release's label");
  const exportData = readResearchExport(exportDir);
  const built = buildResearchRelease({
    base, previous, exportData, label, exclusions, blockedDomains: readConfig("catalog-blocked-email-domains.json"),
  });

  const json = Buffer.from(JSON.stringify(built.payload));
  const gz = gzipSync(json, { level: 9 });
  // The id map is the base's, byte for byte: the organizations are the base's.
  const idMap = readFileSync(join(resolve(baseDir), base.manifest.idMap?.file ?? ID_MAP_FILE));
  const heldBytes = Buffer.from(`${JSON.stringify({ schema: HELD_SCHEMA, label, note: "research-only; never loaded", ...built.held })}\n`);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    releaseSchema: RELEASE_SCHEMA,
    label,
    filterVersion: built.payload.filterVersion,
    createdAt: now.toISOString(),
    sourceBuiltAt: built.payload.sourceBuiltAt,
    sourceSha256: built.payload.sourceSha256,
    inputs: {
      [EXPORT_MANIFEST_FILE]: { sha256: exportData.manifestSha256 },
      ...Object.fromEntries(Object.values(exportData.streams).map(({ file, sha256: digest, bytes }) => [file, { sha256: digest, bytes }])),
      base: { label: base.manifest.label, artifactSha256: base.manifest.artifact.sha256 },
    },
    artifact: { file: ARTIFACT_FILE, sha256: sha256(gz), bytes: gz.length, jsonSha256: sha256(json) },
    idMap: { file: ID_MAP_FILE, sha256: sha256(idMap) },
    counts: releaseCounts(built.payload),
    dropReport: { ...(base.manifest.dropReport ?? {}), ...built.heldCounts },
    exclusions: { fileSha256: exclusions.fileSha256, matchCount: built.matchCount },
    research: { ...built.research, held: { file: HELD_FILE, sha256: sha256(heldBytes) } },
  };
  const recordProblems = releaseRecordViolations(manifest);
  if (recordProblems.length > 0) {
    throw new Error(`The release manifest would violate a catalog_releases constraint:\n  - ${recordProblems.join("\n  - ")}`);
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, ARTIFACT_FILE), gz, { mode: 0o600, flag: "wx" });
  writeFileSync(join(out, ID_MAP_FILE), idMap, { mode: 0o600, flag: "wx" });
  writeFileSync(join(out, HELD_FILE), heldBytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  log(`research release ${label} written to ${out}${sep}`);
  return manifest;
}

function parseArgs(argv) {
  const flags = { "--export": "exportDir", "--base": "baseDir", "--base-sha256": "baseSha256", "--previous": "previousDir", "--out": "outDir", "--label": "label" };
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const name = flags[argv[i]];
    if (!name) throw new Error(`Unknown argument ${argv[i]}. Usage: translate-research-export.mjs --export <dir> --base <release dir> --base-sha256 <sha256> --out <release dir> --label YYYYMMDD-NN [--previous <active research release dir>]`);
    args[name] = argv[i + 1];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = translateResearchExport({ ...parseArgs(process.argv), log: (line) => console.log(line) });
    console.log(`base             ${manifest.research.base.label} (${manifest.research.base.artifactSha256})`);
    for (const [key, value] of Object.entries(manifest.counts)) {
      if (key.startsWith("research_")) console.log(`  ${key.padEnd(32)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
    console.log(`held out         ${JSON.stringify(manifest.research.heldOut)}`);
    console.log(`withdrawn        facts ${manifest.research.withdrawn.research_facts.length}, categories ${manifest.research.withdrawn.research_categories.length}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
