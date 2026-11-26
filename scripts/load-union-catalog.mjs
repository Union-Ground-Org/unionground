// Loads a privacy-filtered union catalog release into the private catalog
// tables (spec docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md §2.6).
//
//   node scripts/load-union-catalog.mjs plan     --release <dir> [--registry <file>] [--previous <dir>]
//   node scripts/load-union-catalog.mjs load     --release <dir> [--allow-retire <n>]
//   node scripts/load-union-catalog.mjs verify   --release <dir>
//   node scripts/load-union-catalog.mjs activate --release <dir> [--allow-retire <n>]
//
// The design copies scripts/load-union-orgs.mjs: the data is loaded by an
// operator script from a release artifact, never by a migration, and every
// table CHECK is restated in JavaScript (union-catalog/catalog-shape.mjs) so a
// bad row is named before anything is written.
//
// `plan` needs no database. It verifies the release against its manifest
// (artifact sha256, schema, filter version, label, counts), re-runs every
// row CHECK and foreign key inside the release, re-runs the fail-closed
// privacy gate, and prints row counts, drop counts by reason (never values),
// the union_orgs match rate when --registry names an export of
// `select id, olms_file_number from public.union_orgs` as JSON, and candidate
// sub-unit renames when --previous names the prior release directory.
//
// `load`, `verify` and `activate` need SUPABASE_DB_URL and go through the
// same assertExactTarget guard as verify:db: production by project ref, or a
// runner-owned loopback database behind DB_VERIFY_DISPOSABLE_CONFIRM. They
// connect as the database owner, because the private.catalog_* tables grant
// nothing to any Data API role. Each mode runs in one repeatable-read
// transaction that the command line opens and closes; the exported
// loadRelease, verifyRelease and activateRelease never begin or commit, so a
// caller (the DB proof) can run them inside its own transaction and roll
// everything back.
//
// A load never changes what readers see. The three steps are:
//
//   load      re-runs every plan check offline plus the exclusion-list sweep
//             (CATALOG_EXCLUSIONS_FILE is required, as for export), then
//             inserts the release as `staged` and writes every row into
//             private.catalog_staging keyed by (release, table, row key), in
//             500-row batches, with the row's content hash. The live tables
//             are untouched. The withdrawal guard is previewed here against
//             the live rows (refusing early) and enforced again at activation.
//   verify    reads the staged rows of this release, never the live tables,
//             and fails unless they equal the artifact (keys, content hash,
//             counts and nested cardinality, and each union_org_id equal to
//             the public.union_orgs id for its file number), the privacy
//             sweep over them finds nothing (email and phone patterns,
//             blocked domains, exclusion matches), and public.organizations
//             had the same row count before and after the load. PASS stamps
//             verified_at and a digest of the staged rows (verified_sha256)
//             on a staged, retired or failed release (a failed one is staged
//             again). FAIL clears both on whatever release it checked and
//             marks a staged release `failed`.
//   activate  one call to private.catalog_activate_release(label), which
//             refuses an unverified release or one whose staged rows no
//             longer match the verify digest, applies its staged rows to the
//             live tables in one transaction (insert new rows, update changed
//             rows, retire absent rows, never delete; first_release_id is set
//             once) under the withdrawal guard, recomputes coverage, flips the
//             status, clears the verify stamp of the release it retired (a
//             rollback is verify, then activate) and keeps only this
//             release's and the retired release's staging rows. The loader
//             brackets the call with a public.organizations count and rolls
//             back if it moved; a database error from the activation is
//             reported by SQLSTATE, constraint, column and staged row key
//             only, never with a staged value.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { assertExactTarget, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";
import {
  FILTER_VERSION_PATTERN,
  OPTIONAL_TABLES,
  RELEASE_LABEL_PATTERN,
  RELEASE_SCHEMA,
  RELEASE_TABLES,
  RESEARCH_TABLES,
  SHA256_PATTERN,
  primaryKeyOf,
  releaseRecordViolations,
  releaseTablesOf,
  releaseViolations,
  rowViolations,
} from "./union-catalog/catalog-shape.mjs";
import {
  ARTIFACT_FILE,
  ID_MAP_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  loadExclusionList,
  readConfig,
  sha256,
} from "./union-catalog/export-release.mjs";
import {
  ExclusionMatcher,
  assertReleasePrivacy as assertContentPrivacy,
  blockedDomainList,
  containsContactPattern,
  ELECTION_SOURCE_PATTERN,
  safeDecode,
  releaseCounts as contentReleaseCounts,
  sha256Hex,
} from "./union-catalog/privacy-filter.mjs";

import { LOCALE_COLUMNS, LOCALE_TABLES, hasLocale, legacyLocale } from "./union-catalog/catalog-locale.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function releaseCounts(release) {
  return { ...contentReleaseCounts(release), ...(Object.hasOwn(release, "identifiers") ? { identifiers: release.identifiers.length } : {}) };
}

// The older privacy gate predates object-valued provenance. Sweep every
// capture-receipt leaf, while treating only validated hash forms as hashes.
export function assertReleasePrivacy(release, options) {
  // Registry tokens are typed identifiers, like catalog keys: a numeric
  // registry number can resemble a phone. Admit only the validated token,
  // leaving every source/receipt field under the normal privacy sweeps.
  const identifiers = release.identifiers ?? [];
  for (const row of identifiers) if (rowViolations("identifiers", row).length) throw new Error("identifier row failed structural/provenance validation");
  assertContentPrivacy(Object.hasOwn(release, "identifiers") ? { ...release,
    identifiers: identifiers.map(({ identifier: _identifier, ...row }) => row) } : release, options);
  const visit = (value, column) => {
    if (typeof value === "string") {
      if ((column.endsWith("_sha256") && SHA256_PATTERN.test(value)) || /^prov-[0-9a-f]{64}$/.test(value)) return;
      if (containsContactPattern(value, { url: column === "url" })
          || (column === "url" && ELECTION_SOURCE_PATTERN.test(safeDecode(value)))) throw new Error("identifier provenance failed the name-free privacy gate");
    } else if (Array.isArray(value)) for (const item of value) visit(item, column);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) visit(item, key);
  };
  for (const row of release.identifiers ?? []) visit(row.provenance, "provenance");
}

export const MODES = Object.freeze(["plan", "load", "verify", "activate"]);
// The load-time withdrawal guard (§2.6), previewed by plan.
export const RETIRE_LIMITS = Object.freeze({ organizations: 0.03, subunits: 0.1 });

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`, { cause: error });
  }
}

/** Reads a release directory and proves the artifact is the one its manifest describes. */
export function readRelease(dir) {
  const manifest = readJson(join(dir, MANIFEST_FILE), "the release manifest");
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`manifest schema is not ${MANIFEST_SCHEMA}`);
  if (manifest.releaseSchema !== RELEASE_SCHEMA) throw new Error(`manifest release schema is not ${RELEASE_SCHEMA}`);
  if (!RELEASE_LABEL_PATTERN.test(manifest.label ?? "")) throw new Error("manifest label does not match YYYYMMDD-NN");
  if (!FILTER_VERSION_PATTERN.test(manifest.filterVersion ?? "")) throw new Error("manifest filter version does not match privacy-filter/N");
  const artifactFile = manifest.artifact?.file ?? ARTIFACT_FILE;
  const gz = readFileSync(join(dir, artifactFile));
  const actual = sha256(gz);
  if (actual !== manifest.artifact?.sha256) {
    throw new Error(`${artifactFile} does not match its manifest.\n  declared ${manifest.artifact?.sha256}\n  actual   ${actual}`);
  }
  const json = gunzipSync(gz);
  if (manifest.artifact.jsonSha256 && sha256(json) !== manifest.artifact.jsonSha256) {
    throw new Error(`${artifactFile} inflates to JSON that does not match the manifest's jsonSha256`);
  }
  const release = JSON.parse(json.toString("utf8"));
  if (release.schema !== RELEASE_SCHEMA) throw new Error(`release schema is not ${RELEASE_SCHEMA}`);
  if (release.label !== manifest.label) throw new Error("release label disagrees with the manifest");
  if (release.filterVersion !== manifest.filterVersion) throw new Error("release filter version disagrees with the manifest");
  if (release.sourceSha256 !== manifest.sourceSha256) throw new Error("release source sha256 disagrees with the manifest");
  const idMapFile = manifest.idMap?.file ?? ID_MAP_FILE;
  const idMapBytes = readFileSync(join(dir, idMapFile));
  if (sha256(idMapBytes) !== manifest.idMap?.sha256) throw new Error(`${idMapFile} does not match its manifest`);
  return { manifest, release, idMap: JSON.parse(idMapBytes.toString("utf8")) };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Registry rows from an export of public.union_orgs (a JSON array, or {rows: [...]}). */
export function parseRegistryExport(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
  if (!rows) throw new Error("the registry export must be a JSON array of union_orgs rows or an object with a rows array");
  return rows.map((row, i) => {
    const file = row?.olms_file_number ?? row?.olmsFileNumber ?? null;
    const id = row?.id ?? null;
    if (typeof id !== "string" || !id) throw new Error(`registry row ${i} has no text id`);
    const number = file === null || file === "" ? Number.NaN : Number(file);
    return { id, olmsFileNumber: Number.isInteger(number) ? number : null };
  });
}

/** How many catalog organizations the loader would link to a union_orgs row by OLMS file number (§2.1). */
export function registryMatch(release, registryRows) {
  const byFile = new Map();
  let withoutFile = 0;
  for (const row of registryRows) {
    if (row.olmsFileNumber === null) {
      withoutFile += 1;
      continue;
    }
    byFile.set(row.olmsFileNumber, (byFile.get(row.olmsFileNumber) ?? 0) + 1);
  }
  const catalogFiles = release.organizations.filter((o) => Number.isInteger(o.olms_file_number)).map((o) => o.olms_file_number);
  const catalogSet = new Set(catalogFiles);
  const matched = catalogFiles.filter((f) => byFile.has(f)).length;
  const ambiguous = catalogFiles.filter((f) => (byFile.get(f) ?? 0) > 1).length;
  return {
    registryRows: registryRows.length,
    registryRowsWithoutFileNumber: withoutFile,
    catalogOrganizationsWithFileNumber: catalogFiles.length,
    matched,
    matchRate: catalogFiles.length === 0 ? 0 : matched / catalogFiles.length,
    catalogWithoutRegistryRow: catalogFiles.length - matched,
    catalogMatchingSeveralRegistryRows: ambiguous,
    registryRowsWithoutCatalogEntry: registryRows.filter((r) => r.olmsFileNumber !== null && !catalogSet.has(r.olmsFileNumber)).length,
  };
}

/**
 * Compares two releases by stable key. A sub-unit that disappears and a
 * sub-unit of the same kind that appears in the same organization is a
 * candidate rename: the load treats it as retire plus add (§2.2).
 */
export function compareReleases(previous, current) {
  const keys = (release, table, field) => new Set(release[table].map((row) => row[field]));
  const prevOrgs = keys(previous, "organizations", "catalog_key");
  const currOrgs = keys(current, "organizations", "catalog_key");
  const prevSubs = new Map(previous.subunits.map((s) => [s.subunit_key, s]));
  const currSubs = new Map(current.subunits.map((s) => [s.subunit_key, s]));
  const retiredSubs = [...prevSubs.values()].filter((s) => !currSubs.has(s.subunit_key));
  const addedSubs = [...currSubs.values()].filter((s) => !prevSubs.has(s.subunit_key));
  const addedByOrgKind = new Map();
  for (const s of addedSubs) {
    const k = `${s.catalog_key}|${s.kind}`;
    addedByOrgKind.set(k, [...(addedByOrgKind.get(k) ?? []), s.subunit_key]);
  }
  const renames = [];
  for (const s of retiredSubs) {
    const pool = addedByOrgKind.get(`${s.catalog_key}|${s.kind}`);
    if (pool && pool.length > 0) renames.push({ from: s.subunit_key, to: pool.shift() });
  }
  const retiredOrgs = [...prevOrgs].filter((k) => !currOrgs.has(k)).length;
  return {
    organizationsRetired: retiredOrgs,
    organizationsAdded: [...currOrgs].filter((k) => !prevOrgs.has(k)).length,
    organizationsRetiredShare: prevOrgs.size === 0 ? 0 : retiredOrgs / prevOrgs.size,
    subunitsRetired: retiredSubs.length,
    subunitsAdded: addedSubs.length,
    subunitsRetiredShare: prevSubs.size === 0 ? 0 : retiredSubs.length / prevSubs.size,
    candidateRenames: renames,
  };
}

/**
 * The keys a research release says it withdraws on purpose, by table
 * (manifest.research.withdrawn, written by translate-research-export.mjs).
 * Only research rows are ever withdrawn this way; the seven content tables
 * are carried forward from the pinned base release unchanged.
 */
export function withdrawnKeys(manifest) {
  const withdrawn = manifest?.research?.withdrawn ?? {};
  return Object.fromEntries(RELEASE_TABLES.map((table) => [
    table,
    new Set(RESEARCH_TABLES.includes(table) && Array.isArray(withdrawn[table]) ? withdrawn[table] : []),
  ]));
}

/**
 * Every row of `previous` that `current` no longer carries, per table, split
 * into the ones the manifest withdraws on purpose and the rest. A research
 * release is a cumulative snapshot, never a delta: activation retires every
 * live row it does not carry, so any unintended retirement refuses it.
 */
export function unintendedRetirement(previous, current, manifest) {
  const withdrawn = withdrawnKeys(manifest);
  const tables = {};
  let total = 0;
  for (const table of RELEASE_TABLES) {
    const kept = new Set((current[table] ?? []).map((row) => primaryKeyOf(table, row)));
    const retired = (previous[table] ?? []).map((row) => primaryKeyOf(table, row)).filter((key) => !kept.has(key));
    const unintended = retired.filter((key) => !withdrawn[table].has(key)).sort();
    tables[table] = { retired: retired.length, withdrawn: retired.length - unintended.length, unintended: unintended.length, first: unintended.slice(0, 3) };
    total += unintended.length;
  }
  return { total, tables };
}

function assertNoUnintendedRetirement(retirement, against) {
  if (retirement.total === 0) return;
  const named = Object.entries(retirement.tables)
    .filter(([, t]) => t.unintended > 0)
    .map(([table, t]) => `${table} ${t.unintended} (first: ${t.first.join(", ")})`);
  throw new Error(`a research release must not retire a row it does not withdraw on purpose, but against ${against} it would retire: ${named.join("; ")}`);
}

/** Everything plan checks and reports. Throws on any fault; returns the report otherwise. */
export function planRelease({ manifest, release }, { registryRows = null, previousRelease = null, blockedDomains = null } = {}) {
  const recordProblems = releaseRecordViolations(manifest);
  if (recordProblems.length > 0) {
    throw new Error(`The release manifest would violate a catalog_releases constraint:\n  - ${recordProblems.join("\n  - ")}`);
  }
  const problems = releaseViolations(release);
  if (problems.length > 0) {
    throw new Error(`${problems.length} row(s) would violate a catalog table constraint:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
  }
  // The research guards (the base and live retirement checks at load, the
  // active-release recheck at activation) key on manifest.research, so an
  // artifact carrying research tables must carry that block, base included.
  const carriesResearch = RESEARCH_TABLES.some((table) => Object.hasOwn(release, table));
  if (carriesResearch !== Boolean(manifest.research)) {
    throw new Error(carriesResearch
      ? "the release carries research tables but its manifest has no research block; translate it again"
      : "the manifest has a research block but the release carries no research table");
  }
  if (carriesResearch && !SHA256_PATTERN.test(manifest.research.base?.artifactSha256 ?? "")) {
    throw new Error("the research manifest does not name its base release artifact");
  }
  assertReleasePrivacy(release, { blocked: blockedDomainList(blockedDomains ?? readConfig("catalog-blocked-email-domains.json")) });
  const counts = releaseCounts(release);
  if (stableStringify(counts) !== stableStringify(manifest.counts)) {
    throw new Error("release row counts disagree with the manifest counts");
  }
  let retirement = null;
  if (previousRelease) {
    retirement = unintendedRetirement(previousRelease, release, manifest);
    if (manifest.research) assertNoUnintendedRetirement(retirement, "the previous release");
  }
  return {
    label: manifest.label,
    filterVersion: manifest.filterVersion,
    sourceBuiltAt: manifest.sourceBuiltAt,
    artifactSha256: manifest.artifact.sha256,
    rows: Object.fromEntries(releaseTablesOf(release).map((t) => [t, release[t].length])),
    counts,
    dropReport: manifest.dropReport ?? {},
    exclusionMatches: manifest.exclusions?.matchCount ?? 0,
    registry: registryRows ? registryMatch(release, registryRows) : null,
    comparison: previousRelease ? compareReleases(previousRelease, release) : null,
    research: manifest.research ? { base: manifest.research.base, heldOut: manifest.research.heldOut ?? {} } : null,
    retirement,
  };
}

const percent = (n) => `${(n * 100).toFixed(1)}%`;

/** The plan report as printable lines. Keys and counts only, never a dataset value. */
export function formatPlan(report) {
  const lines = [
    `release          ${report.label} (${report.filterVersion})`,
    `source built at  ${report.sourceBuiltAt}`,
    `artifact sha256  ${report.artifactSha256}`,
    "rows:",
  ];
  for (const [table, n] of Object.entries(report.rows)) lines.push(`  ${table.padEnd(20)} ${n}`);
  lines.push("drops by reason (counts only):");
  const drops = Object.entries(report.dropReport);
  if (drops.length === 0) lines.push("  (none)");
  for (const [key, n] of drops) lines.push(`  ${key.padEnd(58)} ${n}`);
  lines.push(`exclusion-list matches: ${report.exclusionMatches}`);
  if (report.registry) {
    const r = report.registry;
    lines.push(
      "union_orgs match (OLMS file number, offline):",
      `  registry rows                         ${r.registryRows} (${r.registryRowsWithoutFileNumber} without a file number)`,
      `  catalog organizations with a file no. ${r.catalogOrganizationsWithFileNumber}`,
      `  matched                               ${r.matched} (${percent(r.matchRate)})`,
      `  catalog entries with no registry row  ${r.catalogWithoutRegistryRow}`,
      `  catalog entries matching >1 row       ${r.catalogMatchingSeveralRegistryRows}`,
      `  registry rows with no catalog entry   ${r.registryRowsWithoutCatalogEntry}`,
    );
  } else {
    lines.push("union_orgs match: not computed (pass --registry <export of public.union_orgs id, olms_file_number>)");
  }
  if (report.comparison) {
    const c = report.comparison;
    const orgGuard = c.organizationsRetiredShare > RETIRE_LIMITS.organizations ? "  <- load would refuse without --allow-retire" : "";
    const subGuard = c.subunitsRetiredShare > RETIRE_LIMITS.subunits ? "  <- load would refuse without --allow-retire" : "";
    lines.push(
      "against the previous release:",
      `  organizations retired ${c.organizationsRetired} (${percent(c.organizationsRetiredShare)}), added ${c.organizationsAdded}${orgGuard}`,
      `  sub-units retired     ${c.subunitsRetired} (${percent(c.subunitsRetiredShare)}), added ${c.subunitsAdded}${subGuard}`,
      `  candidate sub-unit renames ${c.candidateRenames.length}`,
    );
    for (const pair of c.candidateRenames.slice(0, 20)) lines.push(`    ${pair.from} -> ${pair.to}`);
    if (c.candidateRenames.length > 20) lines.push(`    ... and ${c.candidateRenames.length - 20} more`);
  } else {
    lines.push("candidate sub-unit renames: not computed (pass --previous <prior release dir>)");
  }
  if (report.research) {
    lines.push(
      `research release on base ${report.research.base?.label ?? "(none)"} (artifact ${report.research.base?.artifactSha256 ?? "unknown"})`,
      `  held out of the release (loc-/irs- or unmapped, research-only sidecar): ${Object.entries(report.research.heldOut).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
    );
  }
  if (report.retirement) {
    lines.push(`retirement against the previous release, per table (unintended must be 0 for a research release): ${report.retirement.total} unintended`);
    for (const [table, t] of Object.entries(report.retirement.tables)) {
      lines.push(`  ${table.padEnd(20)} retired ${t.retired}, withdrawn on purpose ${t.withdrawn}, unintended ${t.unintended}`);
    }
  } else {
    lines.push("unintended retirement: not computed (pass --previous <active release dir>)");
  }
  lines.push("", `PLAN: release ${report.label} passes every row check, foreign key and privacy gate. Nothing was written.`);
  return lines;
}

export function parseArgs(argv) {
  const mode = argv[2];
  if (!MODES.includes(mode)) {
    throw new Error(`Usage: node scripts/load-union-catalog.mjs <${MODES.join("|")}> --release <dir>   (got ${mode ?? "nothing"})`);
  }
  const args = { mode, release: null, registry: null, previous: null, allowRetire: null };
  for (let i = 3; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--release") args.release = value;
    else if (flag === "--registry") args.registry = value;
    else if (flag === "--previous") args.previous = value;
    else if (flag === "--allow-retire") {
      if (!/^[0-9]{1,9}$/.test(value ?? "")) throw new Error("--allow-retire takes the most rows (organizations plus sub-units) that may retire, as a whole number");
      args.allowRetire = Number(value);
    } else throw new Error(`Unknown argument ${flag}`);
  }
  if (!args.release) throw new Error("Pass --release <release dir>");
  if (args.allowRetire !== null && !["load", "activate"].includes(args.mode)) throw new Error("--allow-retire applies to load and activate only");
  return args;
}

export function runPlan(args) {
  const current = readRelease(args.release);
  if (current.manifest.research && !args.previous) {
    throw new Error("a research release needs --previous <the active release dir>, so plan can prove it retires nothing it does not withdraw");
  }
  const registryRows = args.registry ? parseRegistryExport(readFileSync(args.registry, "utf8")) : null;
  const previousRelease = args.previous ? readRelease(args.previous).release : null;
  return formatPlan(planRelease(current, { registryRows, previousRelease }));
}

// ---------------------------------------------------------------- database half

export const BATCH_SIZE = 500;

// The release columns of each content table, in DDL order. A release row
// carries exactly these keys; activation adds the four bookkeeping columns
// (first_release_id, last_release_id, retired_release_id, content_sha256).
export const LEGACY_RELEASE_COLUMNS = Object.freeze({
  organizations: Object.freeze([
    "catalog_key", "olms_file_number", "union_org_id", "origin", "name", "aka", "family", "designation",
    "local_number", "tier", "org_type_label", "sector", "industries", "occupations", "trades", "city", "state",
    "zip5", "census_region", "census_division", "latitude", "longitude", "geo_precision", "website",
    "members_reported", "members_fiscal_year", "structure_note", "election_term_years", "next_election_on",
    "bylaws_url", "confidence", "researched_on", "source_urls", "duplicate_of", "search_text",
  ]),
  edges: Object.freeze(["edge_key", "child_key", "parent_key", "parent_label", "edge_kind", "certainty", "source_url"]),
  subunits: Object.freeze([
    "subunit_key", "catalog_key", "parent_subunit_key", "kind", "kind_label", "name", "location", "employer",
    "members", "members_source", "density_note", "website", "election_note", "structure_note", "confidence",
    "source_url", "as_of",
  ]),
  seat_outlines: Object.freeze([
    "outline_key", "catalog_key", "subunit_key", "seat_class", "title", "listed", "vacant", "source_url", "as_of",
  ]),
  contacts: Object.freeze(["contact_key", "catalog_key", "contact_kind", "value", "label", "basis", "source_url", "as_of"]),
  documents: Object.freeze(["document_key", "catalog_key", "doc_kind", "title", "title_derived", "url", "url_host", "as_of"]),
  document_subunits: Object.freeze(["document_key", "subunit_key"]),
  research_facts: Object.freeze([
    "fact_key", "evidence_tier", "binding", "catalog_key", "publisher_candidates", "fact_kind", "title", "url",
    "url_host", "as_of", "unresolved", "source_sha256",
  ]),
  research_categories: Object.freeze([
    "category_key", "catalog_key", "evidence_tier", "category", "outcome", "gate_contract", "evaluated_on",
  ]),
  identifiers: Object.freeze(["identifier_key", "catalog_key", "namespace", "identifier", "source_url", "as_of", "provenance"]),
});

export const RELEASE_COLUMNS = Object.freeze(Object.fromEntries(Object.entries(LEGACY_RELEASE_COLUMNS)
  .map(([table, columns]) => [table, Object.freeze([...columns, ...(LOCALE_TABLES.includes(table) ? LOCALE_COLUMNS : [])])])));

export const KEY_COLUMNS = Object.freeze({
  organizations: Object.freeze(["catalog_key"]),
  edges: Object.freeze(["edge_key"]),
  subunits: Object.freeze(["subunit_key"]),
  seat_outlines: Object.freeze(["outline_key"]),
  contacts: Object.freeze(["contact_key"]),
  documents: Object.freeze(["document_key"]),
  document_subunits: Object.freeze(["document_key", "subunit_key"]),
  research_facts: Object.freeze(["fact_key"]),
  research_categories: Object.freeze(["category_key"]),
  identifiers: Object.freeze(["identifier_key"]),
});

const TABLE_NAMES = Object.freeze(Object.fromEntries(RELEASE_TABLES.map((t) => [t, `private.catalog_${t}`])));
const STAGING_TABLE = "private.catalog_staging";

/**
 * The digest of one release's staged rows ($1 is the release id): sha256 over
 * every row's table, key, content hash and a sha256 of its stored content, in
 * (table_name, row_key) order. verify stores it as verified_sha256 on PASS;
 * private.catalog_activate_release recomputes the same expression and
 * refuses when it differs, so a staged row changed after verify (its content
 * or its content hash) is never applied.
 */
export const STAGING_DIGEST_SQL = "select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(\n"
  + "         s.table_name || ' ' || s.row_key || ' ' || s.content_sha256 || ' '\n"
  + "           || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.content::text, 'UTF8')), 'hex'),\n"
  + "         pg_catalog.chr(10) order by s.table_name, s.row_key), ''), 'UTF8')), 'hex') as digest\n"
  + `  from ${STAGING_TABLE} as s\n`
  + " where s.release_id = $1";

function releaseColumnsOf(table, row) {
  // Keep pre-international hashes and staging bytes unchanged. SQL supplies
  // US defaults only after verifying the staged digest.
  const columns = hasLocale(row) ? RELEASE_COLUMNS[table] : LEGACY_RELEASE_COLUMNS[table];
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

/** sha256 over the row's release columns, key order independent. */
export function contentSha256(table, row) {
  return sha256Hex(stableStringify(releaseColumnsOf(table, row)));
}

/** The staging row key: the key columns joined by "|" (one column for every table but document_subunits). */
export function rowKeyOf(table, row) {
  return KEY_COLUMNS[table].map((column) => row[column]).join("|");
}

/**
 * Multi-row insert into private.catalog_staging. $1 is the release id, $2 the
 * table name; each row adds its key, its release columns as jsonb and its hash.
 */
export function stagingSql(rowCount) {
  const tuples = [];
  for (let r = 0; r < rowCount; r += 1) {
    const base = 3 + r * 3;
    tuples.push(`($1, $2, $${base}, $${base + 1}::jsonb, $${base + 2})`);
  }
  return `insert into ${STAGING_TABLE} (release_id, table_name, row_key, content, content_sha256)\n`
    + `values ${tuples.join(",\n       ")}`;
}

/** Parameters for stagingSql: the release id, the table name, then key, content JSON and hash per row. */
export function stagingValues(table, rows, releaseId) {
  const values = [releaseId, table];
  for (const row of rows) {
    const content = releaseColumnsOf(table, row);
    values.push(rowKeyOf(table, row), JSON.stringify(content), sha256Hex(stableStringify(content)));
  }
  return values;
}

function keyArrays(table, rows) {
  return KEY_COLUMNS[table].map((column) => rows.map((row) => row[column]));
}

function keyJoin(table, offset) {
  const keys = KEY_COLUMNS[table];
  const arrays = keys.map((_, i) => `$${offset + i}::text[]`).join(", ");
  return {
    source: `unnest(${arrays}) as k(${keys.join(", ")})`,
    match: keys.map((k) => `k.${k} = t.${k}`).join(" and "),
  };
}

// The staging row key of a live row, as SQL over alias t (rowKeyOf).
function rowKeySql(table) {
  return KEY_COLUMNS[table].map((column) => `t.${column}`).join(" || '|' || ");
}

/** The live rows of `table` whose staging row key is not in $1, the keys a release carries. */
export function retiringKeysSql(table) {
  const key = rowKeySql(table);
  return `select ${key} as row_key\n`
    + `from ${TABLE_NAMES[table]} as t\n`
    + `where t.retired_release_id is null and not (${key} = any($1::text[]))\n`
    + "order by 1";
}

/**
 * The live rows activating a research release would retire, per table, less
 * the research rows its manifest withdraws on purpose. Any remainder refuses
 * the load: a research release is a cumulative snapshot, never a delta.
 */
export async function liveUnintendedRetirement(client, rows, manifest) {
  const withdrawn = withdrawnKeys(manifest);
  const tables = {};
  let total = 0;
  for (const table of RELEASE_TABLES) {
    const carried = (rows[table] ?? []).map((row) => rowKeyOf(table, row));
    const { rows: retiring } = await client.query(retiringKeysSql(table), [carried]);
    const unintended = retiring.map((row) => row.row_key).filter((key) => !withdrawn[table].has(key));
    tables[table] = { retired: retiring.length, withdrawn: retiring.length - unintended.length, unintended: unintended.length, first: unintended.slice(0, 3) };
    total += unintended.length;
  }
  return { total, tables };
}

/** Live rows of `table`, and how many of them activating the release would retire. */
export function retirePreviewSql(table) {
  const { source, match } = keyJoin(table, 1);
  return `select count(*)::integer as live,\n`
    + `       count(*) filter (where k.${KEY_COLUMNS[table][0]} is null)::integer as retiring\n`
    + `from ${TABLE_NAMES[table]} as t left join ${source} on ${match}\n`
    + "where t.retired_release_id is null";
}

/**
 * The withdrawal guard (§2.6), previewed at load and enforced again by
 * private.catalog_activate_release. Refuses when more than 3% of live
 * organizations or 10% of live sub-units would retire, unless allowRetire
 * names the most rows (organizations plus sub-units) the operator accepts.
 * An explicit allowRetire is a ceiling in every case.
 */
export function withdrawalDecision(preview, allowRetire = null) {
  const share = ({ live, retiring }) => (live === 0 ? 0 : retiring / live);
  const organizationsShare = share(preview.organizations);
  const subunitsShare = share(preview.subunits);
  const total = preview.organizations.retiring + preview.subunits.retiring;
  const overLimit = organizationsShare > RETIRE_LIMITS.organizations || subunitsShare > RETIRE_LIMITS.subunits;
  const describe = `${preview.organizations.retiring} of ${preview.organizations.live} live organizations (${percent(organizationsShare)}) `
    + `and ${preview.subunits.retiring} of ${preview.subunits.live} live sub-units (${percent(subunitsShare)}) would retire`;
  let refusal = null;
  if (allowRetire !== null && total > allowRetire) {
    refusal = `withdrawal guard: ${describe}, ${total} rows in all, more than --allow-retire ${allowRetire}`;
  } else if (overLimit && allowRetire === null) {
    refusal = `withdrawal guard: ${describe}; the limits are ${percent(RETIRE_LIMITS.organizations)} and ${percent(RETIRE_LIMITS.subunits)}. `
      + `Re-run with --allow-retire ${total} after checking the plan against the previous release.`;
  }
  return { organizationsShare, subunitsShare, total, overLimit, refusal, describe };
}

export function assertReleaseColumns(release) {
  for (const table of releaseTablesOf(release)) {
    const expected = new Set(RELEASE_COLUMNS[table]);
    for (const row of release[table]) {
      const extra = Object.keys(row).find((column) => !expected.has(column));
      if (extra) throw new Error(`${table} ${rowKeyOf(table, row)} carries ${extra}, which private.catalog_${table} does not have`);
    }
  }
}

function* stringsOf(row) {
  for (const value of Object.values(row)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") yield item;
      else if (item && typeof item === "object") yield* stringsOf(item);
    }
  }
}

/** How many strings in the release match the owner's exclusion list (F9). Counts only, never a value. */
export function exclusionMatchCount(release, matcher) {
  let matches = 0;
  for (const table of releaseTablesOf(release)) {
    for (const row of release[table]) for (const value of stringsOf(row)) if (matcher.matches(value)) matches += 1;
  }
  return matches;
}

async function stageReleaseRow(client, manifest, counts, research = null) {
  const label = manifest.label;
  const record = [
    RELEASE_SCHEMA, manifest.filterVersion, manifest.sourceSha256, manifest.artifact.sha256, manifest.sourceBuiltAt,
    JSON.stringify(counts), JSON.stringify(manifest.dropReport ?? {}),
  ];
  const markers = [research?.baseSha256 ?? null, research?.loadedOver ?? null];
  const { rows: [existing] } = await client.query(
    "select id, status, artifact_sha256 from private.catalog_releases where label = $1 for update",
    [label],
  );
  if (!existing) {
    const { rows: [inserted] } = await client.query(
      `insert into private.catalog_releases
         (label, status, schema_version, filter_version, source_sha256, artifact_sha256, source_built_at, counts, drop_report,
          research_base_sha256, research_loaded_over)
       values ($1, 'staged', $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       returning id`,
      [label, ...record, ...markers],
    );
    return { id: inserted.id, restaged: null };
  }
  if (existing.artifact_sha256 !== manifest.artifact.sha256) {
    throw new Error(`release ${label} is already loaded from a different artifact; a label names exactly one artifact`);
  }
  // The active release's staging rows are the live rows; re-loading it would
  // only turn it back into a staged release. Roll back by activating the
  // previous release instead.
  if (existing.status === "active") throw new Error(`release ${label} is already active; there is nothing to load`);
  // A staged, failed or retired label is staged again from the same artifact:
  // its staging rows are rewritten and it must be verified again before it
  // can be activated.
  await client.query(`delete from ${STAGING_TABLE} where release_id = $1`, [existing.id]);
  await client.query(
    `update private.catalog_releases
        set status = 'staged', activated_at = null, activation_diff = '{}'::jsonb, loaded_at = pg_catalog.now(),
            verified_at = null, verified_sha256 = null, counts = $2::jsonb, drop_report = $3::jsonb,
            research_base_sha256 = $4, research_loaded_over = $5
      where id = $1`,
    [existing.id, record[5], record[6], ...markers],
  );
  return { id: existing.id, restaged: existing.status };
}

/**
 * union_org_id is a soft link (§2.1): the release always carries null, and the
 * loader fills it wherever public.union_orgs has the same file number. Load
 * and verify both resolve it here, so verify compares every staged value with
 * the registry as it stands.
 */
async function withRegistryLinks(client, organizations) {
  const files = organizations.map((o) => o.olms_file_number).filter(Number.isInteger);
  const { rows: registry } = await client.query(
    "select id, olms_file_number from public.union_orgs where olms_file_number = any($1::integer[])",
    [files],
  );
  const registryByFile = new Map(registry.map((row) => [row.olms_file_number, row.id]));
  return organizations
    .map((o) => ({ ...o, union_org_id: Number.isInteger(o.olms_file_number) ? registryByFile.get(o.olms_file_number) ?? null : null }));
}

/**
 * A research release carries the seven content tables of its pinned base
 * unchanged, and its retirement check compares keys only. It may therefore
 * load only over its base or over a research release on that base: over any
 * other release it would undo that release's content changes. Returns the
 * markers the load records: the base artifact (which later research loads
 * read) and the active release's id (which activation rechecks).
 */
async function researchLoadBase(client, manifest) {
  const baseSha256 = manifest.research.base?.artifactSha256;
  const { rows: active } = await client.query(
    "select id, label, artifact_sha256, research_base_sha256 from private.catalog_releases where status = 'active'",
  );
  const [current] = active;
  if (active.length !== 1 || !baseSha256 || (current.artifact_sha256 !== baseSha256 && current.research_base_sha256 !== baseSha256)) {
    const live = current ? `the active release ${current.label}` : "no active release";
    throw new Error(`research release ${manifest.label} is built on base ${manifest.research.base?.label ?? "(none)"}, but ${live} is neither that base nor a research release on it; translate it again against the active base`);
  }
  return { baseSha256, loadedOver: current.id };
}

async function countOrganizations(client) {
  const { rows: [row] } = await client.query("select count(*)::integer as organizations from public.organizations");
  return row.organizations;
}

/**
 * Stages one release: the release row plus every content row in
 * private.catalog_staging. Touches no live catalog table. Never begins or
 * commits: the caller owns the transaction.
 */
export async function loadRelease({ client, release, manifest, allowRetire = null, exclusions = null }) {
  // planRelease also runs releaseRecordViolations, the private.catalog_releases CHECKs.
  planRelease({ manifest, release });
  assertReleaseColumns(release);
  const exclusionMatches = exclusionMatchCount(release, new ExclusionMatcher(exclusions ?? loadExclusionList()));
  if (exclusionMatches > 0) throw new Error(`${exclusionMatches} release value(s) match the exclusion list; the release cannot be loaded`);

  const research = manifest.research ? await researchLoadBase(client, manifest) : null;
  const organizationsBefore = await countOrganizations(client);
  // public.get_union_catalog_status returns counts to anon: the research_*
  // rollups describe the unpublished research corpus and stay off it.
  const publicCounts = Object.fromEntries(Object.entries(manifest.counts).filter(([key]) => !key.startsWith("research_")));
  const staged = await stageReleaseRow(client, manifest, { ...publicCounts, organizationsBefore, allowRetire }, research);

  const organizations = await withRegistryLinks(client, release.organizations);
  const tables = releaseTablesOf(release);
  const rows = { ...Object.fromEntries(tables.map((t) => [t, release[t]])), organizations };

  // Early refusal; private.catalog_activate_release applies the same guard
  // (with the same ceiling, recorded in counts.allowRetire) when rows retire.
  const preview = {};
  for (const table of ["organizations", "subunits"]) {
    const { rows: [counted] } = await client.query(retirePreviewSql(table), keyArrays(table, rows[table]));
    preview[table] = counted;
  }
  const withdrawal = withdrawalDecision(preview, allowRetire);
  if (withdrawal.refusal) throw new Error(withdrawal.refusal);
  let retirement = null;
  if (manifest.research) {
    retirement = await liveUnintendedRetirement(client, rows, manifest);
    assertNoUnintendedRetirement(retirement, "the live catalog");
  }

  const stagedRows = {};
  for (const table of tables) {
    stagedRows[table] = 0;
    for (let i = 0; i < rows[table].length; i += BATCH_SIZE) {
      const batch = rows[table].slice(i, i + BATCH_SIZE);
      const result = await client.query(stagingSql(batch.length), stagingValues(table, batch, staged.id));
      stagedRows[table] += result.rowCount;
    }
  }
  const organizationsAfter = await countOrganizations(client);
  if (organizationsAfter !== organizationsBefore) {
    throw new Error(`public.organizations holds ${organizationsAfter} rows after the load and held ${organizationsBefore} before it`);
  }
  await client.query(
    "update private.catalog_releases set counts = counts || pg_catalog.jsonb_build_object('organizationsAfter', $2::integer) where id = $1",
    [staged.id, organizationsAfter],
  );
  await client.query(`analyze ${STAGING_TABLE}`);
  return {
    releaseId: staged.id,
    label: manifest.label,
    restaged: staged.restaged,
    organizationsBefore,
    organizationsAfter,
    registryLinked: organizations.filter((o) => o.union_org_id !== null).length,
    rows: Object.fromEntries(tables.map((t) => [t, rows[t].length])),
    staged: stagedRows,
    withdrawal,
    retirement,
  };
}

/**
 * Checks the staged rows of one release against its artifact. Never reads
 * the live content tables and never begins or commits. Returns
 * { problems, notes, ... }; an empty problems list is a PASS, which stamps
 * verified_at and the staged-row digest on a staged, retired or failed
 * release (a failed release that passes is staged again); a FAIL clears both
 * on the release it checked, whatever its status, and marks a staged release
 * `failed`.
 */
export async function verifyRelease({ client, release, manifest, exclusions = null, blockedDomains = null }) {
  const problems = [];
  const notes = [];
  const matcher = new ExclusionMatcher(exclusions ?? loadExclusionList());
  const label = manifest.label;

  const { rows: releases } = await client.query(
    "select id, label, status, artifact_sha256, counts from private.catalog_releases order by label",
  );
  const own = releases.find((r) => r.label === label) ?? null;
  const active = releases.filter((r) => r.status === "active");
  if (!own) problems.push(`release ${label} is not loaded`);
  else if (own.artifact_sha256 !== manifest.artifact.sha256) problems.push(`release ${label} was loaded from a different artifact`);
  if (active.length > 1) problems.push(`${active.length} releases are active; exactly one may be`);
  else if (own?.status === "active") notes.push(`release ${label} is the active release`);
  else if (active.length === 1) notes.push(`release ${active[0].label} is active; ${label} is ${own?.status ?? "absent"}`);
  else notes.push(`no release is active yet; ${label} is ${own?.status ?? "absent"}`);

  const staged = { schema: RELEASE_SCHEMA };
  const storedHash = {};
  for (const table of RELEASE_TABLES) {
    staged[table] = [];
    storedHash[table] = new Map();
  }
  const releaseTables = releaseTablesOf(release);
  if (own) {
    const { rows } = await client.query(
      `select table_name, row_key, content, content_sha256 from ${STAGING_TABLE} where release_id = $1 order by table_name, row_key`,
      [own.id],
    );
    for (const row of rows) {
      staged[row.table_name].push(row.content);
      storedHash[row.table_name].set(row.row_key, row.content_sha256);
    }
  }

  // The registry link each staged organization must carry, as
  // public.union_orgs stands now (S-4): verify never trusts a staged value.
  const linked = await withRegistryLinks(client, release.organizations);
  const expectedRows = { ...Object.fromEntries(RELEASE_TABLES.map((t) => [t, release[t] ?? []])), organizations: linked };
  const linkByKey = new Map(linked.map((o) => [o.catalog_key, o.union_org_id]));
  const registryMismatch = staged.organizations
    .filter((row) => linkByKey.has(row.catalog_key) && (row.union_org_id ?? null) !== linkByKey.get(row.catalog_key))
    .map((row) => row.catalog_key);
  if (registryMismatch.length > 0) {
    problems.push(`organizations: ${registryMismatch.length} staged union_org_id value(s) disagree with public.union_orgs for their file number (first: ${registryMismatch.slice(0, 3).join(", ")})`);
  }

  for (const table of RELEASE_TABLES) {
    const expected = new Map(expectedRows[table].map((row) => [rowKeyOf(table, row), row]));
    const stagedKeys = new Set(staged[table].map((row) => rowKeyOf(table, row)));
    const missing = [...expected.keys()].filter((k) => !stagedKeys.has(k));
    const extra = [...stagedKeys].filter((k) => !expected.has(k));
    if (missing.length > 0) problems.push(`${table}: ${missing.length} release row(s) are not staged (first: ${missing.slice(0, 3).join(", ")})`);
    if (extra.length > 0) problems.push(`${table}: ${extra.length} staged row(s) are not in the release (first: ${extra.slice(0, 3).join(", ")})`);
    const differing = [];
    for (const row of staged[table]) {
      const key = rowKeyOf(table, row);
      const source = expected.get(key);
      if (!source) continue;
      const hash = contentSha256(table, source);
      if (contentSha256(table, row) !== hash || storedHash[table].get(key) !== hash) differing.push(key);
    }
    if (differing.length > 0) problems.push(`${table}: ${differing.length} staged row(s) differ from the release (first: ${differing.slice(0, 3).join(", ")})`);
  }

  // A research table the release does not carry counts only if rows were
  // staged for it anyway, so such rows also fail the counts comparison.
  for (const table of OPTIONAL_TABLES) {
    if (!releaseTables.includes(table) && staged[table].length === 0) delete staged[table];
  }
  if (stableStringify(releaseCounts(staged)) !== stableStringify(manifest.counts)) {
    problems.push("staged counts and nested cardinality disagree with the manifest counts");
  }
  try {
    assertReleasePrivacy(staged, { blocked: blockedDomainList(blockedDomains ?? readConfig("catalog-blocked-email-domains.json")) });
  } catch (error) {
    problems.push(`privacy sweep: ${error.message}`);
  }
  const exclusionMatches = exclusionMatchCount(staged, matcher);
  if (exclusionMatches > 0) problems.push(`privacy sweep: ${exclusionMatches} staged value(s) match the exclusion list`);

  const before = own?.counts?.organizationsBefore;
  const after = own?.counts?.organizationsAfter;
  if (!Number.isInteger(before) || !Number.isInteger(after)) problems.push(`release ${label} carries no public.organizations count around its load`);
  else if (before !== after) problems.push(`public.organizations held ${before} rows before the load and ${after} after it`);

  let verifiedAt = null;
  let status = own?.status ?? null;
  if (own && problems.length === 0) {
    // The stamp is the time and the digest of exactly the rows just
    // compared; activation recomputes the digest and refuses on a change.
    const { rows: [stamped] } = await client.query(
      `update private.catalog_releases
          set verified_at = pg_catalog.now(),
              verified_sha256 = (${STAGING_DIGEST_SQL}),
              status = case when status = 'failed' then 'staged' else status end
        where id = $1 and status in ('staged', 'retired', 'failed')
        returning verified_at, status`,
      [own.id],
    );
    if (stamped) {
      verifiedAt = stamped.verified_at;
      status = stamped.status;
      if (own.status === "failed") notes.push(`release ${label} was marked failed and now passes; it is staged again and verified`);
    }
  } else if (own) {
    // A FAIL withdraws any earlier stamp, whatever the status, so neither a
    // staged nor a retired release (a rollback target) can be activated on a
    // verify that no longer holds.
    const { rows: [cleared] } = await client.query(
      `update private.catalog_releases
          set verified_at = null,
              verified_sha256 = null,
              status = case when status = 'staged' then 'failed' else status end
        where id = $1
        returning status`,
      [own.id],
    );
    status = cleared.status;
    if (own.status === "staged") notes.push(`release ${label} is marked failed; load it again after fixing the artifact, or verify it again once the check that failed passes`);
    else if (own.status === "retired") notes.push(`release ${label} stays retired and is no longer verified; it cannot be activated until a verify passes`);
    else if (own.status === "failed") notes.push(`release ${label} stays failed`);
    else if (own.status === "active") notes.push(`release ${label} is active but fails the current checks; activate a release that passes, or load a fixed artifact under a new label`);
  }

  return {
    label,
    previousStatus: own?.status ?? null,
    status,
    activeLabel: active.length === 1 ? active[0].label : null,
    rows: Object.fromEntries(releaseTablesOf(staged).map((t) => [t, staged[t].length])),
    exclusionMatches,
    verifiedAt,
    problems,
    notes,
  };
}

// The messages private.catalog_activate_release raises itself carry a label
// check, counts and table names only, so they are printed as raised.
const OWN_ACTIVATION_MESSAGE = /^(?:invalid catalog release label$|catalog release (?:is not staged|is not verified|has no staged rows|staged rows changed after)|catalog research release was loaded over a release that is no longer active;|withdrawal guard: [0-9]|catalog activation left )/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when a database error from the activation is one the function raised itself. */
export function isOwnActivationError(error) {
  return (error?.code === "22023" || error?.code === "P0001") && OWN_ACTIVATION_MESSAGE.test(error.message ?? "");
}

/**
 * Any other database error from the activation (a cast or CHECK failure
 * while a staged row is applied) can quote a staged value in its message or
 * detail. It is rewritten to the SQLSTATE, the constraint, table and column
 * names and the staged row key; the original message, detail and cause are
 * dropped.
 */
export function sanitizedActivationError(error, rowRef = null) {
  const parts = [`SQLSTATE ${error.code}`];
  if (error.constraint) parts.push(`constraint ${error.constraint}`);
  if (error.table) parts.push(`table ${error.schema ? `${error.schema}.` : ""}${error.table}`);
  if (error.column) parts.push(`column ${error.column}`);
  parts.push(rowRef ? `staged row ${rowRef}` : "staged row not located");
  const safe = new Error(`activation refused by the database (${parts.join(", ")}); nothing was applied. Load and verify the release again.`);
  safe.code = error.code;
  return safe;
}

/**
 * The DO block that finds the first staged row of a release that does not fit
 * its live table: each row is inserted, in its own subtransaction, into a
 * temporary copy of the table with the same columns, defaults and CHECKs,
 * and the first failure's table and row key are left in a transaction-local
 * setting. The caller rolls the whole block back.
 */
export function unfitRowDiagnosisSql(releaseId) {
  if (!UUID_PATTERN.test(releaseId ?? "")) throw new Error("the diagnosis needs a release id");
  const creates = RELEASE_TABLES.map((t) =>
    `  create temporary table catalog_probe_${t} (like private.catalog_${t} including defaults including constraints);`);
  const branches = RELEASE_TABLES.map((t, i) =>
    `      ${i === 0 ? "if" : "elsif"} r.table_name = '${t}' then
`
    + `        insert into pg_temp.catalog_probe_${t} select * from pg_catalog.jsonb_populate_record(null::private.catalog_${t}, r.content);`);
  return [
    "do $diagnosis$",
    "declare",
    "  r record;",
    "begin",
    ...creates,
    "  for r in",
    "    select s.table_name, s.row_key,",
    // Diagnose the same materialized row that activation applies. A legacy
    // row otherwise fails on missing locale_unknowns before its real error.
    `           (case when s.table_name in (${LOCALE_TABLES.map((t) => `'${t}'`).join(", ")}) then '${JSON.stringify(legacyLocale())}'::jsonb else '{}'::jsonb end)`,
    "           || s.content || pg_catalog.jsonb_build_object('first_release_id', s.release_id, 'last_release_id', s.release_id,",
    "             'retired_release_id', null, 'content_sha256', s.content_sha256) as content",
    `      from ${STAGING_TABLE} as s`,
    `     where s.release_id = '${releaseId}'`,
    "     order by s.table_name, s.row_key",
    "  loop",
    "    begin",
    ...branches,
    "      end if;",
    "    exception when others then",
    "      perform pg_catalog.set_config('catalog_diagnosis.unfit_row', r.table_name || ' ' || r.row_key, true);",
    "      exit;",
    "    end;",
    "  end loop;",
    "end",
    "$diagnosis$",
  ].join("\n");
}

async function locateUnfitStagedRow(client, label) {
  await client.query("savepoint catalog_activation_diagnosis");
  let rowRef = null;
  try {
    const { rows: [release] } = await client.query("select id from private.catalog_releases where label = $1", [label]);
    if (release) {
      await client.query(unfitRowDiagnosisSql(release.id));
      const { rows: [found] } = await client.query("select pg_catalog.current_setting('catalog_diagnosis.unfit_row', true) as row_ref");
      rowRef = found?.row_ref || null;
    }
  } catch {
    rowRef = null;
  }
  await client.query("rollback to savepoint catalog_activation_diagnosis");
  await client.query("release savepoint catalog_activation_diagnosis");
  return rowRef;
}

/**
 * One call to private.catalog_activate_release, bracketed by a
 * public.organizations count that must not move (the caller's transaction is
 * repeatable read, so only the activation itself could move it). Never begins
 * or commits; the call runs inside a savepoint so a database error can be
 * diagnosed and rewritten without a staged value (sanitizedActivationError).
 */
export async function activateRelease({ client, label, allowRetire = null }) {
  if (!RELEASE_LABEL_PATTERN.test(label ?? "")) throw new Error("activate needs a YYYYMMDD-NN release label");
  if (allowRetire !== null) {
    const ceiling = await client.query(
      "update private.catalog_releases set counts = counts || pg_catalog.jsonb_build_object('allowRetire', $2::integer) where label = $1",
      [label, allowRetire],
    );
    if (ceiling.rowCount !== 1) throw new Error(`release ${label} is not loaded`);
  }
  const tenantOrganizationsBefore = await countOrganizations(client);
  let row;
  await client.query("savepoint catalog_activation");
  try {
    ({ rows: [row] } = await client.query("select private.catalog_activate_release($1) as diff", [label]));
  } catch (error) {
    await client.query("rollback to savepoint catalog_activation");
    await client.query("release savepoint catalog_activation");
    if (!error?.code || isOwnActivationError(error)) throw error;
    throw sanitizedActivationError(error, await locateUnfitStagedRow(client, label));
  }
  await client.query("release savepoint catalog_activation");
  const tenantOrganizationsAfter = await countOrganizations(client);
  if (tenantOrganizationsAfter !== tenantOrganizationsBefore) {
    throw new Error(`public.organizations holds ${tenantOrganizationsAfter} rows after the activation and held ${tenantOrganizationsBefore} before it`);
  }
  const diff = { ...row.diff, tenantOrganizationsBefore, tenantOrganizationsAfter };
  await client.query(
    "update private.catalog_releases set activation_diff = $2::jsonb where label = $1",
    [label, JSON.stringify(diff)],
  );
  return diff;
}

export function formatLoad(summary) {
  const lines = [
    `release          ${summary.label}${summary.restaged ? ` (was ${summary.restaged}; staged again)` : ""}`,
    `organizations in public.organizations before and after the load: ${summary.organizationsBefore}, ${summary.organizationsAfter}`,
    `catalog organizations linked to public.union_orgs: ${summary.registryLinked}`,
    `withdrawal guard at activation: ${summary.withdrawal.describe}`,
    `${"table".padEnd(20)} ${"release".padStart(8)} ${"staged".padStart(8)}`,
  ];
  for (const table of Object.keys(summary.rows)) {
    lines.push(`${table.padEnd(20)} ${String(summary.rows[table]).padStart(8)} ${String(summary.staged[table]).padStart(8)}`);
  }
  if (summary.retirement) {
    lines.push(`research release: ${summary.retirement.total} unintended retirement(s) against the live catalog`);
  }
  lines.push("", `LOADED: release ${summary.label} is staged; readers still see the active release. Run verify, then activate.`);
  return lines;
}

export function formatVerify(report) {
  const lines = [`release          ${report.label} (${report.status ?? "not loaded"})`, "staged rows:"];
  for (const [table, n] of Object.entries(report.rows)) lines.push(`  ${table.padEnd(20)} ${n}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  if (report.problems.length > 0) {
    lines.push("", `FAIL: the staged rows disagree with release ${report.label}:`);
    for (const problem of report.problems) lines.push(`  - ${problem}`);
  } else {
    lines.push("", `PASS: the staged rows match release ${report.label} on keys, content, registry links, counts and the privacy sweep; public.organizations was unchanged by the load. ${verifiedOutcome(report)}`);
  }
  return lines;
}

function verifiedOutcome(report) {
  if (!report.verifiedAt) return "It is the active release; nothing was stamped.";
  if (report.previousStatus === "failed") return "It was marked failed and is now staged again and verified; activate it next.";
  if (report.status === "retired") return "The retired release is verified again; activate it to roll back.";
  return "The release is verified; activate it next.";
}

export function formatActivate(label, diff) {
  return [
    `ACTIVATED: release ${label}`,
    ...Object.entries(diff ?? {}).map(([key, n]) => `  ${key.padEnd(26)} ${n}`),
  ];
}

async function connect() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is required for load, verify and activate (plan needs no database)");
  const contract = JSON.parse(readFileSync(join(HERE, "db-contract.json"), "utf8"));
  assertExactTarget(contract.target, connectionString, { disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM });
  const client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    ssl: postgresSslForTarget(connectionString),
    application_name: "load-union-catalog",
  });
  await client.connect();
  return client;
}

// Repeatable read: the public.organizations counts taken before and after a
// load or an activation come from one snapshot, so only the loader's own
// writes could ever make them differ.
async function inTransaction(client, work) {
  await client.query("begin isolation level repeatable read");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** load, verify or activate, each in one transaction. Returns { lines, ok }. */
export async function runDatabaseMode(args, { connectClient = connect } = {}) {
  const current = readRelease(args.release);
  // Every plan check runs before a connection is opened; the exclusion list
  // is read right after the target guard admits the connection.
  if (args.mode === "load") planRelease(current);
  const client = await connectClient();
  try {
    const exclusions = args.mode === "activate" ? null : loadExclusionList();
    if (args.mode === "load") {
      const summary = await inTransaction(client, () => loadRelease({ client, ...current, allowRetire: args.allowRetire, exclusions }));
      return { ok: true, lines: formatLoad(summary) };
    }
    if (args.mode === "verify") {
      const report = await inTransaction(client, () => verifyRelease({ client, ...current, exclusions }));
      return { ok: report.problems.length === 0, lines: formatVerify(report) };
    }
    const diff = await inTransaction(client, () => activateRelease({ client, label: current.manifest.label, allowRetire: args.allowRetire }));
    return { ok: true, lines: formatActivate(current.manifest.label, diff) };
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv);
    if (args.mode === "plan") {
      for (const line of runPlan(args)) console.log(line);
    } else {
      const { ok, lines } = await runDatabaseMode(args);
      for (const line of lines) (ok ? console.log : console.error)(line);
      if (!ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
