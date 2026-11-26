// Fictional research export for the union catalog research translator tests
// (scripts/union-catalog/translate-research-export.mjs), in the shape of
// union-directory-research-export/1. Every body, host and person here is
// invented: catalog keys are the fixture's OLMS file numbers 900000001 and
// up, research-only bodies are `loc-fixture*` and `irs-fixture*`, hosts use
// the reserved .example domain, and the one person (in the poisoned record)
// carries the fixture surname "Fixtureperson".
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportRelease } from "../../scripts/union-catalog/export-release.mjs";
import { TEST_SALT, baseFixture } from "./union-catalog-fixture.mjs";

export const EXPORT_SCHEMA = "union-directory-research-export/1";
export const GATE_CONTRACT = "usability_contract_v5.category_gate";
export const BASE_LABEL = "20261001-01";
export const RESEARCH_LABEL = "20261012-01";
export const UR_PARENT = "ur-62ec29b5e95e";
export const UR_COUNTRY = "ur-628c14c59403";

const sha = (text) => createHash("sha256").update(text).digest("hex");
/** The fixture's record_id for a readable label. */
export const rid = (label) => sha(`record|${label}`);
/** The fixture's target_key for a body. */
export const target = (bodyId) => sha(`target|${bodyId}`);
export const PACKET_SHA = sha("fixture packet one");
export const POISON = Object.freeze({
  name: "Avery Fixtureperson",
  email: "avery.fixtureperson@exampleworkers1.example",
  phone: "802-555-0101",
});

/** Writes the fictional catalog snapshot and exports it as a base release directory. */
export function writeBaseRelease(root, { label = BASE_LABEL, mutate = () => {}, exclusionHashes = [] } = {}) {
  const fixture = baseFixture();
  mutate(fixture);
  const snapshot = join(root, `snapshot-${label}`);
  mkdirSync(join(snapshot, "build"), { recursive: true });
  mkdirSync(join(snapshot, "documents"), { recursive: true });
  writeFileSync(join(snapshot, "build", "enriched.json"), JSON.stringify(fixture.enriched));
  writeFileSync(join(snapshot, "build", "source-data.json"), JSON.stringify({ "index-data.json": { records: fixture.ledger } }));
  writeFileSync(join(snapshot, "documents", "index.json"), JSON.stringify({ generated: null, documents: fixture.documents }));
  const exclusionsFile = join(root, "catalog-exclusions.json");
  writeFileSync(exclusionsFile, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: exclusionHashes }));
  const dir = join(root, `release-${label}`);
  const manifest = exportRelease({ sourceDir: snapshot, outDir: dir, label, env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile } });
  return { dir, manifest, exclusionsFile };
}

const namespace = (bodyId) => bodyId.slice(0, bodyId.indexOf("-"));

/** A bound body object, as export v1 nests it. */
export function body(bodyId) {
  return {
    binding: "bound",
    body_id: bodyId,
    catalog_key_mappable: bodyId.startsWith("olms-"),
    id_namespace: namespace(bodyId),
    independent_publishers: ["registry.example", "exampleworkers1.example"],
    issuer_catalog_target_sha256: target(bodyId),
    two_independent_exact_sources: true,
  };
}

/** Publisher candidates: host claims, always unconfirmed. */
export const candidates = (...ids) => ids.map((id) => ({ binding: "unconfirmed", body_id: id, id_namespace: namespace(id) }));

/** One v1 fact record; `label` names its record_id. */
export function fact(label, overrides = {}) {
  return {
    schema: "union-directory-research-fact/1",
    record_id: rid(label),
    evidence_tier: "research-t2",
    category: "contracts",
    kind: "contract",
    host: "exampleworkers1.example",
    page_key: "https://exampleworkers1.example/contracts",
    source_url: "https://exampleworkers1.example/files/cba-2026.pdf",
    source_raw_sha256: sha(`raw|${label}`),
    source_text_sha256: sha(`text|${label}`),
    as_of: "2026-09-30T22:21:21-04:00",
    packet_sha256: PACKET_SHA,
    fact_index: 0,
    original_fact_sha256: sha(`fact|${label}`),
    country: "US",
    country_evidence_kinds: ["exact_OLMS_filer_address"],
    country_registry_replay_passed: true,
    native_source_replay_passed: true,
    publication_status: "unknown",
    publication_date: null,
    unresolved_codes: [],
    body: body("olms-900000001"),
    publisher_candidates: candidates("olms-900000001"),
    publisher_candidate_count: 1,
    ...overrides,
  };
}

/** An unconfirmed fact: no body, why it has none, and its candidates. */
function unconfirmed(label, ids, overrides = {}) {
  const list = candidates(...ids);
  return fact(label, {
    body: null, body_held_reasons: ["identity_binding_unconfirmed"], publisher_candidates: list,
    publisher_candidate_count: list.length, ...overrides,
  });
}

export function category(bodyId, name, creditKind = "captured_publication") {
  return {
    schema: "union-directory-research-category/1",
    evidence_tier: "research-t3",
    target_key: target(bodyId),
    body_id: bodyId,
    id_namespace: namespace(bodyId),
    catalog_key_mappable: bodyId.startsWith("olms-"),
    category: name,
    contract: GATE_CONTRACT,
    credit_kind: creditKind,
    observation: "category credited by the Q9 category gate; not a per-fact row",
    projection_version: "FIXTURE1-0000000000000000001",
  };
}

/**
 * The default streams: two catalog facts and a duplicate-candidate fact, two
 * held-out facts, three category observations, and an inventory that lists
 * every fact plus one withdrawn record.
 */
export function defaultStreams() {
  const tier2 = [
    fact("cba"),
    unconfirmed("constitution", ["olms-900000004", "olms-900000002", "irs-fixture77"], {
      category: "governing_documents", kind: "governance", host: "testfamily.example",
      page_key: "http://testfamily.example/", source_url: "http://testfamily.example/constitution", as_of: null,
    }),
    fact("loc-bylaws", {
      category: "governing_documents", kind: "governance", host: "localsite.example", page_key: "https://localsite.example/",
      source_url: "https://localsite.example/bylaws.pdf", body: body("loc-fixture01"), publisher_candidates: candidates("loc-fixture01"),
    }),
  ];
  const tier1 = [
    unconfirmed("grievance-form", ["olms-900000001", "olms-900000002"], {
      evidence_tier: "research-t1", category: "grievance_procedures", kind: "grievance", fact_index: 3,
      source_url: "https://exampleworkers1.example/forms/grievance-step-one.pdf", unresolved_codes: [UR_PARENT],
    }),
    unconfirmed("charity-annual", ["irs-fixture02"], {
      evidence_tier: "research-t1", category: "document_candidates", kind: "document", host: "charity.example",
      page_key: "https://charity.example/", source_url: "https://charity.example/annual", unresolved_codes: [UR_COUNTRY],
    }),
  ];
  return {
    tier1,
    tier2,
    tier3: [
      category("olms-900000001", "contracts"),
      category("olms-900000002", "governing_documents", "checked_not_published"),
      category("loc-fixture01", "contracts"),
    ],
    withdrawn: [rid("old-form")],
  };
}

/** The inventory rows for a set of streams: each fact `new`, each withdrawn id `withdrawn`. */
export function inventoryOf(streams) {
  const row = (record, state) => ({
    schema: "union-directory-research-inventory/1", batch_id: "F01-fixture", record_id: record.record_id, state,
    evidence_tier: record.evidence_tier ?? null, host: record.host ?? "exampleworkers1.example", page_key: record.page_key ?? "https://exampleworkers1.example/",
    sha: "0".repeat(40), packet_sha256: PACKET_SHA, fact_index: record.fact_index ?? 0, content_sha256: sha(`content|${record.record_id}`),
    previous_content_sha256: null,
  });
  return [
    ...[...streams.tier1, ...streams.tier2].map((record) => row(record, "new")),
    ...streams.withdrawn.map((id) => row({ record_id: id }, "withdrawn")),
  ];
}

const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

/**
 * Writes a batch directory: MANIFEST.json and the five files it names.
 * `manifest` overrides top-level manifest fields; `files` replaces a file's
 * text (keyed by file name) after its declared sha256 and count are taken
 * from the streams; `inventory` replaces the derived inventory rows.
 */
export function writeResearchExport(dir, streams = defaultStreams(), { manifest = {}, files = {}, inventory = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const records = {
    "tier1-facts.jsonl": streams.tier1,
    "tier2-facts.jsonl": streams.tier2,
    "tier3-categories.jsonl": streams.tier3,
    "inventory.jsonl": inventory ?? inventoryOf(streams),
    "held.jsonl": [],
  };
  const declared = {};
  for (const [file, rows] of Object.entries(records)) {
    const text = jsonl(rows);
    writeFileSync(join(dir, file), files[file] ?? text);
    declared[file] = { path: join("/research/export/batches/F01-fixture", file), records: rows.length, bytes: Buffer.byteLength(text), sha256: sha(text) };
  }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({
    schema: EXPORT_SCHEMA,
    written_at_et: "2026-10-12T02:44:58.195777-04:00",
    batch_id: "F01-fixture",
    produced_by: { unit: "F01", lane: "fixture" },
    consumer_contract: { tier3_definition_locked: `${GATE_CONTRACT}, unchanged by this export` },
    unresolved_legend: { [UR_PARENT]: "Mentioned local lacks its own exact US parent identity", [UR_COUNTRY]: "Body country is non-US or unknown" },
    files: declared,
    counts: { tier1: streams.tier1.length, tier2: streams.tier2.length, tier3: streams.tier3.length },
    ...manifest,
  }));
  return dir;
}
